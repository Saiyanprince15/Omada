import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { verifyAccessToken } from './lib/jwt';
import { prisma } from './lib/prisma';
import { setPresence, removePresence, getRedis, checkRateLimit } from './lib/redis';

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
        if (!data?.room_id || typeof data.room_id !== 'string') {
          socket.emit('error', { code: 'INVALID_INPUT', message: 'room_id is required.' });
          return;
        }
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
        if (!data?.room_id || !data?.content?.trim() || data.content.length > 5000) {
          socket.emit('error', { code: 'INVALID_MESSAGE', message: 'Message too long or empty.' });
          return;
        }

        const canAccess = await checkRoomAccess(data.room_id, userId);
        if (!canAccess) {
          socket.emit('error', { code: 'FORBIDDEN', message: 'Cannot send to this room.' });
          return;
        }

        const rate = await checkRateLimit(`socket_chat_message:${userId}`, 60, 60_000);
        if (!rate.allowed) {
          socket.emit('error', { code: 'RATE_LIMITED', message: 'Too many messages. Please slow down.' });
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

        // Broadcast to everyone in the room (including sender)
        io.to(`room:${data.room_id}`).emit('chat:new_message', {
          room_id: data.room_id,
          message,
        });
      } catch {
        socket.emit('error', { code: 'SERVER_ERROR', message: 'Failed to send message.' });
      }
    });

    // ─── Typing indicator ────────────────────────────────────────────────
    // Note: We verify room access before broadcasting typing events to prevent
    // unauthorized users from sending events to rooms they're not in.
    socket.on('chat:typing', async (data: { room_id: string; is_typing: boolean }) => {
      try {
        if (!data?.room_id) return;

        const canAccess = await checkRoomAccess(data.room_id, userId);
        if (!canAccess) return;

        socket.to(`room:${data.room_id}`).emit('chat:user_typing', {
          room_id: data.room_id,
          user_id: userId,
          is_typing: data.is_typing,
        });
      } catch {
        // Ignore errors in typing events
      }
    });

    // ─── Presence events ──────────────────────────────────────────────────

    socket.on('presence:heartbeat', async () => {
      await setPresence(userId);
    });

    // ─── Team live updates ─────────────────────────────────────────────────
    // Authorization: verify that the user is actually a member of the team
    // before allowing subscription to team events.

    socket.on('teams:subscribe', async (data: { team_id: string }) => {
      try {
        if (!data?.team_id || typeof data.team_id !== 'string') {
          socket.emit('error', { code: 'INVALID_INPUT', message: 'team_id is required.' });
          return;
        }

        const isMember = await checkTeamMembership(data.team_id, userId);
        if (!isMember) {
          socket.emit('error', { code: 'FORBIDDEN', message: 'You are not a member of this team.' });
          return;
        }

        socket.join(`team:${data.team_id}`);
        socket.emit('teams:subscribed', { team_id: data.team_id });
      } catch {
        socket.emit('error', { code: 'SERVER_ERROR', message: 'Failed to subscribe to team.' });
      }
    });

    socket.on('teams:unsubscribe', (data: { team_id: string }) => {
      if (data?.team_id) {
        socket.leave(`team:${data.team_id}`);
      }
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

/**
 * Check if a user has access to a chat room.
 * Access is granted if the user is:
 * - An active member of a team that owns this room, or
 * - An active member (pending or accepted) of a provisional team that owns this room.
 */
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
 * Check if a user is an active member of a team.
 */
async function checkTeamMembership(teamId: string, userId: string): Promise<boolean> {
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
  });
  return !!membership && !membership.leftAt;
}

/**
 * Broadcast a team update event to all subscribers of a team room.
 * Called from route handlers.
 */
export function broadcastTeamUpdate(teamId: string, event: string, payload: object): void {
  io?.to(`team:${teamId}`).emit(event, payload);
}

/**
 * Broadcast a new chat message to all subscribers of a chat room.
 * Called from HTTP route handlers (chat.ts) to sync with Socket.IO clients.
 */
export function broadcastChatMessage(roomId: string, message: object): void {
  io?.to(`room:${roomId}`).emit('chat:new_message', {
    room_id: roomId,
    message,
  });
}

export { io };
