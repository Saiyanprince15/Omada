import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { validate, updateProfileSchema, updateSkillsSchema, updateInterestsSchema, updateRolesSchema } from '../lib/validation';
import { AppError } from '../middleware/errorHandler';
import { normalizeSkill, normalizeInterest, normalizeRole } from '../lib/normalize';

const router = Router();

// ─── Public user profile ───────────────────────────────────────────────────

const PUBLIC_USER_SELECT = {
  id: true,
  displayName: true,
  avatarUrl: true,
  bio: true,
  skills: { select: { skillName: true, skillDisplay: true, proficiency: true, yearsExperience: true } },
  interests: { select: { interestName: true, interestDisplay: true } },
  preferredRoles: { select: { roleName: true, roleDisplay: true, priority: true } },
  createdAt: true,
};

// GET /v1/users/me
router.get('/me', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.sub, deletedAt: null },
      select: {
        ...PUBLIC_USER_SELECT,
        email: true,
        isAdmin: true,
        lastLoginAt: true,
      },
    });

    if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found.');

    res.json(user);
  } catch (err) {
    next(err);
  }
});

// PUT /v1/users/me
router.put(
  '/me',
  authenticate,
  validate({ body: updateProfileSchema.shape.body }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { display_name, bio, avatar_url } = req.body;

      const updated = await prisma.user.update({
        where: { id: req.user!.sub },
        data: {
          ...(display_name !== undefined && { displayName: display_name }),
          ...(bio !== undefined && { bio }),
          ...(avatar_url !== undefined && { avatarUrl: avatar_url }),
        },
        select: PUBLIC_USER_SELECT,
      });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

// PUT /v1/users/me/skills
router.put(
  '/me/skills',
  authenticate,
  validate({ body: updateSkillsSchema.shape.body }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { skills } = req.body;
      const userId = req.user!.sub;

      await prisma.$transaction(async (tx) => {
        await tx.userSkill.deleteMany({ where: { userId } });

        if (skills.length > 0) {
          await tx.userSkill.createMany({
            data: skills.map((s: { skill_display: string; proficiency: number; years_experience?: number }) => ({
              userId,
              skillName: normalizeSkill(s.skill_display),
              skillDisplay: s.skill_display.trim(),
              proficiency: s.proficiency,
              yearsExperience: s.years_experience,
            })),
          });
        }
      });

      const updated = await prisma.user.findUnique({
        where: { id: userId },
        select: { skills: true },
      });

      res.json(updated?.skills ?? []);
    } catch (err) {
      next(err);
    }
  }
);

// PUT /v1/users/me/interests
router.put(
  '/me/interests',
  authenticate,
  validate({ body: updateInterestsSchema.shape.body }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { interests } = req.body;
      const userId = req.user!.sub;

      await prisma.$transaction(async (tx) => {
        await tx.userInterest.deleteMany({ where: { userId } });

        if (interests.length > 0) {
          await tx.userInterest.createMany({
            data: interests.map((i: { interest_display: string }) => ({
              userId,
              interestName: normalizeInterest(i.interest_display),
              interestDisplay: i.interest_display.trim(),
            })),
          });
        }
      });

      const updated = await prisma.user.findUnique({
        where: { id: userId },
        select: { interests: true },
      });

      res.json(updated?.interests ?? []);
    } catch (err) {
      next(err);
    }
  }
);

// PUT /v1/users/me/roles
router.put(
  '/me/roles',
  authenticate,
  validate({ body: updateRolesSchema.shape.body }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { preferred_roles } = req.body;
      const userId = req.user!.sub;

      await prisma.$transaction(async (tx) => {
        await tx.userPreferredRole.deleteMany({ where: { userId } });

        if (preferred_roles.length > 0) {
          await tx.userPreferredRole.createMany({
            data: preferred_roles.map((r: { role_display: string; priority: number }) => ({
              userId,
              roleName: normalizeRole(r.role_display),
              roleDisplay: r.role_display.trim(),
              priority: r.priority,
            })),
          });
        }
      });

      const updated = await prisma.user.findUnique({
        where: { id: userId },
        select: { preferredRoles: true },
      });

      res.json(updated?.preferredRoles ?? []);
    } catch (err) {
      next(err);
    }
  }
);

// GET /v1/users/:id — public profile
router.get('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id, deletedAt: null },
      select: PUBLIC_USER_SELECT,
    });

    if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found.');

    res.json(user);
  } catch (err) {
    next(err);
  }
});

// GET /v1/users/search
router.get('/search', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { event_id, skills, roles, limit = '20', cursor } = req.query as Record<string, string>;

    const skillList = skills ? skills.split(',').map((s) => normalizeSkill(s.trim())) : [];
    const roleList = roles ? roles.split(',').map((r) => normalizeRole(r.trim())) : [];

    const take = Math.min(parseInt(limit), 50);

    let eventFilter: object = {};
    if (event_id) {
      eventFilter = {
        eventParticipations: {
          some: {
            eventId: event_id,
            status: 'looking_for_team',
          },
        },
      };
    }

    const users = await prisma.user.findMany({
      where: {
        deletedAt: null,
        ...eventFilter,
        ...(skillList.length > 0
          ? { skills: { some: { skillName: { in: skillList } } } }
          : {}),
        ...(roleList.length > 0
          ? { preferredRoles: { some: { roleName: { in: roleList } } } }
          : {}),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: {
        ...PUBLIC_USER_SELECT,
        skills: {
          select: { skillName: true, skillDisplay: true, proficiency: true, yearsExperience: true },
        },
        preferredRoles: {
          select: { roleName: true, roleDisplay: true, priority: true },
        },
      },
      take: take + 1,
      orderBy: { id: 'asc' },
    });

    const hasMore = users.length > take;
    const data = hasMore ? users.slice(0, take) : users;
    const nextCursor = hasMore ? data[data.length - 1]?.id : null;

    const enriched = data.map((user) => ({
      user,
      matching_skills: skillList.filter((s) => user.skills.some((us) => us.skillName === s)),
      matching_roles: roleList.filter((r) => user.preferredRoles.some((ur) => ur.roleName === r)),
    }));

    res.json({
      data: enriched,
      pagination: { next_cursor: nextCursor, has_more: hasMore },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
