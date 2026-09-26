import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { validate, createTeamSchema, updateTeamSchema, transferOwnershipSchema } from '../lib/validation';
import { AppError } from '../middleware/errorHandler';
import { sendNotification } from '../services/notificationService';
import { rankCandidates, DEFAULT_WEIGHTS } from '../services/matchingEngine';
import { normalizeSkill } from '../lib/normalize';
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

// ─── POST /v1/events/:event_id/teams ──────────────────────────────────────
// Creates a manual team. Owner is placed into `in_forming_team` state.
// Team completion must be explicitly decided (finalize endpoint).
router.post(
  '/:event_id/teams',
  authenticate,
  validate({ body: createTeamSchema.shape.body }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { event_id } = req.params;
      const userId = req.user!.sub;

      const participant = await prisma.eventParticipant.findUnique({
        where: { eventId_userId: { eventId: event_id, userId } },
      });

      if (!participant) throw new AppError(403, 'NOT_REGISTERED', 'You must register for the event first.');

      // Only allow team creation from states where the user is available
      const allowedStates = ['registered', 'looking_for_team'];
      if (!allowedStates.includes(participant.status)) {
        throw new AppError(409, 'INVALID_STATE', `Cannot create a team from state: ${participant.status}.`);
      }

      const event = await prisma.event.findUnique({ where: { id: event_id } });
      if (!event) throw new AppError(404, 'NOT_FOUND', 'Event not found.');

      const body = req.body;

      const team = await prisma.$transaction(async (tx) => {
        const chatRoom = await tx.chatRoom.create({ data: { roomType: 'permanent' } });

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
                name: normalizeSkill(r.name),
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
      await requireTeamMembership(req.params.team_id, req.user!.sub, ['owner', 'admin']);

      const body = req.body;
      const team = await prisma.team.update({
        where: { id: req.params.team_id },
        data: {
          ...(body.name && { name: body.name }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.project_idea !== undefined && { projectIdea: body.project_idea }),
          ...(body.requirements && {
            requirements: {
              deleteMany: {},
              create: body.requirements.map((r: { type: string; name: string; priority: string }) => ({
                requirementType: r.type,
                name: normalizeSkill(r.name),
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
router.post('/:event_id/teams/:team_id/finalize', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { team_id, event_id } = req.params;
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
      await tx.team.update({
        where: { id: team_id },
        data: { status: 'finalized' },
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
    await requireTeamMembership(team_id, req.user!.sub, ['owner']);

    const team = await prisma.team.findUnique({
      where: { id: team_id },
      include: { members: { where: { leftAt: null } } },
    });

    if (!team) throw new AppError(404, 'NOT_FOUND', 'Team not found.');
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

    const membership = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: team_id, userId } },
    });

    if (!membership || membership.leftAt) throw new AppError(404, 'NOT_FOUND', 'You are not a member of this team.');

    const team = await prisma.team.findUnique({
      where: { id: team_id },
      include: { members: { where: { leftAt: null } } },
    });

    if (!team) throw new AppError(404, 'NOT_FOUND', 'Team not found.');

    // Cannot leave a finalized team — must use dissolve or be removed
    if (team.status === 'finalized' && membership.roleInTeam === 'owner') {
      throw new AppError(409, 'CANNOT_LEAVE_FINALIZED', 'Team owner cannot leave a finalized team. Dissolve the team instead.');
    }

    await prisma.$transaction(async (tx) => {
      await tx.teamMember.update({
        where: { teamId_userId: { teamId: team_id, userId } },
        data: { leftAt: new Date() },
      });

      await tx.eventParticipant.update({
        where: { eventId_userId: { eventId: event_id, userId } },
        data: { status: 'looking_for_team', teamId: null },
      });

      const remainingMembers = team.members.filter((m) => m.userId !== userId && !m.leftAt);

      if (remainingMembers.length === 0) {
        // Dissolve if no members left
        await tx.team.update({ where: { id: team_id }, data: { status: 'dissolved' } });
      } else if (membership.roleInTeam === 'owner') {
        // Auto-transfer ownership to longest-tenured member
        const newOwner = remainingMembers.sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())[0]!;
        await tx.team.update({ where: { id: team_id }, data: { ownerId: newOwner.userId } });
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
      const { team_id } = req.params;
      const { new_owner_id } = req.body;
      const currentOwnerId = req.user!.sub;

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

    // Load available candidates (looking for team or in forming teams — can still be invited)
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
