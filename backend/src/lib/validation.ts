import { z } from 'zod';

// ─── Auth ──────────────────────────────────────────────────────────────────

export const registerSchema = z.object({
  body: z.object({
    email: z.string().email().max(255).transform((v) => v.toLowerCase().trim()),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .max(128)
      .regex(/[A-Z]/, 'Must contain an uppercase letter')
      .regex(/[a-z]/, 'Must contain a lowercase letter')
      .regex(/[0-9]/, 'Must contain a digit')
      .regex(/[^A-Za-z0-9]/, 'Must contain a special character'),
    display_name: z.string().min(2).max(100).trim(),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email: z.string().email().transform((v) => v.toLowerCase().trim()),
    password: z.string().min(1),
  }),
});

export const refreshSchema = z.object({
  body: z.object({
    refresh_token: z.string().min(1),
  }),
});

// ─── Profile ───────────────────────────────────────────────────────────────

export const updateProfileSchema = z.object({
  body: z.object({
    display_name: z.string().min(2).max(100).trim().optional(),
    bio: z.string().max(2000).optional(),
    avatar_url: z.string().url().optional().nullable(),
  }),
});

export const skillSchema = z.object({
  skill_display: z.string().min(1).max(100).trim(),
  proficiency: z.number().int().min(1).max(5),
  years_experience: z.number().min(0).max(50).optional(),
});

export const updateSkillsSchema = z.object({
  body: z.object({
    skills: z.array(skillSchema),
  }),
});

export const updateInterestsSchema = z.object({
  body: z.object({
    interests: z.array(
      z.object({ interest_display: z.string().min(1).max(100).trim() })
    ),
  }),
});

export const updateRolesSchema = z.object({
  body: z.object({
    preferred_roles: z.array(
      z.object({
        role_display: z.string().min(1).max(100).trim(),
        priority: z.number().int().min(1).max(10).default(1),
      })
    ),
  }),
});

// ─── Events ────────────────────────────────────────────────────────────────

export const createEventSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(200).trim(),
    description: z.string().max(5000).optional(),
    event_type: z.enum(['hackathon', 'academic_project', 'competition', 'research_project', 'other']),
    registration_opens: z.string().datetime().optional(),
    registration_closes: z.string().datetime().optional(),
    event_starts: z.string().datetime().optional(),
    event_ends: z.string().datetime().optional(),
    matchmaking_enabled: z.boolean().default(true),
    required_skills: z
      .array(
        z.object({
          skill_name: z.string().min(1).max(100).trim(),
          constraint_type: z.enum(['hard', 'soft']),
        })
      )
      .optional(),
    required_roles: z
      .array(
        z.object({
          role_name: z.string().min(1).max(100).trim(),
          constraint_type: z.enum(['hard', 'soft']),
        })
      )
      .optional(),
  }),
});

export const updateParticipationSchema = z.object({
  body: z.object({
    status: z.enum(['looking_for_team', 'registered', 'withdrawn']),
  }),
});

// ─── Teams ─────────────────────────────────────────────────────────────────

export const createTeamSchema = z.object({
  params: z.object({ event_id: z.string().uuid() }),
  body: z.object({
    name: z.string().min(2).max(200).trim(),
    description: z.string().max(5000).optional(),
    project_idea: z.string().max(5000).optional(),
    requirements: z
      .array(
        z.object({
          type: z.enum(['skill', 'role']),
          name: z.string().min(1).max(100).trim(),
          priority: z.enum(['must_have', 'nice_to_have']),
        })
      )
      .optional(),
  }),
});

export const updateTeamSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(200).trim().optional(),
    description: z.string().max(5000).optional(),
    project_idea: z.string().max(5000).optional(),
    requirements: z
      .array(
        z.object({
          type: z.enum(['skill', 'role']),
          name: z.string().min(1).max(100).trim(),
          priority: z.enum(['must_have', 'nice_to_have']),
        })
      )
      .optional(),
  }),
});

export const transferOwnershipSchema = z.object({
  body: z.object({ new_owner_id: z.string().uuid() }),
});

// ─── Requests / Invitations ────────────────────────────────────────────────

export const createRequestSchema = z.object({
  params: z.object({ event_id: z.string().uuid() }),
  body: z
    .discriminatedUnion('type', [
      z.object({
        type: z.literal('join_request'),
        team_id: z.string().uuid(),
        message: z.string().max(500).optional(),
      }),
      z.object({
        type: z.literal('team_invite'),
        recipient_id: z.string().uuid(),
        team_id: z.string().uuid(),
        message: z.string().max(500).optional(),
      }),
      z.object({
        type: z.literal('personal_invite'),
        recipient_id: z.string().uuid(),
        team_id: z.string().uuid(),
        message: z.string().max(500).optional(),
      }),
    ]),
});

export const respondRequestSchema = z.object({
  body: z.object({
    action: z.enum(['accept', 'reject', 'cancel']),
  }),
});

// ─── Provisional teams ─────────────────────────────────────────────────────

export const respondProvisionalSchema = z.object({
  body: z.object({
    action: z.enum(['accept', 'reject']),
  }),
});

// ─── Matchmaking ───────────────────────────────────────────────────────────

export const runMatchmakingSchema = z.object({
  body: z.object({
    weights: z
      .object({
        skill_diversity: z.number().min(0).max(1),
        skill_coverage: z.number().min(0).max(1),
        role_coverage: z.number().min(0).max(1),
        experience_balance: z.number().min(0).max(1),
        interest_compatibility: z.number().min(0).max(1),
        preference_satisfaction: z.number().min(0).max(1),
      })
      .optional(),
  }).optional(),
});

// ─── Chat ──────────────────────────────────────────────────────────────────

export const sendMessageSchema = z.object({
  body: z.object({
    content: z.string().min(1).max(5000).trim(),
  }),
});

// ─── Validation helper ─────────────────────────────────────────────────────

import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';

type RequestParts = {
  body?: ZodSchema;
  params?: ZodSchema;
  query?: ZodSchema;
};

export function validate(schemas: RequestParts) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      if (schemas.params) {
        req.params = schemas.params.parse(req.params) as typeof req.params;
      }
      if (schemas.query) {
        req.query = schemas.query.parse(req.query);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
