import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, requireAdmin } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

const router = Router();

// ─── GET /v1/admin/events/:event_id/dashboard ─────────────────────────────
router.get('/events/:event_id/dashboard', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { event_id } = req.params;
    const userId = req.user!.sub;

    const event = await prisma.event.findUnique({ where: { id: event_id } });
    if (!event) throw new AppError(404, 'NOT_FOUND', 'Event not found.');
    if (event.organizerId !== userId && !req.user!.isAdmin) {
      throw new AppError(403, 'FORBIDDEN', 'Organizer access required.');
    }

    const [
      participantCount,
      lookingCount,
      inMatchmakingCount,
      inProvisionalCount,
      finalizedCount,
      teamCount,
      pendingReports,
    ] = await Promise.all([
      prisma.eventParticipant.count({ where: { eventId: event_id } }),
      prisma.eventParticipant.count({ where: { eventId: event_id, status: 'looking_for_team' } }),
      prisma.eventParticipant.count({ where: { eventId: event_id, status: 'in_matchmaking' } }),
      prisma.eventParticipant.count({ where: { eventId: event_id, status: 'in_provisional_team' } }),
      prisma.eventParticipant.count({ where: { eventId: event_id, status: 'in_finalized_team' } }),
      prisma.team.count({ where: { eventId: event_id, status: { not: 'dissolved' } } }),
      prisma.eventParticipant.count({ where: { eventId: event_id, status: 'withdrawn' } }),
    ]);

    // Skill distribution
    const skillCounts = await prisma.userSkill.groupBy({
      by: ['skillName'],
      where: {
        user: {
          eventParticipations: { some: { eventId: event_id } },
        },
      },
      _count: { skillName: true },
      orderBy: { _count: { skillName: 'desc' } },
      take: 20,
    });

    // Recent matchmaking rounds
    const recentRounds = await prisma.matchingRound.findMany({
      where: { eventId: event_id },
      orderBy: { startedAt: 'desc' },
      take: 5,
    });

    // Teams
    const teams = await prisma.team.findMany({
      where: { eventId: event_id },
      include: {
        members: { where: { leftAt: null }, select: { userId: true, roleInTeam: true } },
        _count: { select: { members: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      event: { id: event.id, name: event.name, status: event.status },
      participants: {
        total: participantCount,
        looking: lookingCount,
        in_matchmaking: inMatchmakingCount,
        in_provisional: inProvisionalCount,
        finalized: finalizedCount,
        withdrawn: pendingReports,
      },
      teams: {
        total: teamCount,
        list: teams.map((t) => ({
          id: t.id,
          name: t.name,
          status: t.status,
          member_count: t.members.length,
          max_size: t.maxSize,
        })),
      },
      skill_distribution: Object.fromEntries(
        skillCounts.map((s) => [s.skillName, s._count.skillName])
      ),
      recent_rounds: recentRounds,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /v1/admin/events ─────────────────────────────────────────────────
router.get('/events', authenticate, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const events = await prisma.event.findMany({
      include: {
        organizer: { select: { id: true, displayName: true, email: true } },
        _count: { select: { participants: true, teams: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ data: events });
  } catch (err) {
    next(err);
  }
});

// ─── PUT /v1/admin/events/:event_id/status ────────────────────────────────
router.put('/events/:event_id/status', authenticate, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status } = req.body;

    const event = await prisma.event.update({
      where: { id: req.params.event_id },
      data: { status },
    });

    res.json({ event });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /v1/admin/events/:event_id/teams/:team_id ─────────────────────
router.delete('/events/:event_id/teams/:team_id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { event_id, team_id } = req.params;
    const userId = req.user!.sub;

    const event = await prisma.event.findUnique({ where: { id: event_id } });
    if (!event) throw new AppError(404, 'NOT_FOUND', 'Event not found.');
    if (event.organizerId !== userId && !req.user!.isAdmin) {
      throw new AppError(403, 'FORBIDDEN', 'Organizer access required.');
    }

    const team = await prisma.team.findUnique({
      where: { id: team_id },
      include: { members: { where: { leftAt: null } } },
    });

    if (!team) throw new AppError(404, 'NOT_FOUND', 'Team not found.');

    await prisma.$transaction(async (tx) => {
      await tx.team.update({ where: { id: team_id }, data: { status: 'dissolved' } });
      for (const member of team.members) {
        await tx.eventParticipant.update({
          where: { eventId_userId: { eventId: event_id, userId: member.userId } },
          data: { status: 'looking_for_team', teamId: null },
        });
      }
    });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
