import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import { prisma } from './prisma';

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'dev-access-secret';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'dev-refresh-secret';
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

  // Find token in DB by family
  const storedTokens = await prisma.refreshToken.findMany({
    where: { userId: payload.sub, family: payload.family },
    orderBy: { createdAt: 'desc' },
  });

  if (!storedTokens.length) {
    throw new Error('INVALID_REFRESH_TOKEN');
  }

  // Check if any token in the family was already used (reuse attack)
  const alreadyUsed = storedTokens.some((t) => t.used);
  if (alreadyUsed) {
    // Invalidate entire family
    await prisma.refreshToken.updateMany({
      where: { userId: payload.sub, family: payload.family },
      data: { used: true },
    });
    throw new Error('TOKEN_REUSE_DETECTED');
  }

  const currentToken = storedTokens[0];

  if (new Date() > currentToken.expiresAt) {
    throw new Error('REFRESH_TOKEN_EXPIRED');
  }

  // Mark current token as used
  await prisma.refreshToken.update({
    where: { id: currentToken.id },
    data: { used: true },
  });

  // Fetch user for access token payload
  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user || user.deletedAt) throw new Error('USER_NOT_FOUND');

  const accessToken = signAccessToken({
    sub: user.id,
    email: user.email,
    isAdmin: user.isAdmin,
  });

  const newRefreshToken = await createRefreshToken(user.id, payload.family);

  return { accessToken, refreshToken: newRefreshToken, userId: user.id };
}

export async function revokeAllUserTokens(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId },
    data: { used: true },
  });
}
