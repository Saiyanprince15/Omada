import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { rateLimit } from 'express-rate-limit';
import { prisma } from '../lib/prisma';
import { signAccessToken, createRefreshToken, rotateRefreshToken, revokeAllUserTokens } from '../lib/jwt';
import { validate, registerSchema, loginSchema, refreshSchema } from '../lib/validation';
import { AppError } from '../middleware/errorHandler';
import { authenticate } from '../middleware/auth';

const router = Router();

// Maximum failed login attempts before lockout
const MAX_FAILED_ATTEMPTS = 5;
// Lockout duration: 15 minutes
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

const authRateLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many auth attempts. Try again in a minute.' } },
});

// POST /v1/auth/register
router.post(
  '/register',
  authRateLimit,
  validate({ body: registerSchema.shape.body }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password, display_name } = req.body;

      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists.');
      }

      const passwordHash = await bcrypt.hash(password, 12);

      const user = await prisma.user.create({
        data: { email, passwordHash, displayName: display_name, isVerified: true },
      });

      const family = uuidv4();
      const accessToken = signAccessToken({ sub: user.id, email: user.email, isAdmin: user.isAdmin });
      const refreshToken = await createRefreshToken(user.id, family);

      res.status(201).json({
        user: {
          id: user.id,
          email: user.email,
          display_name: user.displayName,
          created_at: user.createdAt,
        },
        tokens: { access_token: accessToken, refresh_token: refreshToken, expires_in: 900 },
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /v1/auth/login
router.post(
  '/login',
  authRateLimit,
  validate({ body: loginSchema.shape.body }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body;

      const user = await prisma.user.findUnique({ where: { email } });

      // Constant-time comparison to prevent timing attacks (always hash compare)
      const dummyHash = '$2a$12$invalidhashfortimingnormalizationnnnnnnnnnnnnnnnnn';
      const passwordMatch = user
        ? await bcrypt.compare(password, user.passwordHash)
        : await bcrypt.compare(password, dummyHash);

      // Account does not exist
      if (!user || user.deletedAt) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
      }

      // Check if account is locked
      if (user.lockedUntil && user.lockedUntil > new Date()) {
        const retryAfterSeconds = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
        throw new AppError(
          429,
          'ACCOUNT_LOCKED',
          `Account is temporarily locked due to too many failed login attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`
        );
      }

      if (!passwordMatch) {
        // Atomic increment avoids losing failed-attempt updates when several
        // invalid login requests arrive at the same time.
        const updated = await prisma.user.update({
          where: { id: user.id },
          data: { failedLoginAttempts: { increment: 1 } },
          select: { failedLoginAttempts: true },
        });

        if (updated.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
          await prisma.user.update({
            where: { id: user.id },
            data: { lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS) },
          });
        }

        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
      }

      // Successful login — reset lockout fields
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: 0,
          lockedUntil: null,
          lastLoginAt: new Date(),
        },
      });

      const family = uuidv4();
      const accessToken = signAccessToken({ sub: user.id, email: user.email, isAdmin: user.isAdmin });
      const refreshToken = await createRefreshToken(user.id, family);

      res.json({
        user: { id: user.id, email: user.email, display_name: user.displayName },
        tokens: { access_token: accessToken, refresh_token: refreshToken, expires_in: 900 },
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /v1/auth/refresh
router.post(
  '/refresh',
  validate({ body: refreshSchema.shape.body }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { refresh_token } = req.body;
      const { accessToken, refreshToken } = await rotateRefreshToken(refresh_token);

      res.json({
        tokens: { access_token: accessToken, refresh_token: refreshToken, expires_in: 900 },
      });
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (err.message === 'TOKEN_REUSE_DETECTED') {
          next(new AppError(401, 'TOKEN_REUSE', 'Token reuse detected. Please log in again.'));
          return;
        }
        if (err.message === 'REFRESH_TOKEN_EXPIRED') {
          next(new AppError(401, 'TOKEN_EXPIRED', 'Refresh token has expired. Please log in again.'));
          return;
        }
        if (err.message === 'INVALID_REFRESH_TOKEN' || err.message === 'USER_NOT_FOUND') {
          next(new AppError(401, 'INVALID_TOKEN', 'Invalid refresh token.'));
          return;
        }
      }
      next(new AppError(401, 'INVALID_TOKEN', 'Invalid refresh token.'));
    }
  }
);

// POST /v1/auth/logout
router.post('/logout', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await revokeAllUserTokens(req.user!.sub);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
