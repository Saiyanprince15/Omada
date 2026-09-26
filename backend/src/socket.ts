import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { verifyAccessToken } from './lib/jwt';
import { prisma } from './lib/prisma';
import { setPresence, removePresence, getRedis } from './lib/redis';

let io: Server;

interface AuthenticatedSocket extends Socket {
  userId: string;
  email: string;
}

export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    maxHttpBufferSize: 1e6, // 1MB
  });

  // ─── Authentication middleware ───────────────────────────────────────────
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;

    if (!token?.startsWith('Bearer ')) {
      return next(new Error('UNAUTHORIZED'));
    }

    try {
      const payload = verifyAccessToken(token.slice(7));
      (socket as AuthenticatedSocket).userId = payload.sub;
      (socket as AuthenticatedSocket).email = payload.email;
      next();
    } catch {
      next(new Error('INVALID_TOKEN'));
    }
  });

  // ─── Connection handling ─────────────────────────────────────────────────
  io.on('connection', async (socket) => {
    const s = socket as AuthenticatedSocket;
    const userId = s.userId;

    console.log(`[socket] User ${userId} connected (socket: ${socket.id})`);

    // Track presence
    await setPresence(userId);

    // Auto-join user's personal notification channel
    socket.join(`user:${userId}`);

    // Subscribe to this user's notification channel via Redis Pub/Sub
    const subscriber = (await getRedis().duplicate()) as ReturnType<typeof getRedis>;
    await subscriber.connect();
    await subscriber.subscribe(`notification:user:${userId}`, (message) => {
      try {
        const parsed = JSON.parse(message) as { event: string; payload: unknown };
        socket.emit(parsed.event, parsed.payload);
      } catch {
        // ignore
      }
    });

    // ─── Chat events ──────────────────────────────────────────────────────

    socket.on('chat:join_room', async (data: { room_id: string }) => {
      try {
        const canAccess = await checkRoomAccess(data.room_id, userId);
        if (!canAccess) {
          socket.emit('error', { code: 'FORBIDDEN', message: 'Cannot access this room.' });
          return;
        }
        socket.join(`room:${data.room_id}`);
        socket.emit('chat:joined', { room_id: data.room_id });
      } catch {
        socket.emit('error', { code: 'SERVER_ERROR', message: 'Failed to join room.' });
      }
    });

    socket.on('chat:send_message', async (data: { room_id: string; content: string }) => {
      try {
        if (!data.content?.trim() || data.content.length > 5000) {
          socket.emit('error', { code: 'INVALID_MESSAGE', message: 'Message too long or empty.' });
          return;
        }

        const canAccess = await checkRoomAccess(data.room_id, userId);
        if (!canAccess) {
          socket.emit('error', { code: 'FORBIDDEN', message: 'Cannot send to this room.' });
          return;
        }

        const room = await prisma.chatRoom.findUnique({ where: { id: data.room_id } });
        if (room?.status === 'archived') {
          socket.emit('error', { code: 'ROOM_ARCHIVED', message: 'Room is archived.' });
          return;
        }

        const message = await prisma.chatMessage.create({
          data: {
            roomId: data.room_id,
            senderId: userId,
            content: data.content.trim(),
            messageType: 'text',
          },
          include: {
            sender: { select: { id: true, displayName: true, avatarUrl: true } },
          },
        });

        // Broadcast to everyone in the room
        io.to(`room:${data.room_id}`).emit('chat:new_message', {
          room_id: data.room_id,
          message,
        });
      } catch {
        socket.emit('error', { code: 'SERVER_ERROR', message: 'Failed to send message.' });
      }
    });

    socket.on('chat:typing', (data: { room_id: string; is_typing: boolean }) => {
      socket.to(`room:${data.room_id}`).emit('chat:user_typing', {
        room_id: data.room_id,
        user_id: userId,
        is_typing: data.is_typing,
      });
    });

    // ─── Presence events ──────────────────────────────────────────────────

    socket.on('presence:heartbeat', async () => {
      await setPresence(userId);
    });

    // ─── Team live updates ─────────────────────────────────────────────────

    socket.on('teams:subscribe', (data: { team_id: string }) => {
      socket.join(`team:${data.team_id}`);
    });

    socket.on('teams:unsubscribe', (data: { team_id: string }) => {
      socket.leave(`team:${data.team_id}`);
    });

    // ─── Disconnect ───────────────────────────────────────────────────────

    socket.on('disconnect', async () => {
      console.log(`[socket] User ${userId} disconnected`);
      await removePresence(userId);
      await subscriber.disconnect();
    });
  });

  return io;
}

async function checkRoomAccess(roomId: string, userId: string): Promise<boolean> {
  const room = await prisma.chatRoom.findUnique({
    where: { id: roomId },
    include: {
      teamRooms: { include: { members: { where: { leftAt: null, userId } } } },
      provisionalRoom: {
        include: {
          members: { where: { userId, status: { in: ['pending', 'accepted'] } } },
        },
      },
    },
  });

  if (!room || room.status === 'deleted') return false;

  return (
    room.teamRooms.some((t) => t.members.length > 0) ||
    (!!room.provisionalRoom && room.provisionalRoom.members.length > 0)
  );
}

/**
 * Broadcast a team update event to all subscribers of a team room.
 * Called from route handlers.
 */
export function broadcastTeamUpdate(teamId: string, event: string, payload: object): void {
  io?.to(`team:${teamId}`).emit(event, payload);
}

export { io };
