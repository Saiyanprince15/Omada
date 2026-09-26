import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { validate, sendMessageSchema } from '../lib/validation';
import { AppError } from '../middleware/errorHandler';
import { redisRateLimit } from '../middleware/rateLimiter';

const router = Router();

async function verifyRoomAccess(roomId: string, userId: string): Promise<void> {
  const room = await prisma.chatRoom.findUnique({
    where: { id: roomId },
    include: {
      teamRooms: { include: { members: { where: { leftAt: null, userId } } } },
      provisionalRoom: { include: { members: { where: { userId, status: { in: ['pending', 'accepted'] } } } } },
    },
  });

  if (!room) throw new AppError(404, 'NOT_FOUND', 'Chat room not found.');
  if (room.status === 'deleted') throw new AppError(404, 'NOT_FOUND', 'Chat room not found.');

  const hasAccess =
    room.teamRooms.some((t) => t.members.length > 0) ||
    (room.provisionalRoom && room.provisionalRoom.members.length > 0);

  if (!hasAccess) throw new AppError(403, 'FORBIDDEN', 'You do not have access to this chat room.');
}

// ─── GET /v1/chat/rooms/:room_id/messages ─────────────────────────────────
router.get('/rooms/:room_id/messages', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { room_id } = req.params;
    const { limit = '50', before } = req.query as Record<string, string>;
    const userId = req.user!.sub;

    await verifyRoomAccess(room_id, userId);

    const take = Math.min(parseInt(limit), 100);

    const messages = await prisma.chatMessage.findMany({
      where: {
        roomId: room_id,
        isDeleted: false,
        ...(before ? { id: { lt: before } } : {}),
      },
      include: {
        sender: { select: { id: true, displayName: true, avatarUrl: true } },
      },
      take,
      orderBy: { createdAt: 'desc' },
    });

    res.json({ data: messages.reverse(), has_more: messages.length === take });
  } catch (err) {
    next(err);
  }
});

// ─── POST /v1/chat/rooms/:room_id/messages ────────────────────────────────
router.post(
  '/rooms/:room_id/messages',
  authenticate,
  redisRateLimit('chat_message', 60, 60_000),
  validate({ body: sendMessageSchema.shape.body }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { room_id } = req.params;
      const userId = req.user!.sub;

      await verifyRoomAccess(room_id, userId);

      const room = await prisma.chatRoom.findUnique({ where: { id: room_id } });
      if (room?.status === 'archived') throw new AppError(403, 'ROOM_ARCHIVED', 'This chat room is archived and read-only.');

      const message = await prisma.chatMessage.create({
        data: {
          roomId: room_id,
          senderId: userId,
          content: req.body.content,
          messageType: 'text',
        },
        include: {
          sender: { select: { id: true, displayName: true, avatarUrl: true } },
        },
      });

      // Socket.IO handles fan-out to room members (see socket.ts)
      res.status(201).json({ message });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
