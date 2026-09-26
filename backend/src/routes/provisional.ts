import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { validate, respondProvisionalSchema } from '../lib/validation';
import { AppError } from '../middleware/errorHandler';
import { sendNotification, sendBulkNotifications } from '../services/notificationService';

const router = Router({ mergeParams: true });

// ─── GET /v1/events/:event_id/provisional-teams/:pt_id ────────────────────
router.get(
  '/:event_id/provisional-teams/:pt_id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { pt_id, event_id } = req.params;
      const userId = req.user!.sub;

      const pt = await prisma.provisionalTeam.findUnique({
        where: { id: pt_id },
        include: {
          members: {
            include: {
              user: {
                select: {
                  id: true, displayName: true, avatarUrl: true, bio: true,
                  skills: { select: { skillName: true, skillDisplay: true, proficiency: true } },
                  interests: { select: { interestName: true, interestDisplay: true } },
                  preferredRoles: { select: { roleName: true, roleDisplay: true, priority: true } },
                },
              },
            },
          },
        },
      });

      if (!pt || pt.eventId !== event_id) throw new AppError(404, 'NOT_FOUND', 'Provisional team not found.');

      // Must be a member to view
      const isMember = pt.members.some((m) => m.userId === userId);
      if (!isMember) throw new AppError(403, 'FORBIDDEN', 'You are not a member of this provisional team.');

      res.json(pt);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /v1/events/:event_id/provisional-teams/:pt_id/respond ───────────
router.post(
  '/:event_id/provisional-teams/:pt_id/respond',
  authenticate,
  validate({ body: respondProvisionalSchema.shape.body }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { pt_id, event_id } = req.params;
      const { action } = req.body;
      const userId = req.user!.sub;

      const pt = await prisma.provisionalTeam.findUnique({
        where: { id: pt_id },
        include: { members: true },
      });

      if (!pt || pt.eventId !== event_id) throw new AppError(404, 'NOT_FOUND', 'Provisional team not found.');
      if (pt.status !== 'pending') throw new AppError(409, 'ALREADY_RESOLVED', `Provisional team is already ${pt.status}.`);

      const myMembership = pt.members.find((m) => m.userId === userId);
      if (!myMembership || !['pending'].includes(myMembership.status)) {
        throw new AppError(403, 'FORBIDDEN', 'You cannot respond to this provisional team.');
      }

      if (action === 'reject') {
        await prisma.$transaction(async (tx) => {
          await tx.provisionalTeamMember.update({
            where: { provisionalTeamId_userId: { provisionalTeamId: pt_id, userId } },
            data: { status: 'rejected', respondedAt: new Date() },
          });

          await tx.eventParticipant.update({
            where: { eventId_userId: { eventId: event_id, userId } },
            data: { status: 'looking_for_team', provisionalTeamId: null },
          });

          // Check remaining viability
          const remaining = pt.members.filter(
            (m) => m.userId !== userId && ['pending', 'accepted'].includes(m.status)
          );

          const event = await tx.event.findUnique({ where: { id: event_id } });
          if (!event) return;

          if (remaining.length < event.minTeamSize) {
            // Dissolve — not enough members
            await tx.provisionalTeam.update({
              where: { id: pt_id },
              data: { status: 'dissolved' },
            });

            // Return remaining members to looking_for_team
            for (const member of remaining) {
              await tx.eventParticipant.update({
                where: { eventId_userId: { eventId: event_id, userId: member.userId } },
                data: { status: 'looking_for_team', provisionalTeamId: null },
              });
              await tx.provisionalTeamMember.update({
                where: { provisionalTeamId_userId: { provisionalTeamId: pt_id, userId: member.userId } },
                data: { status: 'replaced' },
              });
            }

            // Notify all remaining members
            await sendBulkNotifications(
              remaining.map((m) => ({
                userId: m.userId,
                eventId: event_id,
                type: 'provisional_dissolved' as const,
                title: 'Provisional team has been dissolved.',
                body: 'A member rejected the match. You are now looking for a team again.',
                data: { provisional_team_id: pt_id },
              }))
            );
          } else {
            // Notify remaining members
            await sendBulkNotifications(
              remaining.map((m) => ({
                userId: m.userId,
                eventId: event_id,
                type: 'provisional_member_responded' as const,
                title: 'A team member declined.',
                body: 'A member rejected the provisional match.',
                data: { provisional_team_id: pt_id },
              }))
            );
          }
        });

        res.json({ member_status: 'rejected', message: 'You have left the provisional team.' });
        return;
      }

      // action === 'accept'
      const result = await prisma.$transaction(async (tx) => {
        await tx.provisionalTeamMember.update({
          where: { provisionalTeamId_userId: { provisionalTeamId: pt_id, userId } },
          data: { status: 'accepted', respondedAt: new Date() },
        });

        // Check if all members accepted
        const allMembers = await tx.provisionalTeamMember.findMany({
          where: { provisionalTeamId: pt_id },
        });

        const allAccepted = allMembers.every((m) =>
          m.userId === userId ? true : m.status === 'accepted'
        );

        if (!allAccepted) {
          const awaiting = allMembers.filter(
            (m) => m.userId !== userId && m.status === 'pending'
          ).length;
          return { teamStatus: 'pending', awaitingCount: awaiting };
        }

        // All accepted — convert to permanent team
        await tx.provisionalTeam.update({ where: { id: pt_id }, data: { status: 'accepted' } });

        const event = await tx.event.findUnique({ where: { id: event_id } });
        if (!event) throw new AppError(500, 'SERVER_ERROR', 'Event not found.');

        // Create permanent chat room
        const permanentChatRoom = await tx.chatRoom.create({ data: { roomType: 'permanent' } });

        // Create team
        const leaderMemberId = allMembers[0]!.userId;
        const team = await tx.team.create({
          data: {
            eventId: event_id,
            name: `Team-${pt_id.slice(0, 8)}`,  // Default name — can be changed
            ownerId: leaderMemberId,
            maxSize: allMembers.length,
            chatRoomId: permanentChatRoom.id,
            status: 'finalized',
            source: 'auto_match',
          },
        });

        // Create team members
        for (const member of allMembers) {
          await tx.teamMember.create({
            data: {
              teamId: team.id,
              userId: member.userId,
              roleInTeam: member.userId === leaderMemberId ? 'owner' : 'member',
            },
          });

          await tx.eventParticipant.update({
            where: { eventId_userId: { eventId: event_id, userId: member.userId } },
            data: { status: 'in_finalized_team', teamId: team.id, provisionalTeamId: null },
          });
        }

        // Archive provisional chat room
        if (pt.chatRoomId) {
          await tx.chatRoom.update({ where: { id: pt.chatRoomId }, data: { status: 'archived' } });
        }

        await tx.provisionalTeam.update({
          where: { id: pt_id },
          data: { status: 'converted', finalizedTeamId: team.id },
        });

        return { teamStatus: 'converted', teamId: team.id, awaitingCount: 0 };
      });

      // Notify all members if team was converted
      if (result.teamStatus === 'converted' && result.teamId) {
        const members = await prisma.teamMember.findMany({
          where: { teamId: result.teamId, leftAt: null },
        });
        await sendBulkNotifications(
          members.map((m) => ({
            userId: m.userId,
            eventId: event_id,
            type: 'provisional_converted' as const,
            title: '🎉 Your team is now official!',
            body: 'All members accepted. Your provisional team has become a permanent team.',
            data: { team_id: result.teamId },
          }))
        );
      }

      res.json({
        member_status: 'accepted',
        team_status: result.teamStatus,
        awaiting_response_from: result.awaitingCount,
        ...(result.teamId ? { team_id: result.teamId } : {}),
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
