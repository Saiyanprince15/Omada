import { prisma } from '../lib/prisma';
import { publish } from '../lib/redis';

export type NotificationType =
  | 'team_invite'
  | 'join_request'
  | 'request_accepted'
  | 'request_rejected'
  | 'match_proposed'
  | 'provisional_member_responded'
  | 'provisional_replacement'
  | 'provisional_dissolved'
  | 'provisional_converted'
  | 'team_finalized'
  | 'team_dissolved'
  | 'team_member_joined'
  | 'team_member_left';

export interface NotificationPayload {
  userId: string;
  eventId?: string;
  type: NotificationType;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
}

/**
 * Creates a notification in the DB and publishes it to Redis Pub/Sub
 * so WebSocket gateway can push it to connected clients.
 */
export async function sendNotification(payload: NotificationPayload): Promise<void> {
  const notification = await prisma.notification.create({
    data: {
      userId: payload.userId,
      eventId: payload.eventId,
      type: payload.type,
      title: payload.title,
      body: payload.body,
      data: (payload.data ?? {}) as any,
    },
  });

  // Publish to Redis so Socket.IO gateway can forward to user
  await publish(`notification:user:${payload.userId}`, {
    event: 'notification:new',
    payload: notification,
  });
}

export async function sendBulkNotifications(payloads: NotificationPayload[]): Promise<void> {
  await Promise.all(payloads.map(sendNotification));
}
