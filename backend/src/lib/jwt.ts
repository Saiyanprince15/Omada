import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import { prisma } from './prisma';

// ─── Secret validation ────────────────────────────────────────────────────
// In non-test environments, JWT secrets MUST be provided via environment
// variables. Falling back to hard-coded secrets is a critical vulnerability.

function getSecret(envVar: string, name: string): string {
  const value = process.env[envVar];
  if (value) return value;

  if (process.env.NODE_ENV === 'test') {
    return `test-${name}-secret-for-automated-testing-only`;
  }

  throw new Error(
    `[FATAL] ${envVar} is not set. ` +
    `JWT secrets must be configured in non-test environments. ` +
    `Set ${envVar} in your .env file.`
  );
}

const ACCESS_SECRET = getSecret('JWT_ACCESS_SECRET', 'access');
const REFRESH_SECRET = getSecret('JWT_REFRESH_SECRET', 'refresh');
const ACCESS_EXPIRES = process.env.JWT_ACCESS_EXPIRES_IN ?? '15m';
const REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN ?? '7d';
// Parse human-readable expiry string to milliseconds
const REFRESH_EXPIRES_MS = parseExpiryToMs(REFRESH_EXPIRES_IN);

function parseExpiryToMs(expiry: string): number {
  const match = expiry.match(/^(\d+)([smhd])$/);
  if (!match) return 7 * 24 * 60 * 60 * 1000; // default 7d
  const value = parseInt(match[1]!);
  const unit = match[2]!;
  const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return value * (multipliers[unit] ?? 86_400_000);
}

export interface AccessTokenPayload {
  sub: string;       // user ID
  email: string;
  isAdmin: boolean;
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;       // unique token ID — bound to exact DB record
  family: string;    // token family for rotation detection
}

// ─── Token generation ─────────────────────────────────────────────────────

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_EXPIRES } as jwt.SignOptions);
}

export function signRefreshToken(payload: Omit<RefreshTokenPayload, 'jti'>): {
  token: string;
  jti: string;
} {
  const jti = uuidv4();
  const token = jwt.sign({ ...payload, jti }, REFRESH_SECRET, {
    expiresIn: REFRESH_EXPIRES_IN,
  } as jwt.SignOptions);
  return { token, jti };
}

// ─── Token verification ───────────────────────────────────────────────────

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, ACCESS_SECRET) as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, REFRESH_SECRET) as RefreshTokenPayload;
}

// ─── Refresh token management ─────────────────────────────────────────────

export async function createRefreshToken(userId: string, family: string): Promise<string> {
  const { token, jti } = signRefreshToken({ sub: userId, family });

  // Store hash of jti (not the full token) for security
  const hash = await bcrypt.hash(jti, 10);
  const expiresAt = new Date(Date.now() + REFRESH_EXPIRES_MS);

  await prisma.refreshToken.create({
    data: { userId, tokenHash: hash, family, expiresAt },
  });

  return token;
}

/**
 * Validate a refresh token, detect reuse (rotation attack), and issue new tokens.
 *
 * Security model:
 * - Each presented token carries a `jti` in its payload.
 * - The DB stores a bcrypt hash of the jti, so the DB record is bound to the exact token.
 * - We look up ALL tokens in the family, find the one whose hash matches the presented jti.
 * - If the matching record is already used → reuse attack → invalidate entire family.
 * - If no matching record → token not in DB → invalid.
 * - Concurrent rotation handled atomically via conditional update (used: false → true).
 */
export async function rotateRefreshToken(
  token: string
): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
  let payload: RefreshTokenPayload;

  try {
    payload = verifyRefreshToken(token);
  } catch {
    throw new Error('INVALID_REFRESH_TOKEN');
  }

  return await prisma.$transaction(async (tx) => {
    // Load all tokens in this family
    const familyTokens = await tx.refreshToken.findMany({
      where: { userId: payload.sub, family: payload.family },
      orderBy: { createdAt: 'desc' },
    });

    if (!familyTokens.length) {
      throw new Error('INVALID_REFRESH_TOKEN');
    }

    // Find the DB record matching this exact token (by comparing jti hash)
    let matchedToken: typeof familyTokens[0] | null = null;
    for (const dbToken of familyTokens) {
      try {
        const matches = await bcrypt.compare(payload.jti, dbToken.tokenHash);
        if (matches) {
          matchedToken = dbToken;
          break;
        }
      } catch {
        // bcrypt errors on invalid hashes — skip
      }
    }

    if (!matchedToken) {
      // Token not in DB — it could be a forged token or a token from a previous family iteration
      // Invalidate the entire family as a precaution
      await tx.refreshToken.updateMany({
        where: { userId: payload.sub, family: payload.family },
        data: { used: true },
      });
      throw new Error('INVALID_REFRESH_TOKEN');
    }

    // If the matched token was already used → reuse attack
    if (matchedToken.used) {
      await tx.refreshToken.updateMany({
        where: { userId: payload.sub, family: payload.family },
        data: { used: true },
      });
      throw new Error('TOKEN_REUSE_DETECTED');
    }

    // Check expiry
    if (new Date() > matchedToken.expiresAt) {
      throw new Error('REFRESH_TOKEN_EXPIRED');
    }

    // Atomic conditional update: only mark as used if it's still unused
    // This handles concurrent requests from the same token
    const updated = await tx.refreshToken.updateMany({
      where: { id: matchedToken.id, used: false },
      data: { used: true },
    });

    if (updated.count === 0) {
      // Another concurrent request consumed this token first — treat as reuse
      await tx.refreshToken.updateMany({
        where: { userId: payload.sub, family: payload.family },
        data: { used: true },
      });
      throw new Error('TOKEN_REUSE_DETECTED');
    }

    // Fetch user
    const user = await tx.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.deletedAt) throw new Error('USER_NOT_FOUND');

    const accessToken = signAccessToken({
      sub: user.id,
      email: user.email,
      isAdmin: user.isAdmin,
    });

    const newRefreshToken = await createRefreshTokenInTx(tx, user.id, payload.family);

    return { accessToken, refreshToken: newRefreshToken, userId: user.id };
  });
}

/**
 * Create a refresh token within an existing transaction context.
 */
async function createRefreshTokenInTx(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  userId: string,
  family: string
): Promise<string> {
  const { token, jti } = signRefreshToken({ sub: userId, family });
  const hash = await bcrypt.hash(jti, 10);
  const expiresAt = new Date(Date.now() + REFRESH_EXPIRES_MS);

  await tx.refreshToken.create({
    data: { userId, tokenHash: hash, family, expiresAt },
  });

  return token;
}

export async function revokeAllUserTokens(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId },
    data: { used: true },
  });
}
