import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import { authenticate } from '../middleware/auth';
import { validate, respondProvisionalSchema } from '../lib/validation';
import { AppError } from '../middleware/errorHandler';
import { sendNotification, sendBulkNotifications } from '../services/notificationService';
import { assertEventIsActive } from '../lib/eventLifecycle';

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

      const event = await prisma.event.findUnique({ where: { id: event_id } });
      if (!event) throw new AppError(404, 'NOT_FOUND', 'Event not found.');
      assertEventIsActive(event.status);

      if (pt.status !== 'pending') throw new AppError(409, 'ALREADY_RESOLVED', `Provisional team is already ${pt.status}.`);
      if (pt.expiresAt < new Date()) throw new AppError(409, 'EXPIRED', 'This provisional team has expired.');

      const myMembership = pt.members.find((m) => m.userId === userId);
      if (!myMembership || myMembership.status !== 'pending') {
        throw new AppError(403, 'FORBIDDEN', 'You cannot respond to this provisional team.');
      }

      if (action === 'reject') {
        let outcome: {
          replacementUserId: string | null;
          remainingUserIds: string[];
          dissolved: boolean;
        } | undefined;

        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            outcome = await prisma.$transaction(async (tx) => {
              // Serialize responses for this provisional team. This prevents
              // two simultaneous accept/reject requests from converting or
              // replacing the same provisional team inconsistently.
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${pt_id}))`;

              const current = await tx.provisionalTeam.findUniqueOrThrow({
                where: { id: pt_id },
                include: { members: true },
              });
              if (current.status !== 'pending') {
                throw new AppError(409, 'ALREADY_RESOLVED', `Provisional team is already ${current.status}.`);
              }

              const membership = current.members.find((m) => m.userId === userId);
              if (!membership || membership.status !== 'pending') {
                throw new AppError(403, 'FORBIDDEN', 'You cannot respond to this provisional team.');
              }

              await tx.provisionalTeamMember.update({
                where: { provisionalTeamId_userId: { provisionalTeamId: pt_id, userId } },
                data: { status: 'rejected', respondedAt: new Date() },
              });
              await tx.eventParticipant.update({
                where: { eventId_userId: { eventId: event_id, userId } },
                data: { status: 'looking_for_team', provisionalTeamId: null },
              });

              const remaining = current.members.filter(
                (m) => m.userId !== userId && ['pending', 'accepted'].includes(m.status)
              );

              if (remaining.length === 0) {
                await tx.provisionalTeam.update({
                  where: { id: pt_id },
                  data: { status: 'dissolved' },
                });
                if (current.chatRoomId) {
                  await tx.chatRoom.update({
                    where: { id: current.chatRoomId },
                    data: { status: 'archived' },
                  });
                }
                return { replacementUserId: null, remainingUserIds: [], dissolved: true };
              }

              // Find the best currently available replacement. Hard event
              // requirements are weighted first, followed by complementary
              // skills/roles and diversity with the remaining members.
              const event = await tx.event.findUniqueOrThrow({
                where: { id: event_id },
                include: { requiredSkills: true, requiredRoles: true },
              });
              const activeIds = remaining.map((m) => m.userId);
              const candidates = await tx.eventParticipant.findMany({
                where: {
                  eventId: event_id,
                  status: 'looking_for_team',
                  userId: { notIn: [...activeIds, userId] },
                },
                include: {
                  user: {
                    include: { skills: true, preferredRoles: true, interests: true },
                  },
                },
              });

              const hardSkills = event.requiredSkills.filter((r) => r.constraintType === 'hard').map((r) => r.skillName);
              const hardRoles = event.requiredRoles.filter((r) => r.constraintType === 'hard').map((r) => r.roleName);
              const softSkills = event.requiredSkills.filter((r) => r.constraintType === 'soft').map((r) => r.skillName);
              const softRoles = event.requiredRoles.filter((r) => r.constraintType === 'soft').map((r) => r.roleName);

              const activeProfiles = await tx.user.findMany({
                where: { id: { in: activeIds } },
                include: { skills: true, preferredRoles: true, interests: true },
              });

              const activeSkills = new Set(activeProfiles.flatMap((u) => u.skills.map((s) => s.skillName)));
              const activeRoles = new Set(activeProfiles.flatMap((u) => u.preferredRoles.map((r) => r.roleName)));

              const scored = candidates.map((candidate) => {
                const skills = new Set(candidate.user.skills.map((s) => s.skillName));
                const roles = new Set(candidate.user.preferredRoles.map((r) => r.roleName));
                const hardSkillGain = hardSkills.filter((s) => skills.has(s) && !activeSkills.has(s)).length;
                const hardRoleGain = hardRoles.filter((r) => roles.has(r) && !activeRoles.has(r)).length;
                const softGain = softSkills.filter((s) => skills.has(s)).length + softRoles.filter((r) => roles.has(r)).length;
                const diversityGain = [...skills].filter((s) => !activeSkills.has(s)).length;
                const roleComplement = [...roles].filter((r) => !activeRoles.has(r)).length;
                const score = hardSkillGain * 100 + hardRoleGain * 100 + softGain * 10 + diversityGain + roleComplement;
                return { candidate, score };
              }).sort((a, b) => b.score - a.score || a.candidate.registeredAt.getTime() - b.candidate.registeredAt.getTime());

              for (const scoredCandidate of scored) {
                // Atomically claim the candidate. Another provisional team may
                // have claimed this person after discovery; move to the next
                // ranked candidate instead of giving up the replacement round.
                const claimed = await tx.eventParticipant.updateMany({
                  where: {
                    eventId: event_id,
                    userId: scoredCandidate.candidate.userId,
                    status: 'looking_for_team',
                  },
                  data: {
                    status: 'in_provisional_team',
                    provisionalTeamId: pt_id,
                    profileSnapshot: {
                      skills: scoredCandidate.candidate.user.skills,
                      interests: scoredCandidate.candidate.user.interests,
                      preferredRoles: scoredCandidate.candidate.user.preferredRoles,
                    } as object,
                  },
                });

                if (claimed.count !== 1) continue;

                const replacementMember = await tx.provisionalTeamMember.create({
                  data: {
                    provisionalTeamId: pt_id,
                    userId: scoredCandidate.candidate.userId,
                    status: 'pending',
                    matchReason: {
                      replacement: true,
                      score: scoredCandidate.score,
                      reason: 'Selected from the current discovery pool to replace a declined member.',
                    },
                  },
                });

                return {
                  replacementUserId: replacementMember.userId,
                  remainingUserIds: remaining.map((m) => m.userId),
                  dissolved: false,
                };
              }
              return {
                replacementUserId: null,
                remainingUserIds: remaining.map((m) => m.userId),
                dissolved: false,
              };
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

        if (!outcome) throw new AppError(500, 'TRANSACTION_FAILED', 'Could not process the provisional-team response.');

        if (outcome.replacementUserId) {
          await sendNotification({
            userId: outcome.replacementUserId,
            eventId: event_id,
            type: 'match_proposed',
            title: "You've been matched with a replacement provisional team!",
            body: 'A member declined, and you have been invited to review the provisional team.',
            data: { provisional_team_id: pt_id, event_id },
          });
        }

        await sendBulkNotifications(
          outcome.remainingUserIds.map((remainingUserId) => ({
            userId: remainingUserId,
            eventId: event_id,
            type: 'provisional_member_responded' as const,
            title: outcome.replacementUserId ? 'A replacement member was found.' : 'A team member declined.',
            body: outcome.replacementUserId
              ? 'A replacement candidate has been added to your provisional team.'
              : 'No replacement is currently available. You may continue with the remaining members.',
            data: { provisional_team_id: pt_id },
          }))
        );

        res.json({
          member_status: 'rejected',
          replacement_user_id: outcome.replacementUserId,
          dissolved: outcome.dissolved,
          message: outcome.replacementUserId
            ? 'You have left the provisional team and a replacement was added.'
            : 'You have left the provisional team.',
        });
        return;
      }

      // action === 'accept'
      let result: { teamStatus: 'pending' | 'converted'; awaitingCount: number; teamId?: string } | undefined;

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          result = await prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${pt_id}))`;

            const current = await tx.provisionalTeam.findUniqueOrThrow({
              where: { id: pt_id },
              include: { members: true },
            });
            if (current.status !== 'pending') {
              throw new AppError(409, 'ALREADY_RESOLVED', `Provisional team is already ${current.status}.`);
            }

            const membership = current.members.find((m) => m.userId === userId);
            if (!membership || membership.status !== 'pending') {
              throw new AppError(403, 'FORBIDDEN', 'You cannot respond to this provisional team.');
            }

            await tx.provisionalTeamMember.update({
              where: { provisionalTeamId_userId: { provisionalTeamId: pt_id, userId } },
              data: { status: 'accepted', respondedAt: new Date() },
            });

            const allMembers = await tx.provisionalTeamMember.findMany({
              where: { provisionalTeamId: pt_id },
            });
            const activeMembers = allMembers.filter((m) => ['pending', 'accepted'].includes(m.status));
            const allActiveAccepted = activeMembers.length > 0 && activeMembers.every((m) => m.status === 'accepted');

            if (!allActiveAccepted) {
              return {
                teamStatus: 'pending' as const,
                awaitingCount: activeMembers.filter((m) => m.status === 'pending').length,
              };
            }

            await tx.provisionalTeam.update({
              where: { id: pt_id },
              data: { status: 'converted', finalizedTeamId: null },
            });

            const sortedMembers = [...activeMembers].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
            const leaderMemberId = sortedMembers[0]!.userId;

            // Keep the provisional room as the team's forming-stage workspace.
            // Finalization will create the permanent room and archive this room.
            // The provisional room is temporary and ends when the
            // provisional match is converted. The forming team receives its
            // permanent workspace only after explicit finalization.
            if (current.chatRoomId) {
              await tx.chatRoom.update({
                where: { id: current.chatRoomId },
                data: { status: 'archived' },
              });
            }

            const team = await tx.team.create({
              data: {
                eventId: event_id,
                name: `Team-${pt_id.slice(0, 8)}`,
                ownerId: leaderMemberId,
                chatRoomId: null,
                status: 'forming',
                source: 'auto_match',
              },
            });

            for (const member of activeMembers) {
              await tx.teamMember.create({
                data: {
                  teamId: team.id,
                  userId: member.userId,
                  roleInTeam: member.userId === leaderMemberId ? 'owner' : 'member',
                },
              });

              await tx.eventParticipant.update({
                where: { eventId_userId: { eventId: event_id, userId: member.userId } },
                data: { status: 'in_forming_team', teamId: team.id, provisionalTeamId: null },
              });
            }

            return { teamStatus: 'converted' as const, teamId: team.id, awaitingCount: 0 };
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

      if (!result) throw new AppError(500, 'TRANSACTION_FAILED', 'Could not process the provisional-team response.');

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
            data: { team_id: result.teamId, event_id },
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
