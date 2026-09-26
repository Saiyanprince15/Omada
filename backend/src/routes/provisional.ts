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
// Handles accept / reject.
// Rejection below threshold: dissolves team and returns all members to looking_for_team.
// Rejection above threshold: simply marks member as rejected (team continues).
// All-accepted: converts to permanent forming team (NOT finalized — team must explicitly finalize).
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
      if (pt.expiresAt < new Date()) throw new AppError(409, 'EXPIRED', 'This provisional team has expired.');

      const myMembership = pt.members.find((m) => m.userId === userId);
      if (!myMembership || myMembership.status !== 'pending') {
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

          // Remaining members = those who haven't rejected or left
          const remaining = pt.members.filter(
            (m) => m.userId !== userId && ['pending', 'accepted'].includes(m.status)
          );

          // With unlimited team sizes there's no fixed minimum —
          // if only 1 person remains, dissolve (a team of 1 is not viable).
          if (remaining.length < 1) {
            await tx.provisionalTeam.update({
              where: { id: pt_id },
              data: { status: 'dissolved' },
            });

            // Return any remaining pending/accepted members to looking_for_team
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
            // Team can continue — notify remaining members
            await sendBulkNotifications(
              remaining.map((m) => ({
                userId: m.userId,
                eventId: event_id,
                type: 'provisional_member_responded' as const,
                title: 'A team member declined.',
                body: 'A member rejected the provisional match. You may still accept.',
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
        // Mark this user as accepted
        await tx.provisionalTeamMember.update({
          where: { provisionalTeamId_userId: { provisionalTeamId: pt_id, userId } },
          data: { status: 'accepted', respondedAt: new Date() },
        });

        // Re-read all members within transaction
        const allMembers = await tx.provisionalTeamMember.findMany({
          where: { provisionalTeamId: pt_id },
        });

        // Active members = not rejected/left/expired/replaced
        const activeMembers = allMembers.filter((m) =>
          m.userId === userId ? true : ['pending', 'accepted'].includes(m.status)
        );

        // Check if all active members have accepted
        const allActiveAccepted = activeMembers.every((m) =>
          m.userId === userId ? true : m.status === 'accepted'
        );

        if (!allActiveAccepted) {
          const awaitingCount = activeMembers.filter(
            (m) => m.userId !== userId && m.status === 'pending'
          ).length;
          return { teamStatus: 'pending', awaitingCount };
        }

        // All active members accepted — convert to permanent forming team
        // Team completion must be explicitly decided by the team (not automatic from member count)
        await tx.provisionalTeam.update({ where: { id: pt_id }, data: { status: 'accepted' } });

        // Create permanent chat room
        const permanentChatRoom = await tx.chatRoom.create({ data: { roomType: 'permanent' } });

        // Use first member (oldest created) as initial owner
        const sortedMembers = [...activeMembers].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        const leaderMemberId = sortedMembers[0]!.userId;

        const team = await tx.team.create({
          data: {
            eventId: event_id,
            name: `Team-${pt_id.slice(0, 8)}`,
            ownerId: leaderMemberId,
            chatRoomId: permanentChatRoom.id,
            status: 'forming',  // NOT finalized — team must explicitly decide completion
            source: 'auto_match',
          },
        });

        // Create team members
        for (const member of activeMembers) {
          await tx.teamMember.create({
            data: {
              teamId: team.id,
              userId: member.userId,
              roleInTeam: member.userId === leaderMemberId ? 'owner' : 'member',
            },
          });

          // Move participant to in_forming_team (not in_finalized_team)
          await tx.eventParticipant.update({
            where: { eventId_userId: { eventId: event_id, userId: member.userId } },
            data: { status: 'in_forming_team', teamId: team.id, provisionalTeamId: null },
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
            title: '🎉 Your provisional team is now a forming team!',
            body: 'All members accepted. Finalize your team when you are ready.',
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
