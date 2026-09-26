import { Request, Response, NextFunction } from 'express';
import { checkRateLimit } from '../lib/redis';
import { AppError } from './errorHandler';

/**
 * Creates a Redis-backed rate limiter middleware.
 * Key is scoped to the authenticated user ID or IP address.
 */
export function redisRateLimit(action: string, limit: number, windowMs: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const identifier = req.user?.sub ?? req.ip ?? 'anonymous';
    const key = `${action}:${identifier}`;

    try {
      const result = await checkRateLimit(key, limit, windowMs);

      res.setHeader('X-RateLimit-Limit', limit);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Reset', Math.floor(result.resetAt.getTime() / 1000));

      if (!result.allowed) {
        res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
        throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Please slow down.');
      }

      next();
    } catch (err) {
      if (err instanceof AppError) {
        next(err);
      } else {
        // If Redis is unavailable, degrade gracefully (allow the request)
        console.error('[rate-limit] Redis error, bypassing rate limit:', err);
        next();
      }
    }
  };
}
