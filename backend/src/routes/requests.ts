import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import { authenticate } from '../middleware/auth';
import { validate, createRequestSchema, respondRequestSchema } from '../lib/validation';
import { AppError } from '../middleware/errorHandler';
import { sendNotification } from '../services/notificationService';
import { redisRateLimit } from '../middleware/rateLimiter';
import { assertEventFormationOpen, assertEventIsActive } from '../lib/eventLifecycle';

const router = Router({ mergeParams: true });

// ─── POST /v1/events/:event_id/requests ───────────────────────────────────
router.post(
  '/:event_id/requests',
  authenticate,
  redisRateLimit('send_request', 20, 60 * 60 * 1000),
  validate({ body: createRequestSchema.shape.body }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { event_id } = req.params;
      const senderId = req.user!.sub;
      const body = req.body;

      const senderParticipant = await prisma.eventParticipant.findUnique({
        where: { eventId_userId: { eventId: event_id, userId: senderId } },
      });

      const event = await prisma.event.findUnique({ where: { id: event_id } });
      if (!event) throw new AppError(404, 'NOT_FOUND', 'Event not found.');
      assertEventFormationOpen(event.status);

      if (!senderParticipant) throw new AppError(403, 'NOT_REGISTERED', 'You must register for the event first.');

      // Determine recipient based on type
      let recipientId: string;
      let teamId: string | undefined = body.team_id;

      if (body.type === 'join_request') {
        // User → Team: recipient is the team owner
        const team = await prisma.team.findUnique({ where: { id: body.team_id } });
        if (!team || team.eventId !== event_id) throw new AppError(404, 'NOT_FOUND', 'Team not found.');
        if (team.status !== 'forming') throw new AppError(409, 'TEAM_NOT_RECRUITING', 'This team is not accepting requests.');
        recipientId = team.ownerId;

        // Sender must be available (not already in a team)
        const unavailableStates = ['in_forming_team', 'in_finalized_team', 'in_provisional_team', 'in_matchmaking'];
        if (unavailableStates.includes(senderParticipant.status)) {
          throw new AppError(409, 'USER_UNAVAILABLE', 'You are already in a team or matchmaking process.');
        }

      } else {
        // team_invite or personal_invite: verify sender is team member/owner
        recipientId = body.recipient_id;

        const team = await prisma.team.findUnique({ where: { id: body.team_id } });
        if (!team || team.eventId !== event_id) throw new AppError(404, 'NOT_FOUND', 'Team not found.');
        if (team.status !== 'forming') throw new AppError(409, 'TEAM_NOT_RECRUITING', 'This team is not accepting new members.');

        const senderMembership = await prisma.teamMember.findUnique({
          where: { teamId_userId: { teamId: body.team_id, userId: senderId } },
        });
        if (!senderMembership || senderMembership.leftAt || !['owner', 'admin'].includes(senderMembership.roleInTeam)) {
          throw new AppError(403, 'FORBIDDEN', 'Only team owners and admins can send invitations.');
        }

        // Verify recipient is available
        const recipientParticipant = await prisma.eventParticipant.findUnique({
          where: { eventId_userId: { eventId: event_id, userId: recipientId } },
        });
        const unavailableStates = ['in_forming_team', 'in_finalized_team', 'in_provisional_team', 'in_matchmaking'];
        if (!recipientParticipant || unavailableStates.includes(recipientParticipant.status)) {
          throw new AppError(409, 'USER_UNAVAILABLE', 'User is not available for invitations.');
        }
      }

      // Check for duplicate pending request
      const duplicate = await prisma.requestInvitation.findFirst({
        where: {
          eventId: event_id,
          type: body.type,
          senderId,
          recipientId,
          teamId,
          status: 'pending',
        },
      });

      if (duplicate) throw new AppError(409, 'DUPLICATE_REQUEST', 'A pending request already exists.');

      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

      const request = await prisma.requestInvitation.create({
        data: {
          eventId: event_id,
          type: body.type,
          senderId,
          recipientId,
          teamId,
          message: body.message,
          expiresAt,
        },
        include: {
          sender: { select: { id: true, displayName: true } },
          recipient: { select: { id: true, displayName: true } },
          team: { select: { id: true, name: true } },
        },
      });

      // Notify recipient
      await sendNotification({
        userId: recipientId,
        eventId: event_id,
        type: body.type === 'join_request' ? 'join_request' : 'team_invite',
        title: body.type === 'join_request'
          ? `New join request for your team`
          : `You've been invited to join a team`,
        body: body.message,
        data: { request_id: request.id, team_id: teamId },
      });

      res.status(201).json({ request });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /v1/events/:event_id/requests ────────────────────────────────────
router.get('/:event_id/requests', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { event_id } = req.params;
    const { direction = 'received', status, type, limit = '20' } = req.query as Record<string, string>;
    const userId = req.user!.sub;
    const take = Math.min(parseInt(limit), 50);

    const requests = await prisma.requestInvitation.findMany({
      where: {
        eventId: event_id,
        ...(direction === 'received' ? { recipientId: userId } : { senderId: userId }),
        ...(status ? { status: status as never } : {}),
        ...(type ? { type: type as never } : {}),
      },
      include: {
        sender: { select: { id: true, displayName: true, avatarUrl: true } },
        recipient: { select: { id: true, displayName: true, avatarUrl: true } },
        team: { select: { id: true, name: true, status: true } },
      },
      take,
      orderBy: { createdAt: 'desc' },
    });

    res.json({ data: requests });
  } catch (err) {
    next(err);
  }
});

// ─── PUT /v1/events/:event_id/requests/:request_id ────────────────────────
router.put(
  '/:event_id/requests/:request_id',
  authenticate,
  validate({ body: respondRequestSchema.shape.body }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { event_id, request_id } = req.params;
      const { action } = req.body;
      const userId = req.user!.sub;

      const request = await prisma.requestInvitation.findUnique({
        where: { id: request_id },
        include: { team: true },
      });

      if (!request || request.eventId !== event_id) throw new AppError(404, 'NOT_FOUND', 'Request not found.');

      const event = await prisma.event.findUnique({ where: { id: event_id } });
      if (!event) throw new AppError(404, 'NOT_FOUND', 'Event not found.');
      assertEventIsActive(event.status);

      if (request.status !== 'pending') throw new AppError(409, 'ALREADY_RESOLVED', 'This request has already been resolved.');

      // Validate actor
      if (action === 'cancel') {
        if (request.senderId !== userId) throw new AppError(403, 'FORBIDDEN', 'Only the sender can cancel.');
      } else {
        if (request.recipientId !== userId) throw new AppError(403, 'FORBIDDEN', 'Only the recipient can respond.');
      }

      if (action === 'cancel') {
        await prisma.requestInvitation.update({ where: { id: request_id }, data: { status: 'cancelled' } });
        res.json({ request: { ...request, status: 'cancelled' } });
        return;
      }

      if (action === 'reject') {
        await prisma.requestInvitation.update({
          where: { id: request_id },
          data: { status: 'rejected', respondedAt: new Date() },
        });

        await sendNotification({
          userId: request.senderId,
          eventId: event_id,
          type: 'request_rejected',
          title: 'Your request was declined.',
          data: { request_id },
        });

        res.json({ request: { ...request, status: 'rejected' } });
        return;
      }

      // action === 'accept'
      // The person entering the team depends on request direction:
      // - join_request: the sender asked to join, so the sender enters.
      // - team_invite/personal_invite: the recipient was invited, so the recipient enters.
      const joiningUserId = request.type === 'join_request' ? request.senderId : request.recipientId;

      // Serialize competing accepts for the same participant. A user may only
      // transition into one forming team, even when multiple invitations are
      // accepted concurrently from different requests/tabs.
      let result: { team: typeof request.team; cancelledCount: number } | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          result = await prisma.$transaction(async (tx) => {
            const participant = await tx.eventParticipant.findUniqueOrThrow({
              where: { eventId_userId: { eventId: event_id, userId: joiningUserId } },
            });

            const unavailableStates = ['in_forming_team', 'in_finalized_team', 'in_provisional_team', 'in_matchmaking'];
            if (unavailableStates.includes(participant.status)) {
              throw new AppError(409, 'ALREADY_IN_TEAM', 'This user is already in a team or matchmaking process.');
            }

            const teamId = request.teamId!;
            const team = await tx.team.findUniqueOrThrow({ where: { id: teamId } });
            if (team.status !== 'forming') {
              throw new AppError(409, 'TEAM_NOT_RECRUITING', 'This team is no longer recruiting.');
            }

            const existingMembership = await tx.teamMember.findUnique({
              where: { teamId_userId: { teamId, userId: joiningUserId } },
            });
            if (existingMembership && !existingMembership.leftAt) {
              throw new AppError(409, 'ALREADY_MEMBER', 'This user is already a member of this team.');
            }

            if (existingMembership) {
              await tx.teamMember.update({
                where: { teamId_userId: { teamId, userId: joiningUserId } },
                data: { leftAt: null, roleInTeam: 'member' },
              });
            } else {
              await tx.teamMember.create({ data: { teamId, userId: joiningUserId, roleInTeam: 'member' } });
            }

            await tx.eventParticipant.update({
              where: { eventId_userId: { eventId: event_id, userId: joiningUserId } },
              data: { status: 'in_forming_team', teamId },
            });

            await tx.requestInvitation.update({
              where: { id: request_id },
              data: { status: 'accepted', respondedAt: new Date() },
            });

            const cancelledCount = await tx.requestInvitation.updateMany({
              where: {
                eventId: event_id,
                id: { not: request_id },
                OR: [{ recipientId: joiningUserId }, { senderId: joiningUserId }],
                status: 'pending',
              },
              data: { status: 'cancelled' },
            });

            return { team, cancelledCount: cancelledCount.count };
          }, {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 5000,
            timeout: 10000,
          });
          break;
        } catch (err: any) {
          if (err?.code === 'P2034' && attempt < 2) continue;
          throw err;
        }
      }

      if (!result || !result.team) throw new AppError(500, 'TRANSACTION_FAILED', 'Could not accept the request.');

      await sendNotification({
        userId: request.senderId,
        eventId: event_id,
        type: 'request_accepted',
        title: 'Your invitation was accepted!',
        data: { request_id, team_id: request.teamId },
      });

      res.json({
        request: { ...request, status: 'accepted' },
        side_effects: {
          team_joined: { id: result.team.id, name: result.team.name },
          cancelled_requests: result.cancelledCount,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
