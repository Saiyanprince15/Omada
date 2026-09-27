import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { validate, createEventSchema } from '../lib/validation';
import { AppError } from '../middleware/errorHandler';
import { normalizeRole, normalizeSkill } from '../lib/normalize';

const router = Router();

// Every authenticated user can become an organizer by creating an event.
// There is no admin approval gate for event hosting.
router.get('/events', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const events = await prisma.event.findMany({
      where: { organizerId: req.user!.sub },
      include: {
        requiredSkills: true,
        requiredRoles: true,
        _count: { select: { participants: true, teams: { where: { status: { not: 'dissolved' } } } } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      data: events.map((event) => ({
        ...event,
        participant_count: event._count.participants,
        team_count: event._count.teams,
        _count: undefined,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/events',
  authenticate,
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
          status: body.status ?? 'registration_open',
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

router.put('/events/:event_id/status', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { event_id } = req.params;
    const { status } = req.body;
    if (!['draft', 'registration_open', 'registration_closed', 'in_progress', 'completed', 'cancelled'].includes(status)) {
      throw new AppError(400, 'INVALID_STATUS', 'Invalid event status.');
    }

    const event = await prisma.event.findUnique({ where: { id: event_id } });
    if (!event) throw new AppError(404, 'NOT_FOUND', 'Event not found.');
    if (event.organizerId !== req.user!.sub && !req.user!.isAdmin) {
      throw new AppError(403, 'FORBIDDEN', 'Organizer access required.');
    }

    const updated = await prisma.event.update({ where: { id: event_id }, data: { status } });
    res.json({ event: updated });
  } catch (err) {
    next(err);
  }
});

export default router;
