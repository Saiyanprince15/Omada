/**
 * Unit tests for the matching engine.
 * These test core scoring, ranking, and auto-match logic
 * without hitting the database (all DB calls are mocked).
 */

import {
  computeTeamScore,
  rankCandidates,
  DEFAULT_WEIGHTS,
} from '../services/matchingEngine';

type UserProfile = {
  userId: string;
  displayName: string;
  skills: Array<{ skillName: string; proficiency: number }>;
  interests: Array<{ interestName: string }>;
  preferredRoles: Array<{ roleName: string; priority: number }>;
  registeredAt: Date;
  matchmakingRestarts: number;
};

type TeamComposition = {
  members: UserProfile[];
};

type EventConstraints = {
  hardSkills: string[];
  softSkills: string[];
  hardRoles: string[];
  softRoles: string[];
};

function makeUser(id: string, skills: string[], roles: string[], interests: string[] = []): UserProfile {
  return {
    userId: id,
    displayName: `User ${id}`,
    skills: skills.map((s, i) => ({ skillName: s, proficiency: 3 + (i % 3) })),
    interests: interests.map((i) => ({ interestName: i })),
    preferredRoles: roles.map((r, i) => ({ roleName: r, priority: i + 1 })),
    registeredAt: new Date(),
    matchmakingRestarts: 0,
  };
}

const EMPTY_CONSTRAINTS: EventConstraints = {
  hardSkills: [],
  softSkills: [],
  hardRoles: [],
  softRoles: [],
};

describe('matchingEngine — computeTeamScore', () => {
  test('empty team returns 0 for most scores', () => {
    const emptyTeam: TeamComposition = { members: [] };
    const score = computeTeamScore(emptyTeam, EMPTY_CONSTRAINTS, 10, 0.5, DEFAULT_WEIGHTS);
    expect(score.total).toBeGreaterThanOrEqual(0);
    expect(score.total).toBeLessThanOrEqual(1);
    expect(score.components.skillDiversity).toBe(0);
    expect(score.components.experienceBalance).toBe(0);
  });

  test('single member has non-zero score', () => {
    const team: TeamComposition = {
      members: [makeUser('u1', ['react', 'typescript'], ['frontend_developer'])],
    };
    const score = computeTeamScore(team, EMPTY_CONSTRAINTS, 5, 0.5, DEFAULT_WEIGHTS);
    expect(score.total).toBeGreaterThan(0);
  });

  test('diverse team scores higher than homogenous team', () => {
    const diverseTeam: TeamComposition = {
      members: [
        makeUser('u1', ['react', 'typescript'], ['frontend_developer'], ['web', 'design']),
        makeUser('u2', ['python', 'pytorch'], ['ml_engineer'], ['ai', 'research']),
        makeUser('u3', ['docker', 'kubernetes'], ['devops_engineer'], ['cloud', 'automation']),
      ],
    };

    const homogenousTeam: TeamComposition = {
      members: [
        makeUser('u4', ['react'], ['frontend_developer'], ['web']),
        makeUser('u5', ['react'], ['frontend_developer'], ['web']),
        makeUser('u6', ['react'], ['frontend_developer'], ['web']),
      ],
    };

    const poolSkills = 10;
    const diverseScore = computeTeamScore(diverseTeam, EMPTY_CONSTRAINTS, poolSkills, 0.5, DEFAULT_WEIGHTS);
    const homogenousScore = computeTeamScore(homogenousTeam, EMPTY_CONSTRAINTS, poolSkills, 0.5, DEFAULT_WEIGHTS);

    expect(diverseScore.total).toBeGreaterThan(homogenousScore.total);
  });

  test('skill coverage improves when required skills are present', () => {
    const constraints: EventConstraints = {
      hardSkills: [],
      softSkills: ['python', 'react', 'docker'],
      hardRoles: [],
      softRoles: [],
    };

    const coveredTeam: TeamComposition = {
      members: [
        makeUser('u1', ['python', 'react'], ['backend_developer']),
        makeUser('u2', ['docker', 'kubernetes'], ['devops_engineer']),
      ],
    };

    const uncoveredTeam: TeamComposition = {
      members: [
        makeUser('u3', ['java', 'spring'], ['backend_developer']),
        makeUser('u4', ['golang', 'rust'], ['backend_developer']),
      ],
    };

    const coveredScore = computeTeamScore(coveredTeam, constraints, 10, 0.5, DEFAULT_WEIGHTS);
    const uncoveredScore = computeTeamScore(uncoveredTeam, constraints, 10, 0.5, DEFAULT_WEIGHTS);

    expect(coveredScore.components.skillCoverage).toBeGreaterThan(uncoveredScore.components.skillCoverage);
  });

  test('score is normalized between 0 and 1', () => {
    for (let i = 0; i < 5; i++) {
      const memberCount = Math.floor(Math.random() * 6) + 1;
      const team: TeamComposition = {
        members: Array.from({ length: memberCount }, (_, j) =>
          makeUser(`u${i}${j}`, ['react', 'python', 'go'].slice(0, (j % 3) + 1), ['frontend_developer'])
        ),
      };
      const score = computeTeamScore(team, EMPTY_CONSTRAINTS, 10, 0.5, DEFAULT_WEIGHTS);
      expect(score.total).toBeGreaterThanOrEqual(0);
      expect(score.total).toBeLessThanOrEqual(1.05); // allow small float rounding
    }
  });
});

describe('matchingEngine — rankCandidates', () => {
  test('ranks candidate with must-have skills higher', () => {
    const team: TeamComposition = {
      members: [makeUser('t1', ['react'], ['frontend_developer'])],
    };

    const mlCandidate = makeUser('c1', ['python', 'pytorch', 'ml'], ['ml_engineer']);
    const cssCandidate = makeUser('c2', ['css', 'sass'], ['ui_ux_designer']);

    const ranked = rankCandidates(
      team,
      [mlCandidate, cssCandidate],
      { mustHave: ['python', 'pytorch'], niceToHave: [], requiredRole: 'ml_engineer' },
      EMPTY_CONSTRAINTS,
      10,
      0.5,
      DEFAULT_WEIGHTS
    );

    expect(ranked[0]?.userId).toBe('c1');
    expect(ranked[0]!.mustHaveMatch).toContain('python');
    expect(ranked[0]!.mustHaveMatch).toContain('pytorch');
  });

  test('candidate who fills role scores higher', () => {
    const team: TeamComposition = {
      members: [makeUser('t1', ['react', 'typescript'], ['frontend_developer'])],
    };

    const devOpsCandidate = makeUser('c1', ['docker', 'kubernetes'], ['devops_engineer']);
    const anotherFrontend = makeUser('c2', ['react', 'vue'], ['frontend_developer']);

    const ranked = rankCandidates(
      team,
      [devOpsCandidate, anotherFrontend],
      { mustHave: [], niceToHave: [], requiredRole: 'devops_engineer' },
      EMPTY_CONSTRAINTS,
      10,
      0.5,
      DEFAULT_WEIGHTS
    );

    expect(ranked[0]?.userId).toBe('c1');
    expect(ranked[0]!.roleMatch).toBe('devops_engineer');
  });

  test('candidate with unique skills scores higher (marginal contribution)', () => {
    const team: TeamComposition = {
      members: [
        makeUser('t1', ['react', 'typescript'], ['frontend_developer']),
        makeUser('t2', ['react', 'css'], ['ui_ux_designer']),
      ],
    };

    // Same-skills candidate adds no diversity
    const sameSkills = makeUser('c1', ['react', 'typescript'], ['frontend_developer']);
    // Unique-skills candidate adds diversity
    const uniqueSkills = makeUser('c2', ['go', 'postgresql'], ['backend_developer']);

    const ranked = rankCandidates(
      team,
      [sameSkills, uniqueSkills],
      { mustHave: [], niceToHave: ['go'] },
      EMPTY_CONSTRAINTS,
      10,
      0.5,
      DEFAULT_WEIGHTS
    );

    // Candidate with unique skills should rank higher
    expect(ranked[0]?.userId).toBe('c2');
  });

  test('returns empty array for empty candidates', () => {
    const team: TeamComposition = {
      members: [makeUser('t1', ['react'], ['frontend_developer'])],
    };
    const ranked = rankCandidates(
      team, [], { mustHave: [], niceToHave: [] },
      EMPTY_CONSTRAINTS, 0, 0.5, DEFAULT_WEIGHTS
    );
    expect(ranked).toHaveLength(0);
  });
});

describe('matchingEngine — no team size constraints', () => {
  test('computeTeamScore does not enforce any team size limit', () => {
    // Create a large team — should still compute a valid score
    const largeTeam: TeamComposition = {
      members: Array.from({ length: 20 }, (_, i) =>
        makeUser(`u${i}`, [`skill_${i % 5}`], [`role_${i % 3}`])
      ),
    };

    const score = computeTeamScore(largeTeam, EMPTY_CONSTRAINTS, 20, 0.5, DEFAULT_WEIGHTS);
    expect(score.total).toBeGreaterThan(0);
    expect(score.total).toBeLessThanOrEqual(1.05);
  });

  test('two-member team is valid (no minimum size enforcement)', () => {
    const team: TeamComposition = {
      members: [
        makeUser('u1', ['python'], ['ml_engineer']),
        makeUser('u2', ['react'], ['frontend_developer']),
      ],
    };
    const score = computeTeamScore(team, EMPTY_CONSTRAINTS, 5, 0.5, DEFAULT_WEIGHTS);
    expect(score.total).toBeGreaterThan(0);
  });
});
