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
const REFRESH_EXPIRES = process.env.JWT_REFRESH_EXPIRES_IN ?? '7d';

export interface AccessTokenPayload {
  sub: string;       // user ID
  email: string;
  isAdmin: boolean;
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;       // unique token ID
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
    expiresIn: REFRESH_EXPIRES,
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

  const hash = await bcrypt.hash(jti, 10);

  // Refresh token expires in 7 days
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await prisma.refreshToken.create({
    data: { userId, tokenHash: hash, family, expiresAt },
  });

  return token;
}

/**
 * Validate a refresh token, detect reuse (rotation attack), and issue new tokens.
 * Returns new access + refresh tokens on success.
 * Throws on invalid, reuse, or expired token.
 *
 * Uses atomic conditional update to prevent race conditions:
 * only the first request to mark the token as used will succeed.
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

  // Atomic rotation using a transaction with conditional update
  return await prisma.$transaction(async (tx) => {
    // Find all tokens in this family
    const storedTokens = await tx.refreshToken.findMany({
      where: { userId: payload.sub, family: payload.family },
      orderBy: { createdAt: 'desc' },
    });

    if (!storedTokens.length) {
      throw new Error('INVALID_REFRESH_TOKEN');
    }

    // Check if ANY token in the family was already used (reuse attack)
    const alreadyUsed = storedTokens.some((t) => t.used);
    if (alreadyUsed) {
      // Invalidate entire family — this is a reuse attack
      await tx.refreshToken.updateMany({
        where: { userId: payload.sub, family: payload.family },
        data: { used: true },
      });
      throw new Error('TOKEN_REUSE_DETECTED');
    }

    const currentToken = storedTokens[0]!;

    if (new Date() > currentToken.expiresAt) {
      throw new Error('REFRESH_TOKEN_EXPIRED');
    }

    // Atomic conditional update: only mark as used if it's NOT already used
    // This prevents the race condition where two concurrent requests both succeed
    const updated = await tx.refreshToken.updateMany({
      where: { id: currentToken.id, used: false },
      data: { used: true },
    });

    // If no rows were updated, another request already consumed this token
    if (updated.count === 0) {
      // Token was already used by a concurrent request — treat as reuse
      await tx.refreshToken.updateMany({
        where: { userId: payload.sub, family: payload.family },
        data: { used: true },
      });
      throw new Error('TOKEN_REUSE_DETECTED');
    }

    // Fetch user for access token payload
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
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

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
