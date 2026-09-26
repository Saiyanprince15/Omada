import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { validate, createTeamSchema, updateTeamSchema, transferOwnershipSchema } from '../lib/validation';
import { AppError } from '../middleware/errorHandler';
import { sendNotification } from '../services/notificationService';
import { rankCandidates, DEFAULT_WEIGHTS } from '../services/matchingEngine';
import { normalizeSkill, normalizeRole } from '../lib/normalize';
import { assertEventFormationOpen, assertEventIsActive } from '../lib/eventLifecycle';
import { broadcastTeamUpdate } from '../socket';

const router = Router({ mergeParams: true });

const TEAM_PUBLIC_INCLUDE = {
  owner: { select: { id: true, displayName: true, avatarUrl: true } },
  members: {
    where: { leftAt: null },
    include: {
      user: {
        select: {
          id: true, displayName: true, avatarUrl: true,
          skills: { select: { skillName: true, skillDisplay: true, proficiency: true } },
          preferredRoles: { select: { roleName: true, roleDisplay: true, priority: true } },
        },
      },
    },
  },
  requirements: true,
};

/**
 * Verify that the team belongs to the event_id in the URL.
 * Prevents cross-event authorization bypass.
 */
async function requireTeamInEvent(teamId: string, eventId: string) {
  const team = await prisma.team.findUnique({ where: { id: teamId } });
  if (!team) throw new AppError(404, 'NOT_FOUND', 'Team not found.');
  if (team.eventId !== eventId) throw new AppError(404, 'NOT_FOUND', 'Team not found.');
  return team;
}

async function requireTeamMembership(
  teamId: string,
  userId: string,
  allowedRoles: Array<'owner' | 'admin' | 'member'>
) {
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
  });

  if (!membership || membership.leftAt || !allowedRoles.includes(membership.roleInTeam as never)) {
    throw new AppError(403, 'FORBIDDEN', 'Insufficient team permissions.');
  }
  return membership;
}

/**
 * Guard: reject operations on finalized or dissolved teams (except where explicitly allowed).
 */
function requireMutableTeam(team: { status: string }, allowedStatuses: string[] = ['forming']) {
  if (!allowedStatuses.includes(team.status)) {
    if (team.status === 'finalized') {
      throw new AppError(409, 'TEAM_FINALIZED', 'Cannot modify a finalized team.');
    }
    if (team.status === 'dissolved') {
      throw new AppError(409, 'TEAM_DISSOLVED', 'Cannot modify a dissolved team.');
    }
    if (team.status === 'locked') {
      throw new AppError(409, 'TEAM_LOCKED', 'Cannot modify a locked team.');
    }
    throw new AppError(409, 'INVALID_STATE', `Cannot modify team in state: ${team.status}.`);
  }
}

// ─── POST /v1/events/:event_id/teams ──────────────────────────────────────
// Creates a manual team. Owner is placed into `in_forming_team` state.
// Team completion must be explicitly decided (finalize endpoint).
// Chat room is NOT created here — only a provisional workspace is created.
// The permanent team chat room is created at finalization time (fix #10).
router.post(
  '/:event_id/teams',
  authenticate,
  validate({ body: createTeamSchema.shape.body }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { event_id } = req.params;
      const userId = req.user!.sub;

      const event = await prisma.event.findUnique({ where: { id: event_id } });
      if (!event) throw new AppError(404, 'NOT_FOUND', 'Event not found.');
      assertEventFormationOpen(event.status);

      const body = req.body;

      const team = await prisma.$transaction(async (tx) => {
        // Serialize team creation per event/user so concurrent requests
        // cannot both observe the participant as available.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${event_id} || ':' || ${userId}))`;

        const participant = await tx.eventParticipant.findUnique({
          where: { eventId_userId: { eventId: event_id, userId } },
        });

        if (!participant) throw new AppError(403, 'NOT_REGISTERED', 'You must register for the event first.');

        const allowedStates = ['registered', 'looking_for_team'];
        if (!allowedStates.includes(participant.status)) {
          throw new AppError(409, 'INVALID_STATE', `Cannot create a team from state: ${participant.status}.`);
        }

        // Create a provisional chat room for the forming team (not permanent yet — fix #10)
        const chatRoom = await tx.chatRoom.create({ data: { roomType: 'provisional' } });

        const newTeam = await tx.team.create({
          data: {
            eventId: event_id,
            name: body.name,
            description: body.description,
            ownerId: userId,
            projectIdea: body.project_idea,
            chatRoomId: chatRoom.id,
            source: 'manual',
            status: 'forming',
            requirements: {
              create: (body.requirements ?? []).map((r: { type: string; name: string; priority: string }) => ({
                requirementType: r.type,
                // Use appropriate normalizer based on requirement type (fix #13)
                name: r.type === 'role' ? normalizeRole(r.name) : normalizeSkill(r.name),
                priority: r.priority,
              })),
            },
          },
          include: { ...TEAM_PUBLIC_INCLUDE, requirements: true },
        });

        await tx.teamMember.create({
          data: { teamId: newTeam.id, userId, roleInTeam: 'owner' },
        });

        // Owner moves to in_forming_team (not yet finalized)
        await tx.eventParticipant.update({
          where: { eventId_userId: { eventId: event_id, userId } },
          data: { status: 'in_forming_team', teamId: newTeam.id },
        });

        return newTeam;
      });

      const activeMemberCount = team.members.filter((m) => !m.leftAt).length;
      res.status(201).json({ team: { ...team, current_size: activeMemberCount } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /v1/events/:event_id/teams ───────────────────────────────────────
router.get('/:event_id/teams', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { event_id } = req.params;
    const { status, needs_skill, limit = '20', cursor } = req.query as Record<string, string>;
    const take = Math.min(parseInt(limit), 50);

    const teams = await prisma.team.findMany({
      where: {
        eventId: event_id,
        ...(status ? { status: status as never } : { status: { in: ['forming', 'finalized'] } }),
        ...(needs_skill
          ? { requirements: { some: { requirementType: 'skill', name: normalizeSkill(needs_skill) } } }
          : {}),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      include: TEAM_PUBLIC_INCLUDE,
      take: take + 1,
      orderBy: { createdAt: 'desc' },
    });

    const hasMore = teams.length > take;
    const data = hasMore ? teams.slice(0, take) : teams;

    const enriched = data.map((t) => {
      const activeMembers = t.members.filter((m) => !m.leftAt);
      return {
        ...t,
        current_size: activeMembers.length,
      };
    });

    res.json({
      data: enriched,
      pagination: { next_cursor: hasMore ? data[data.length - 1]?.id : null, has_more: hasMore },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /v1/events/:event_id/teams/discover ──────────────────────────────
router.get('/:event_id/teams/discover', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { event_id } = req.params;
    const { mode = 'explore', limit = '20' } = req.query as Record<string, string>;
    const userId = req.user!.sub;
    const take = Math.min(parseInt(limit), 50);

    const openTeams = await prisma.team.findMany({
      where: { eventId: event_id, status: 'forming' },
      include: { ...TEAM_PUBLIC_INCLUDE, requirements: true },
      take,
    });

    if (mode === 'explore') {
      const enriched = openTeams.map((t) => {
        const activeMembers = t.members.filter((m) => !m.leftAt);
        return { team: t, current_size: activeMembers.length };
      });
      res.json({ data: enriched });
      return;
    }

    // mode === 'match_my_skills'
    const userProfile = await prisma.user.findUnique({
      where: { id: userId },
      include: { skills: true, preferredRoles: true },
    });

    if (!userProfile) throw new AppError(404, 'NOT_FOUND', 'User not found.');

    const userSkills = new Set(userProfile.skills.map((s) => s.skillName));
    const userRoles = new Set(userProfile.preferredRoles.map((r) => r.roleName));

    const enriched = openTeams
      .map((t) => {
        const activeMembers = t.members.filter((m) => !m.leftAt);
        const needsSkills = t.requirements
          .filter((r) => r.requirementType === 'skill')
          .map((r) => r.name);
        const needsRoles = t.requirements
          .filter((r) => r.requirementType === 'role')
          .map((r) => r.name);

        const matchingSkills = needsSkills.filter((s) => userSkills.has(s));
        const matchingRoles = needsRoles.filter((r) => userRoles.has(r));
        const matchScore = (matchingSkills.length + matchingRoles.length) /
          Math.max(1, needsSkills.length + needsRoles.length);

        return {
          team: t,
          match_score: matchScore,
          matching_skills: matchingSkills,
          matching_roles: matchingRoles,
          current_size: activeMembers.length,
        };
      })
      .filter((t) => t.match_score > 0)
      .sort((a, b) => b.match_score - a.match_score);

    res.json({ data: enriched });
  } catch (err) {
    next(err);
  }
});

// ─── GET /v1/events/:event_id/teams/:team_id ──────────────────────────────
router.get('/:event_id/teams/:team_id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const team = await prisma.team.findUnique({
      where: { id: req.params.team_id },
      include: TEAM_PUBLIC_INCLUDE,
    });

    // Fix #2: cross-event auth check
    if (!team || team.eventId !== req.params.event_id) {
      throw new AppError(404, 'NOT_FOUND', 'Team not found.');
    }

    const activeMembers = team.members.filter((m) => !m.leftAt);
    res.json({
      ...team,
      current_size: activeMembers.length,
    });
  } catch (err) {
    next(err);
  }
});

// ─── PUT /v1/events/:event_id/teams/:team_id ──────────────────────────────
router.put(
  '/:event_id/teams/:team_id',
  authenticate,
  validate({ body: updateTeamSchema.shape.body }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { team_id, event_id } = req.params;

      // Fix #2: cross-event auth
      const teamRecord = await requireTeamInEvent(team_id, event_id);

      // Fix #12: block modifications on finalized teams
      requireMutableTeam(teamRecord);

      await requireTeamMembership(team_id, req.user!.sub, ['owner', 'admin']);

      const body = req.body;
      const team = await prisma.team.update({
        where: { id: team_id },
        data: {
          ...(body.name && { name: body.name }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.project_idea !== undefined && { projectIdea: body.project_idea }),
          ...(body.requirements && {
            requirements: {
              deleteMany: {},
              create: body.requirements.map((r: { type: string; name: string; priority: string }) => ({
                requirementType: r.type,
                // Fix #13: use appropriate normalizer based on type
                name: r.type === 'role' ? normalizeRole(r.name) : normalizeSkill(r.name),
                priority: r.priority,
              })),
            },
          }),
        },
        include: TEAM_PUBLIC_INCLUDE,
      });

      res.json(team);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /v1/events/:event_id/teams/:team_id/finalize ────────────────────
// Team completion is ALWAYS explicitly decided by the team (never from member count).
// Fix #10: Permanent team chat room is created here at finalization time.
router.post('/:event_id/teams/:team_id/finalize', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { team_id, event_id } = req.params;

    // Fix #2: cross-event auth
    await requireTeamInEvent(team_id, event_id);

    await requireTeamMembership(team_id, req.user!.sub, ['owner']);

    const team = await prisma.team.findUnique({
      where: { id: team_id },
      include: { members: { where: { leftAt: null } } },
    });

    if (!team) throw new AppError(404, 'NOT_FOUND', 'Team not found.');
    if (team.status === 'finalized') throw new AppError(409, 'ALREADY_FINALIZED', 'Team is already finalized.');
    if (team.status === 'dissolved') throw new AppError(409, 'TEAM_DISSOLVED', 'Team has been dissolved.');

    // Team must have at least 1 member (the owner)
    if (team.members.length < 1) {
      throw new AppError(409, 'TEAM_EMPTY', 'Cannot finalize an empty team.');
    }

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${team_id}))`;

      const currentTeam = await tx.team.findUnique({
        where: { id: team_id },
        include: { members: { where: { leftAt: null } } },
      });

      if (!currentTeam || currentTeam.eventId !== event_id) {
        throw new AppError(404, 'NOT_FOUND', 'Team not found.');
      }
      if (currentTeam.ownerId !== req.user!.sub ||
          !currentTeam.members.some((member) => member.userId === req.user!.sub && member.leftAt === null)) {
        throw new AppError(403, 'FORBIDDEN', 'You are no longer the owner of this team.');
      }
      if (currentTeam.status === 'finalized') {
        throw new AppError(409, 'ALREADY_FINALIZED', 'Team is already finalized.');
      }
      if (currentTeam.status === 'dissolved') {
        throw new AppError(409, 'TEAM_DISSOLVED', 'Team has been dissolved.');
      }
      if (currentTeam.members.length < 1) {
        throw new AppError(409, 'TEAM_EMPTY', 'Cannot finalize an empty team.');
      }

      // Fix #10: Create the permanent team chat room at finalization
      const permanentChatRoom = await tx.chatRoom.create({ data: { roomType: 'permanent' } });

      // Archive the old provisional chat room if it exists
      if (team.chatRoomId) {
        await tx.chatRoom.update({ where: { id: team.chatRoomId }, data: { status: 'archived' } });
      }

      await tx.team.update({
        where: { id: team_id },
        data: { status: 'finalized', chatRoomId: permanentChatRoom.id },
      });

      // Update all active members to in_finalized_team
      for (const member of team.members) {
        await tx.eventParticipant.update({
          where: { eventId_userId: { eventId: event_id, userId: member.userId } },
          data: { status: 'in_finalized_team' },
        });
      }

      // Cancel all pending requests for this team (no longer recruiting)
      await tx.requestInvitation.updateMany({
        where: { teamId: team_id, status: 'pending' },
        data: { status: 'cancelled' },
      });
    });

    const updated = await prisma.team.findUnique({
      where: { id: team_id },
      include: TEAM_PUBLIC_INCLUDE,
    });

    // Notify all members
    await Promise.all(
      team.members.map((m) =>
        sendNotification({
          userId: m.userId,
          eventId: event_id,
          type: 'team_finalized',
          title: `Team "${team.name}" has been finalized!`,
          body: 'Your team is now official. Check the team chat.',
          data: { team_id },
        })
      )
    );

    res.json({ team: updated });
  } catch (err) {
    next(err);
  }
});

// ─── POST /v1/events/:event_id/teams/:team_id/dissolve ────────────────────
router.post('/:event_id/teams/:team_id/dissolve', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { team_id, event_id } = req.params;

    // Fix #2: cross-event auth
    await requireTeamInEvent(team_id, event_id);

    await requireTeamMembership(team_id, req.user!.sub, ['owner']);

    const team = await prisma.team.findUnique({
      where: { id: team_id },
      include: { members: { where: { leftAt: null } } },
    });

    if (!team) throw new AppError(404, 'NOT_FOUND', 'Team not found.');
    if (team.status === 'finalized' || team.status === 'locked') {
      throw new AppError(409, 'TEAM_FINALIZED', 'Cannot dissolve a finalized or locked team.');
    }
    if (team.status === 'dissolved') throw new AppError(409, 'ALREADY_DISSOLVED', 'Team is already dissolved.');

    await prisma.$transaction(async (tx) => {
      await tx.team.update({ where: { id: team_id }, data: { status: 'dissolved' } });

      // Return all members to looking_for_team
      for (const member of team.members) {
        await tx.eventParticipant.update({
          where: { eventId_userId: { eventId: event_id, userId: member.userId } },
          data: { status: 'looking_for_team', teamId: null },
        });
      }

      // Cancel all pending requests for this team
      await tx.requestInvitation.updateMany({
        where: { teamId: team_id, status: 'pending' },
        data: { status: 'cancelled' },
      });
    });

    // Notify members
    await Promise.all(
      team.members
        .filter((m) => m.userId !== req.user!.sub)
        .map((m) =>
          sendNotification({
            userId: m.userId,
            eventId: event_id,
            type: 'team_dissolved',
            title: `Team "${team.name}" has been dissolved.`,
            body: 'You are now looking for a team again.',
            data: { team_id },
          })
        )
    );

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ─── POST /v1/events/:event_id/teams/:team_id/leave ───────────────────────
router.post('/:event_id/teams/:team_id/leave', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { team_id, event_id } = req.params;
    const userId = req.user!.sub;

    // Fix #2: cross-event auth
    const teamRecord = await requireTeamInEvent(team_id, event_id);

    // Fix #12: Cannot leave a finalized team (members are locked in)
    if (teamRecord.status === 'finalized' || teamRecord.status === 'locked') {
      throw new AppError(409, 'CANNOT_LEAVE_FINALIZED', 'Cannot leave a finalized or locked team. Contact team owner.');
    }

    const membership = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: team_id, userId } },
    });

    if (!membership || membership.leftAt) throw new AppError(404, 'NOT_FOUND', 'You are not a member of this team.');

    const team = await prisma.team.findUnique({
      where: { id: team_id },
      include: { members: { where: { leftAt: null } } },
    });

    if (!team) throw new AppError(404, 'NOT_FOUND', 'Team not found.');

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${team_id}))`;

      const currentTeam = await tx.team.findUnique({
        where: { id: team_id },
        include: { members: { where: { leftAt: null } } },
      });
      if (!currentTeam || currentTeam.eventId !== event_id) {
        throw new AppError(404, 'NOT_FOUND', 'Team not found.');
      }

      const currentMembership = currentTeam.members.find((member) => member.userId === userId);
      if (!currentMembership) {
        throw new AppError(404, 'NOT_FOUND', 'You are not an active team member.');
      }

      await tx.teamMember.update({
        where: { teamId_userId: { teamId: team_id, userId } },
        data: { leftAt: new Date() },
      });

      await tx.eventParticipant.update({
        where: { eventId_userId: { eventId: event_id, userId } },
        data: { status: 'looking_for_team', teamId: null },
      });

      const remainingMembers = currentTeam.members.filter((m) => m.userId !== userId && !m.leftAt);

      if (remainingMembers.length === 0) {
        await tx.team.update({ where: { id: team_id }, data: { status: 'dissolved' } });
      } else if (currentMembership.roleInTeam === 'owner') {
        // Auto-transfer ownership to longest-tenured member
        const newOwner = remainingMembers.sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())[0]!;
        await tx.team.update({ where: { id: team_id }, data: { ownerId: newOwner.userId } });
        await tx.teamMember.update({
          where: { teamId_userId: { teamId: team_id, userId } },
          data: { roleInTeam: 'member' },
        });
        await tx.teamMember.update({
          where: { teamId_userId: { teamId: team_id, userId: newOwner.userId } },
          data: { roleInTeam: 'owner' },
        });
      }
    });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ─── POST /v1/events/:event_id/teams/:team_id/transfer-ownership ──────────
router.post(
  '/:event_id/teams/:team_id/transfer-ownership',
  authenticate,
  validate({ body: transferOwnershipSchema.shape.body }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { team_id, event_id } = req.params;
      const { new_owner_id } = req.body;
      const currentOwnerId = req.user!.sub;

      // Fix #2: cross-event auth
      const teamRecord = await requireTeamInEvent(team_id, event_id);

      // Fix #12: block on finalized teams
      requireMutableTeam(teamRecord);

      await requireTeamMembership(team_id, currentOwnerId, ['owner']);

      const newOwnerMembership = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: team_id, userId: new_owner_id } },
      });

      if (!newOwnerMembership || newOwnerMembership.leftAt) {
        throw new AppError(404, 'NOT_FOUND', 'New owner is not an active team member.');
      }

      await prisma.$transaction(async (tx) => {
        await tx.team.update({ where: { id: team_id }, data: { ownerId: new_owner_id } });
        await tx.teamMember.update({
          where: { teamId_userId: { teamId: team_id, userId: currentOwnerId } },
          data: { roleInTeam: 'member' },
        });
        await tx.teamMember.update({
          where: { teamId_userId: { teamId: team_id, userId: new_owner_id } },
          data: { roleInTeam: 'owner' },
        });
      });

      res.json({ message: 'Ownership transferred successfully.' });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /v1/events/:event_id/teams/:team_id/members/:user_id ──────────
router.delete(
  '/:event_id/teams/:team_id/members/:user_id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { team_id, event_id, user_id } = req.params;
      const requesterId = req.user!.sub;

      if (requesterId === user_id) throw new AppError(400, 'BAD_REQUEST', 'Use /leave to remove yourself.');

      // Fix #2: cross-event auth
      const teamRecord = await requireTeamInEvent(team_id, event_id);

      // Fix #12: block member removal on finalized teams
      requireMutableTeam(teamRecord);

      const requesterMembership = await requireTeamMembership(team_id, requesterId, ['owner', 'admin']);
      const targetMembership = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: team_id, userId: user_id } },
      });

      if (!targetMembership || targetMembership.leftAt) {
        throw new AppError(404, 'NOT_FOUND', 'Target user is not an active team member.');
      }

      // Admins cannot remove owners or other admins
      if (
        requesterMembership.roleInTeam === 'admin' &&
        ['owner', 'admin'].includes(targetMembership.roleInTeam)
      ) {
        throw new AppError(403, 'FORBIDDEN', 'Admins can only remove members.');
      }

      const team = await prisma.team.findUnique({ where: { id: team_id } });
      if (!team) throw new AppError(404, 'NOT_FOUND', 'Team not found.');

      await prisma.$transaction(async (tx) => {
        await tx.teamMember.update({
          where: { teamId_userId: { teamId: team_id, userId: user_id } },
          data: { leftAt: new Date() },
        });
        // User returns to looking_for_team when removed
        await tx.eventParticipant.update({
          where: { eventId_userId: { eventId: event_id, userId: user_id } },
          data: { status: 'looking_for_team', teamId: null },
        });
      });

      await sendNotification({
        userId: user_id,
        eventId: event_id,
        type: 'team_member_left',
        title: `You were removed from team "${team.name}".`,
        body: 'You are now looking for a team again.',
        data: { team_id },
      });

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /v1/events/:event_id/teams/:team_id/candidates ───────────────────
router.get('/:event_id/teams/:team_id/candidates', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { team_id, event_id } = req.params;

    // Fix #2: cross-event auth
    const teamRecord = await requireTeamInEvent(team_id, event_id);

    // Fix #12: no candidate search for finalized teams
    requireMutableTeam(teamRecord);

    await requireTeamMembership(team_id, req.user!.sub, ['owner', 'admin']);

    const team = await prisma.team.findUnique({
      where: { id: team_id },
      include: {
        requirements: true,
        members: {
          where: { leftAt: null },
          include: {
            user: { include: { skills: true, interests: true, preferredRoles: true } },
          },
        },
      },
    });

    if (!team) throw new AppError(404, 'NOT_FOUND', 'Team not found.');

    const event = await prisma.event.findUnique({
      where: { id: event_id },
      include: { requiredSkills: true, requiredRoles: true },
    });

    if (!event) throw new AppError(404, 'NOT_FOUND', 'Event not found.');

    // Load available candidates (looking for team or registered — can still be invited)
    const availableParticipants = await prisma.eventParticipant.findMany({
      where: { eventId: event_id, status: { in: ['looking_for_team', 'registered'] } },
      include: { user: { include: { skills: true, interests: true, preferredRoles: true } } },
    });

    const teamComposition = {
      members: team.members.map((m) => ({
        userId: m.userId,
        displayName: m.user.displayName,
        skills: m.user.skills.map((s) => ({ skillName: s.skillName, proficiency: s.proficiency })),
        interests: m.user.interests.map((i) => ({ interestName: i.interestName })),
        preferredRoles: m.user.preferredRoles.map((r) => ({ roleName: r.roleName, priority: r.priority })),
        registeredAt: new Date(),
        matchmakingRestarts: 0,
      })),
    };

    const candidates = availableParticipants.map((p) => ({
      userId: p.userId,
      displayName: p.user.displayName,
      skills: p.user.skills.map((s) => ({ skillName: s.skillName, proficiency: s.proficiency })),
      interests: p.user.interests.map((i) => ({ interestName: i.interestName })),
      preferredRoles: p.user.preferredRoles.map((r) => ({ roleName: r.roleName, priority: r.priority })),
      registeredAt: p.registeredAt,
      matchmakingRestarts: p.matchmakingRestarts,
    }));

    const constraints = {
      hardSkills: event.requiredSkills.filter((s) => s.constraintType === 'hard').map((s) => s.skillName),
      softSkills: event.requiredSkills.filter((s) => s.constraintType === 'soft').map((s) => s.skillName),
      hardRoles: event.requiredRoles.filter((r) => r.constraintType === 'hard').map((r) => r.roleName),
      softRoles: event.requiredRoles.filter((r) => r.constraintType === 'soft').map((r) => r.roleName),
    };

    const mustHave = team.requirements.filter((r) => r.priority === 'must_have' && r.requirementType === 'skill').map((r) => r.name);
    const niceToHave = team.requirements.filter((r) => r.priority === 'nice_to_have' && r.requirementType === 'skill').map((r) => r.name);
    const requiredRole = team.requirements.find((r) => r.priority === 'must_have' && r.requirementType === 'role')?.name;
    const preferredRole = team.requirements.find((r) => r.priority === 'nice_to_have' && r.requirementType === 'role')?.name;

    const poolUniqueSkills = new Set(candidates.flatMap((c) => c.skills.map((s) => s.skillName))).size;
    const globalExpAvg = candidates.length === 0 ? 0.5 :
      candidates.reduce((sum, c) => {
        const avg = c.skills.reduce((s, sk) => s + sk.proficiency, 0) / Math.max(1, c.skills.length);
        return sum + (avg - 1) / 4;
      }, 0) / candidates.length;

    const ranked = rankCandidates(
      teamComposition, candidates, { mustHave, niceToHave, requiredRole, preferredRole },
      constraints, poolUniqueSkills, globalExpAvg, DEFAULT_WEIGHTS
    );

    // Join back user profiles
    const userMap = new Map(availableParticipants.map((p) => [p.userId, p.user]));
    const result = ranked.slice(0, 20).map((r) => ({
      user: userMap.get(r.userId),
      ...r,
    }));

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

export default router;
