import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, requireAdmin } from '../middleware/auth';
import { validate, createEventSchema, updateParticipationSchema } from '../lib/validation';
import { AppError } from '../middleware/errorHandler';
import { sendNotification } from '../services/notificationService';
import { normalizeRole, normalizeSkill } from '../lib/normalize';
import { assertEventIsActive, assertEventRegistrationOpen } from '../lib/eventLifecycle';

const router = Router();

// ─── GET /v1/events ────────────────────────────────────────────────────────
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, type, limit = '20', cursor } = req.query as Record<string, string>;
    const take = Math.min(parseInt(limit), 50);

    const events = await prisma.event.findMany({
      where: {
        ...(status ? { status: status as never } : {}),
        ...(type ? { eventType: type as never } : {}),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      include: {
        organizer: { select: { id: true, displayName: true } },
        requiredSkills: true,
        requiredRoles: true,
        _count: { select: { participants: true, teams: true } },
      },
      take: take + 1,
      orderBy: { createdAt: 'desc' },
    });

    const hasMore = events.length > take;
    const data = hasMore ? events.slice(0, take) : events;

    res.json({
      data: data.map((e) => ({
        ...e,
        participant_count: e._count.participants,
        team_count: e._count.teams,
        _count: undefined,
      })),
      pagination: { next_cursor: hasMore ? data[data.length - 1]?.id : null, has_more: hasMore },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /v1/events/:id ────────────────────────────────────────────────────
router.get('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const event = await prisma.event.findUnique({
      where: { id: req.params.id },
      include: {
        organizer: { select: { id: true, displayName: true } },
        requiredSkills: true,
        requiredRoles: true,
        _count: { select: { participants: true, teams: true } },
      },
    });

    if (!event) throw new AppError(404, 'NOT_FOUND', 'Event not found.');

    const lookingCount = await prisma.eventParticipant.count({
      where: { eventId: event.id, status: 'looking_for_team' },
    });

    res.json({
      ...event,
      participant_count: event._count.participants,
      team_count: event._count.teams,
      looking_count: lookingCount,
      _count: undefined,
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /v1/events (admin only) ─────────────────────────────────────────
router.post(
  '/',
  authenticate,
  requireAdmin,
  validate({ body: createEventSchema.shape.body }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body;

      const event = await prisma.event.create({
        data: {
          organizerId: req.user!.sub,
          name: body.name,
          description: body.description,
          eventType: body.event_type,
          registrationOpens: body.registration_opens ? new Date(body.registration_opens) : undefined,
          registrationCloses: body.registration_closes ? new Date(body.registration_closes) : undefined,
          eventStarts: body.event_starts ? new Date(body.event_starts) : undefined,
          eventEnds: body.event_ends ? new Date(body.event_ends) : undefined,
          matchmakingEnabled: body.matchmaking_enabled,
          requiredSkills: {
            create: (body.required_skills ?? []).map((s: { skill_name: string; constraint_type: 'hard' | 'soft' }) => ({
              skillName: normalizeSkill(s.skill_name),
              constraintType: s.constraint_type,
            })),
          },
          requiredRoles: {
            create: (body.required_roles ?? []).map((r: { role_name: string; constraint_type: 'hard' | 'soft' }) => ({
              roleName: normalizeRole(r.role_name),
              constraintType: r.constraint_type,
            })),
          },
        },
        include: { requiredSkills: true, requiredRoles: true },
      });

      res.status(201).json(event);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /v1/events/:id/register ─────────────────────────────────────────
router.post('/:id/register', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const event = await prisma.event.findUnique({ where: { id: req.params.id } });
    if (!event) throw new AppError(404, 'NOT_FOUND', 'Event not found.');
    assertEventRegistrationOpen(event.status);

    const participant = await prisma.eventParticipant.create({
      data: { eventId: event.id, userId: req.user!.sub },
    });

    res.status(201).json({ participant });
  } catch (err) {
    next(err);
  }
});

// ─── GET /v1/events/:id/participation/me ─────────────────────────────────
router.get('/:id/participation/me', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const participation = await prisma.eventParticipant.findUnique({
      where: { eventId_userId: { eventId: req.params.id, userId: req.user!.sub } },
      include: {
        team: { select: { id: true, name: true, status: true } },
        provisionalTeam: { select: { id: true, status: true, expiresAt: true } },
      },
    });

    if (!participation) {
      res.json({ registered: false });
      return;
    }

    res.json({
      registered: true,
      status: participation.status,
      team: participation.team,
      provisional_team: participation.provisionalTeam,
      matchmaking_restarts: participation.matchmakingRestarts,
      last_matchmaking_at: participation.lastMatchmakingAt,
    });
  } catch (err) {
    next(err);
  }
});

// ─── PUT /v1/events/:id/participation ─────────────────────────────────────
router.put(
  '/:id/participation',
  authenticate,
  validate({ body: updateParticipationSchema.shape.body }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status } = req.body;
      const userId = req.user!.sub;
      const eventId = req.params.id;

      const event = await prisma.event.findUnique({ where: { id: eventId } });
      if (!event) throw new AppError(404, 'NOT_FOUND', 'Event not found.');
      assertEventIsActive(event.status);

      const participant = await prisma.eventParticipant.findUnique({
        where: { eventId_userId: { eventId, userId } },
      });

      if (!participant) throw new AppError(404, 'NOT_FOUND', 'You are not registered for this event.');

      // Validate allowed transitions
      const allowed: Record<string, string[]> = {
        registered: ['looking_for_team', 'withdrawn'],
        looking_for_team: ['registered', 'withdrawn'],
        // in_forming_team and in_finalized_team transitions are handled by team routes
      };

      const allowedTransitions = allowed[participant.status] ?? [];
      if (!allowedTransitions.includes(status)) {
        throw new AppError(
          409,
          'INVALID_TRANSITION',
          `Cannot transition from ${participant.status} to ${status}.`
        );
      }

      await prisma.eventParticipant.update({
        where: { eventId_userId: { eventId, userId } },
        data: { status },
      });

      res.json({ status });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /v1/events/:id/participants ──────────────────────────────────────
router.get('/:id/participants', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, limit = '20', cursor } = req.query as Record<string, string>;
    const take = Math.min(parseInt(limit), 50);

    const participants = await prisma.eventParticipant.findMany({
      where: {
        eventId: req.params.id,
        ...(status ? { status: status as never } : {}),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      include: {
        user: {
          select: {
            id: true, displayName: true, avatarUrl: true, bio: true,
            skills: { select: { skillName: true, skillDisplay: true, proficiency: true } },
            preferredRoles: { select: { roleName: true, roleDisplay: true, priority: true } },
          },
        },
      },
      take: take + 1,
      orderBy: { registeredAt: 'asc' },
    });

    const hasMore = participants.length > take;
    const data = hasMore ? participants.slice(0, take) : participants;

    res.json({
      data,
      pagination: { next_cursor: hasMore ? data[data.length - 1]?.id : null, has_more: hasMore },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
