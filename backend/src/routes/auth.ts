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

const authRateLimit = rateLimit({
  windowMs: 60_000,
  max: 5,
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
        data: { email, passwordHash, displayName: display_name },
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

      // Constant-time comparison to prevent timing attacks
      const dummyHash = '$2a$12$invalidhashfortimingnormalization';
      const passwordMatch = user
        ? await bcrypt.compare(password, user.passwordHash)
        : await bcrypt.compare(password, dummyHash);

      if (!user || !passwordMatch || user.deletedAt) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
      }

      await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

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
