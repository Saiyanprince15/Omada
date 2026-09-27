import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { rateLimit } from 'express-rate-limit';

import authRouter from './routes/auth';
import usersRouter from './routes/users';
import eventsRouter from './routes/events';
import teamsRouter from './routes/teams';
import requestsRouter from './routes/requests';
import matchmakingRouter from './routes/matchmaking';
import provisionalRouter from './routes/provisional';
import chatRouter from './routes/chat';
import notificationsRouter from './routes/notifications';
import { prisma } from './lib/prisma';
import { getRedis } from './lib/redis';
import adminRouter from './routes/admin';
import organizerRouter from './routes/organizer';

import { errorHandler } from './middleware/errorHandler';
import { notFound } from './middleware/notFound';

const app = express();

// ─── Security headers ──────────────────────────────────────────────────────
app.use(helmet());

// ─── CORS ─────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// ─── Body parsing ─────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Logging ─────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// ─── Global rate limit ────────────────────────────────────────────────────
app.use(
  rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000'),
    max: parseInt(process.env.RATE_LIMIT_MAX ?? '120'),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' } },
  })
);

// ─── Health check ─────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/ready', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    await getRedis().ping();
    res.json({ status: 'ready' });
  } catch (err) {
    console.error('[readiness]', err);
    res.status(503).json({ status: 'not_ready' });
  }
});

// ─── API routes ───────────────────────────────────────────────────────────
app.use('/v1/auth', authRouter);
app.use('/v1/users', usersRouter);
app.use('/v1/events', eventsRouter);
app.use('/v1/events', teamsRouter);
app.use('/v1/events', requestsRouter);
app.use('/v1/events', matchmakingRouter);
app.use('/v1/events', provisionalRouter);
app.use('/v1/chat', chatRouter);
app.use('/v1/notifications', notificationsRouter);
app.use('/v1/admin', adminRouter);
app.use('/v1/organizer', organizerRouter);

// ─── Error handling ───────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

export default app;
