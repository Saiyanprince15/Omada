import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { runAutoMatch, DEFAULT_WEIGHTS, MatchWeights } from '../services/matchingEngine';
import { redisRateLimit } from '../middleware/rateLimiter';
import { sendNotification } from '../services/notificationService';
import { assertEventMatchmakingOpen } from '../lib/eventLifecycle';

const router = Router({ mergeParams: true });

const MATCHMAKING_RATE_LIMIT = redisRateLimit('matchmaking_enter', 5, 60 * 60 * 1000);

async function launchMatchmaking(eventId: string, weights: MatchWeights = DEFAULT_WEIGHTS) {
  const round = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${eventId}))`;

    const activeRound = await tx.matchingRound.findFirst({
      where: { eventId, status: 'running' },
      orderBy: { startedAt: 'desc' },
    });

    if (activeRound) {
      const stale = Date.now() - activeRound.startedAt.getTime() > 30 * 60 * 1000;
      if (!stale) return null;
      await tx.matchingRound.update({
        where: { id: activeRound.id },
        data: { status: 'failed', completedAt: new Date() },
      });
    }

    const poolSize = await tx.eventParticipant.count({
      where: { eventId, status: 'in_matchmaking' },
    });

    // Avoid proposing a one-person auto-match. There is still no team-size
    // rule: this is only a queue-start threshold.
    if (poolSize < 2) return null;

    return tx.matchingRound.create({
      data: {
        eventId,
        status: 'running',
        participantsCount: poolSize,
        algorithmParams: weights as object,
      },
    });
  });

  if (!round) return null;

  runAutoMatch(eventId, round.id, weights)
    .then(async (result) => {
      const provisionalTeams = await prisma.provisionalTeam.findMany({
        where: { eventId, createdByRound: result.roundId },
        include: { members: true },
      });

      for (const pt of provisionalTeams) {
        for (const member of pt.members) {
          await sendNotification({
            userId: member.userId,
            eventId,
            type: 'match_proposed',
            title: "You've been matched with a team!",
            body: 'Review your provisional team and accept or decline.',
            data: { provisional_team_id: pt.id, event_id: eventId },
          });
        }
      }

      for (const unmatchedUserId of result.unmatched) {
        await sendNotification({
          userId: unmatchedUserId,
          eventId,
          type: 'match_proposed',
          title: 'Matchmaking update',
          body: 'Not enough compatible participants were available for automatic matching. You remain in the discovery pool.',
          data: { round_id: result.roundId, event_id: eventId },
        });
      }
    })
    .catch(async (err) => {
      console.error('[matchmaking] Error running auto-match:', err);
      await prisma.matchingRound.update({
        where: { id: round.id },
        data: { status: 'failed', completedAt: new Date() },
      }).catch((updateErr) => console.error('[matchmaking] Failed to mark round failed:', updateErr));
    });

  return round;
}

// ─── POST /v1/events/:event_id/matchmaking/enter ──────────────────────────
// Only `looking_for_team` users may enter matchmaking.
// Prevents concurrent placement into multiple rounds.
router.post(
  '/:event_id/matchmaking/enter',
  authenticate,
  MATCHMAKING_RATE_LIMIT,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { event_id } = req.params;
      const userId = req.user!.sub;

      const participant = await prisma.eventParticipant.findUnique({
        where: { eventId_userId: { eventId: event_id, userId } },
      });

      if (!participant) throw new AppError(404, 'NOT_FOUND', 'You are not registered for this event.');

      // Only allow from looking_for_team
      if (participant.status !== 'looking_for_team') {
        throw new AppError(409, 'INVALID_STATE', `Cannot enter matchmaking from state: ${participant.status}.`);
      }

      const event = await prisma.event.findUnique({ where: { id: event_id } });
      if (!event || !event.matchmakingEnabled) {
        throw new AppError(409, 'MATCHMAKING_DISABLED', 'Auto-matchmaking is not enabled for this event.');
      }
      assertEventMatchmakingOpen(event.status);

      // Snapshot profile at time of entry
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { skills: true, interests: true, preferredRoles: true },
      });

      const profileSnapshot = {
        skills: user?.skills ?? [],
        interests: user?.interests ?? [],
        preferredRoles: user?.preferredRoles ?? [],
      };

      await prisma.eventParticipant.update({
        where: { eventId_userId: { eventId: event_id, userId } },
        data: {
          status: 'in_matchmaking',
          profileSnapshot: profileSnapshot as object,
          lastMatchmakingAt: new Date(),
          matchmakingRestarts: { increment: 1 },
        },
      });

      const queueSizeAfterJoin = await prisma.eventParticipant.count({
        where: { eventId: event_id, status: 'in_matchmaking' },
      });

      void launchMatchmaking(event_id);

      res.json({
        status: 'in_matchmaking',
        position_in_queue: queueSizeAfterJoin,
        estimated_wait: queueSizeAfterJoin >= 2
          ? 'Auto-match is being prepared.'
          : 'Waiting for another participant to join auto-match.',
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /v1/events/:event_id/matchmaking/leave ──────────────────────────
router.post('/:event_id/matchmaking/leave', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { event_id } = req.params;
    const userId = req.user!.sub;

    const participant = await prisma.eventParticipant.findUnique({
      where: { eventId_userId: { eventId: event_id, userId } },
    });

    if (!participant || participant.status !== 'in_matchmaking') {
      throw new AppError(409, 'NOT_IN_MATCHMAKING', 'You are not currently in the matchmaking queue.');
    }

    await prisma.eventParticipant.update({
      where: { eventId_userId: { eventId: event_id, userId } },
      data: { status: 'looking_for_team' },
    });

    res.json({ status: 'looking_for_team' });
  } catch (err) {
    next(err);
  }
});

// ─── GET /v1/events/:event_id/matchmaking/status ──────────────────────────
router.get('/:event_id/matchmaking/status', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { event_id } = req.params;
    const userId = req.user!.sub;

    const participant = await prisma.eventParticipant.findUnique({
      where: { eventId_userId: { eventId: event_id, userId } },
    });

    if (!participant) throw new AppError(404, 'NOT_FOUND', 'You are not registered for this event.');

    const queueSize = await prisma.eventParticipant.count({
      where: { eventId: event_id, status: 'in_matchmaking' },
    });

    res.json({
      your_status: participant.status,
      queue_size: queueSize,
      last_matchmaking_at: participant.lastMatchmakingAt,
      restarts_count: participant.matchmakingRestarts,
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /v1/events/:event_id/matchmaking/run (organizer/admin) ──────────
router.post('/:event_id/matchmaking/run', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { event_id } = req.params;
    const userId = req.user!.sub;

    // Must be organizer or platform admin
    const event = await prisma.event.findUnique({ where: { id: event_id } });
    if (!event) throw new AppError(404, 'NOT_FOUND', 'Event not found.');
    if (event.organizerId !== userId && !req.user!.isAdmin) {
      throw new AppError(403, 'FORBIDDEN', 'Only the event organizer can trigger matchmaking.');
    }


    const weights: MatchWeights = req.body?.weights
      ? {
          skillDiversity: req.body.weights.skill_diversity ?? DEFAULT_WEIGHTS.skillDiversity,
          skillCoverage: req.body.weights.skill_coverage ?? DEFAULT_WEIGHTS.skillCoverage,
          roleCoverage: req.body.weights.role_coverage ?? DEFAULT_WEIGHTS.roleCoverage,
          experienceBalance: req.body.weights.experience_balance ?? DEFAULT_WEIGHTS.experienceBalance,
          interestCompatibility: req.body.weights.interest_compatibility ?? DEFAULT_WEIGHTS.interestCompatibility,
          preferenceSatisfaction: req.body.weights.preference_satisfaction ?? DEFAULT_WEIGHTS.preferenceSatisfaction,
        }
      : DEFAULT_WEIGHTS;

    const round = await launchMatchmaking(event_id, weights);
    if (!round) {
      throw new AppError(409, 'MATCHMAKING_ALREADY_RUNNING', 'Matchmaking is already running or not enough participants are queued.');
    }

    res.status(202).json({
      round_id: round.id,
      status: 'running',
      participants_count: round.participantsCount,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
