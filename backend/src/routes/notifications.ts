import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';

const router = Router();

// ─── GET /v1/notifications ────────────────────────────────────────────────
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { unread_only, limit = '20', cursor } = req.query as Record<string, string>;
    const userId = req.user!.sub;
    const take = Math.min(parseInt(limit), 50);

    const notifications = await prisma.notification.findMany({
      where: {
        userId,
        ...(unread_only === 'true' ? { isRead: false } : {}),
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      take: take + 1,
      orderBy: { createdAt: 'desc' },
    });

    const hasMore = notifications.length > take;
    const data = hasMore ? notifications.slice(0, take) : notifications;

    res.json({
      data,
      pagination: { next_cursor: hasMore ? data[data.length - 1]?.id : null, has_more: hasMore },
    });
  } catch (err) {
    next(err);
  }
});

// ─── PUT /v1/notifications/:id/read ───────────────────────────────────────
router.put('/:id/read', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await prisma.notification.updateMany({
      where: { id: req.params.id, userId: req.user!.sub },
      data: { isRead: true },
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ─── PUT /v1/notifications/read-all ───────────────────────────────────────
router.put('/read-all', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user!.sub, isRead: false },
      data: { isRead: true },
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
