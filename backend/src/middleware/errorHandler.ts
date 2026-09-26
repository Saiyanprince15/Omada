import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: object
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Zod validation errors
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
        details: err.flatten().fieldErrors,
      },
    });
    return;
  }

  // Application errors (known, structured)
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }

  // Prisma errors
  if (err.constructor.name === 'PrismaClientKnownRequestError') {
    const prismaErr = err as unknown as { code: string; meta?: unknown };
    if (prismaErr.code === 'P2002') {
      res.status(409).json({
        error: { code: 'CONFLICT', message: 'A record with these values already exists.' },
      });
      return;
    }
    if (prismaErr.code === 'P2025') {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'The requested record was not found.' },
      });
      return;
    }
    if (prismaErr.code === 'P2034') {
      res.status(409).json({
        error: { code: 'TRANSACTION_CONFLICT', message: 'The operation conflicted with another request. Please retry.' },
      });
      return;
    }
  }

  // Unexpected errors
  console.error('[error]', err);
  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred.',
    },
  });
}
