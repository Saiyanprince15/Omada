/**
 * TeamForge Matching Engine
 *
 * Implements the algorithm described in docs/matching-algorithm.md.
 *
 * Two entry points:
 *   - runAutoMatch(eventId, weights?)  → creates provisional teams
 *   - rankCandidates(team, candidates) → ranks users for an existing team
 */

import { prisma } from '../lib/prisma';
import { v4 as uuidv4 } from 'uuid';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface MatchWeights {
  skillDiversity: number;
  skillCoverage: number;
  roleCoverage: number;
  experienceBalance: number;
  interestCompatibility: number;
  preferenceSatisfaction: number;
}

export const DEFAULT_WEIGHTS: MatchWeights = {
  skillDiversity: 0.20,
  skillCoverage: 0.25,
  roleCoverage: 0.20,
  experienceBalance: 0.10,
  interestCompatibility: 0.15,
  preferenceSatisfaction: 0.10,
};

interface UserProfile {
  userId: string;
  displayName: string;
  skills: Array<{ skillName: string; proficiency: number; yearsExperience?: number }>;
  interests: Array<{ interestName: string }>;
  preferredRoles: Array<{ roleName: string; priority: number }>;
  registeredAt: Date;
  matchmakingRestarts: number;
}

interface TeamComposition {
  members: UserProfile[];
}

interface ScoreComponents {
  skillDiversity: number;
  skillCoverage: number;
  roleCoverage: number;
  experienceBalance: number;
  interestCompatibility: number;
  preferenceSatisfaction: number;
}

interface TeamScore {
  total: number;
  components: ScoreComponents;
}

interface EventConstraints {
  minTeamSize: number;
  maxTeamSize: number;
  hardSkills: string[];
  softSkills: string[];
  hardRoles: string[];
  softRoles: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring Functions
// ─────────────────────────────────────────────────────────────────────────────

function skillDiversityScore(team: TeamComposition, poolUniqueSkills: number): number {
  if (team.members.length === 0) return 0;

  const uniqueSkills = new Set(team.members.flatMap((m) => m.skills.map((s) => s.skillName)));
  const K = Math.min(poolUniqueSkills, 3 * team.members.length);

  return K === 0 ? 0 : Math.min(1, uniqueSkills.size / K);
}

function skillCoverageScore(team: TeamComposition, softSkills: string[]): number {
  if (softSkills.length === 0) return 0.5; // neutral when no requirements

  let weightedCoverage = 0;

  for (const skill of softSkills) {
    const maxProficiency = Math.max(
      0,
      ...team.members.flatMap((m) =>
        m.skills.filter((s) => s.skillName === skill).map((s) => s.proficiency)
      )
    );
    weightedCoverage += maxProficiency / 5;
  }

  return weightedCoverage / softSkills.length;
}

const STANDARD_ROLES = [
  'frontend_developer', 'backend_developer', 'ml_engineer', 'ui_ux_designer',
  'researcher', 'devops_engineer', 'project_manager',
];

function roleCoverageScore(team: TeamComposition, softRoles: string[]): number {
  const desiredRoles = softRoles.length > 0 ? softRoles : STANDARD_ROLES;
  const teamRoles = new Set(team.members.flatMap((m) => m.preferredRoles.map((r) => r.roleName)));
  const covered = desiredRoles.filter((r) => teamRoles.has(r));

  return desiredRoles.length === 0 ? 0 : covered.length / desiredRoles.length;
}

function experienceScore(user: UserProfile): number {
  if (user.skills.length === 0) return 0;
  const avg = user.skills.reduce((sum, s) => sum + s.proficiency, 0) / user.skills.length;
  return (avg - 1) / 4; // normalize 1-5 → 0-1
}

function experienceBalanceScore(team: TeamComposition, globalAvg: number): number {
  if (team.members.length === 0) return 0;
  const teamAvg = team.members.reduce((sum, m) => sum + experienceScore(m), 0) / team.members.length;
  const maxDev = Math.max(globalAvg, 1 - globalAvg);

  return maxDev === 0 ? 1 : 1 - Math.abs(teamAvg - globalAvg) / maxDev;
}

function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 0;
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function interestCompatibilityScore(team: TeamComposition): number {
  if (team.members.length < 2) return 0.5;

  const interestSets = team.members.map(
    (m) => new Set(m.interests.map((i) => i.interestName))
  );

  let totalOverlap = 0;
  let pairs = 0;

  for (let i = 0; i < interestSets.length; i++) {
    for (let j = i + 1; j < interestSets.length; j++) {
      totalOverlap += jaccardSimilarity(interestSets[i]!, interestSets[j]!);
      pairs++;
    }
  }

  const avgOverlap = pairs === 0 ? 0 : totalOverlap / pairs;

  // Bell curve: peak at 0.5 Jaccard
  return 1 - 2 * Math.abs(avgOverlap - 0.5);
}

function preferenceSatisfactionScore(team: TeamComposition): number {
  if (team.members.length === 0) return 0;

  const claimedRoles = new Map<string, { userId: string; priority: number }>();
  const satisfactions: number[] = [];

  for (const member of team.members) {
    const sorted = [...member.preferredRoles].sort((a, b) => a.priority - b.priority);
    let assigned = false;

    for (const role of sorted) {
      const existing = claimedRoles.get(role.roleName);
      if (!existing || existing.priority > role.priority) {
        // This member gets the role (or takes it with higher priority)
        if (existing) {
          // Previous holder loses this role — they'll be re-evaluated (simplified: give base score)
          satisfactions.push(0.2);
        }
        claimedRoles.set(role.roleName, { userId: member.userId, priority: role.priority });

        const priorityIndex = role.priority - 1;
        satisfactions.push(Math.max(0.2, 1 - priorityIndex * 0.2));
        assigned = true;
        break;
      }
    }

    if (!assigned) {
      satisfactions.push(0.2);
    }
  }

  return satisfactions.reduce((sum, s) => sum + s, 0) / satisfactions.length;
}

// ─── Composite team score ─────────────────────────────────────────────────

export function computeTeamScore(
  team: TeamComposition,
  constraints: EventConstraints,
  poolUniqueSkills: number,
  globalExpAvg: number,
  weights: MatchWeights = DEFAULT_WEIGHTS
): TeamScore {
  const components: ScoreComponents = {
    skillDiversity: skillDiversityScore(team, poolUniqueSkills),
    skillCoverage: skillCoverageScore(team, constraints.softSkills),
    roleCoverage: roleCoverageScore(team, constraints.softRoles),
    experienceBalance: experienceBalanceScore(team, globalExpAvg),
    interestCompatibility: interestCompatibilityScore(team),
    preferenceSatisfaction: preferenceSatisfactionScore(team),
  };

  const total =
    weights.skillDiversity * components.skillDiversity +
    weights.skillCoverage * components.skillCoverage +
    weights.roleCoverage * components.roleCoverage +
    weights.experienceBalance * components.experienceBalance +
    weights.interestCompatibility * components.interestCompatibility +
    weights.preferenceSatisfaction * components.preferenceSatisfaction;

  return { total, components };
}

// ─── Hard constraint check ────────────────────────────────────────────────

function satisfiesHardConstraints(team: TeamComposition, constraints: EventConstraints): boolean {
  const teamSkills = new Set(team.members.flatMap((m) => m.skills.map((s) => s.skillName)));
  const teamRoles = new Set(team.members.flatMap((m) => m.preferredRoles.map((r) => r.roleName)));

  for (const skill of constraints.hardSkills) {
    if (!teamSkills.has(skill)) return false;
  }
  for (const role of constraints.hardRoles) {
    if (!teamRoles.has(role)) return false;
  }

  return true;
}

// ─── Marginal contribution ────────────────────────────────────────────────

function marginalContribution(
  candidate: UserProfile,
  team: TeamComposition,
  constraints: EventConstraints,
  poolUniqueSkills: number,
  globalExpAvg: number,
  weights: MatchWeights
): number {
  const withCandidate: TeamComposition = { members: [...team.members, candidate] };
  const before = computeTeamScore(team, constraints, poolUniqueSkills, globalExpAvg, weights);
  const after = computeTeamScore(withCandidate, constraints, poolUniqueSkills, globalExpAvg, weights);
  return after.total - before.total;
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate Ranking (for team search)
// ─────────────────────────────────────────────────────────────────────────────

interface CandidateRankResult {
  userId: string;
  overallScore: number;
  marginalContributionScore: number;
  mustHaveMatch: string[];
  niceToHaveMatch: string[];
  roleMatch: string | null;
}

export function rankCandidates(
  existingTeam: TeamComposition,
  candidates: UserProfile[],
  searchCriteria: {
    mustHave: string[];
    niceToHave: string[];
    requiredRole?: string;
    preferredRole?: string;
  },
  constraints: EventConstraints,
  poolUniqueSkills: number,
  globalExpAvg: number,
  weights: MatchWeights = DEFAULT_WEIGHTS
): CandidateRankResult[] {
  const results: CandidateRankResult[] = [];

  for (const candidate of candidates) {
    const candidateSkillNames = new Set(candidate.skills.map((s) => s.skillName));
    const candidateRoles = new Set(candidate.preferredRoles.map((r) => r.roleName));

    const mustHaveMatch = searchCriteria.mustHave.filter((s) => candidateSkillNames.has(s));
    const niceToHaveMatch = searchCriteria.niceToHave.filter((s) => candidateSkillNames.has(s));

    const mustHaveScore =
      searchCriteria.mustHave.length === 0
        ? 1
        : mustHaveMatch.length / searchCriteria.mustHave.length;

    const niceToHaveScore =
      searchCriteria.niceToHave.length === 0
        ? 0.5
        : niceToHaveMatch.length / searchCriteria.niceToHave.length;

    let roleMatchScore = 0;
    let roleMatchLabel: string | null = null;

    if (searchCriteria.requiredRole && candidateRoles.has(searchCriteria.requiredRole)) {
      roleMatchScore = 1.0;
      roleMatchLabel = searchCriteria.requiredRole;
    } else if (searchCriteria.preferredRole && candidateRoles.has(searchCriteria.preferredRole)) {
      roleMatchScore = 0.5;
      roleMatchLabel = searchCriteria.preferredRole;
    }

    const mc = marginalContribution(
      candidate, existingTeam, constraints, poolUniqueSkills, globalExpAvg, weights
    );

    const overallScore =
      0.40 * mc +
      0.30 * mustHaveScore +
      0.15 * niceToHaveScore +
      0.15 * roleMatchScore;

    results.push({
      userId: candidate.userId,
      overallScore,
      marginalContributionScore: mc,
      mustHaveMatch,
      niceToHaveMatch,
      roleMatch: roleMatchLabel,
    });
  }

  return results.sort((a, b) => b.overallScore - a.overallScore);
}

// ─────────────────────────────────────────────────────────────────────────────
// K-Means++ Seed Selection
// ─────────────────────────────────────────────────────────────────────────────

function squaredDistance(a: UserProfile, b: UserProfile): number {
  const skillsA = new Set(a.skills.map((s) => s.skillName));
  const skillsB = new Set(b.skills.map((s) => s.skillName));
  const rolesA = new Set(a.preferredRoles.map((r) => r.roleName));
  const rolesB = new Set(b.preferredRoles.map((r) => r.roleName));

  const allSkills = new Set([...skillsA, ...skillsB]);
  const allRoles = new Set([...rolesA, ...rolesB]);

  let dist = 0;
  for (const skill of allSkills) {
    const valA = skillsA.has(skill) ? 1 : 0;
    const valB = skillsB.has(skill) ? 1 : 0;
    dist += (valA - valB) ** 2;
  }
  for (const role of allRoles) {
    const valA = rolesA.has(role) ? 1 : 0;
    const valB = rolesB.has(role) ? 1 : 0;
    dist += (valA - valB) ** 2;
  }

  const expA = experienceScore(a);
  const expB = experienceScore(b);
  dist += (expA - expB) ** 2;

  return dist;
}

function selectSeeds(users: UserProfile[], k: number): UserProfile[] {
  if (users.length === 0 || k <= 0) return [];
  if (users.length <= k) return [...users];

  const seeds: UserProfile[] = [];

  // Pick first seed randomly
  seeds.push(users[Math.floor(Math.random() * users.length)]!);

  while (seeds.length < k) {
    const distances = users.map((u) => {
      if (seeds.find((s) => s.userId === u.userId)) return 0;
      return Math.min(...seeds.map((s) => squaredDistance(u, s)));
    });

    const total = distances.reduce((sum, d) => sum + d, 0);
    if (total === 0) break;

    let rand = Math.random() * total;
    let nextSeed = users[0]!;

    for (let i = 0; i < users.length; i++) {
      rand -= distances[i]!;
      if (rand <= 0) {
        nextSeed = users[i]!;
        break;
      }
    }

    seeds.push(nextSeed);
  }

  return seeds;
}

// ─────────────────────────────────────────────────────────────────────────────
// Explanation Generation
// ─────────────────────────────────────────────────────────────────────────────

function buildTeamExplanation(
  team: TeamComposition,
  score: TeamScore,
  constraints: EventConstraints,
  poolUniqueSkills: number
): object {
  const teamSkills = [...new Set(team.members.flatMap((m) => m.skills.map((s) => s.skillName)))];
  const teamRoles = [...new Set(team.members.flatMap((m) => m.preferredRoles.map((r) => r.roleName)))];

  const coveredSoftSkills = constraints.softSkills.filter((s) => teamSkills.includes(s));
  const missingSoftSkills = constraints.softSkills.filter((s) => !teamSkills.includes(s));
  const coveredSoftRoles = constraints.softRoles.filter((r) => teamRoles.includes(r));
  const missingSoftRoles = constraints.softRoles.filter((r) => !teamRoles.includes(r));

  return {
    team_score: Math.round(score.total * 1000) / 1000,
    components: {
      skill_diversity: {
        score: Math.round(score.components.skillDiversity * 100) / 100,
        detail: `Team covers ${teamSkills.length} unique skills`,
        skills_covered: teamSkills,
      },
      skill_coverage: {
        score: Math.round(score.components.skillCoverage * 100) / 100,
        detail: `Covers ${coveredSoftSkills.length} of ${constraints.softSkills.length} recommended skills`,
        covered: coveredSoftSkills,
        missing: missingSoftSkills,
      },
      role_coverage: {
        score: Math.round(score.components.roleCoverage * 100) / 100,
        detail: `Covers ${coveredSoftRoles.length} of ${constraints.softRoles.length || STANDARD_ROLES.length} desired roles`,
        covered: coveredSoftRoles,
        missing: missingSoftRoles,
      },
      experience_balance: {
        score: Math.round(score.components.experienceBalance * 100) / 100,
        detail: 'Experience levels across team members',
      },
      interest_compatibility: {
        score: Math.round(score.components.interestCompatibility * 100) / 100,
        detail: 'Balance of shared and diverse interests',
      },
      preference_satisfaction: {
        score: Math.round(score.components.preferenceSatisfaction * 100) / 100,
        detail: 'How well preferred roles are satisfied',
      },
    },
  };
}

function buildMemberExplanation(
  candidate: UserProfile,
  team: TeamComposition,
  mc: number,
  constraints: EventConstraints
): object {
  const teamSkills = new Set(team.members.flatMap((m) => m.skills.map((s) => s.skillName)));
  const uniqueSkillsAdded = candidate.skills
    .map((s) => s.skillName)
    .filter((s) => !teamSkills.has(s));

  const filledRoles = candidate.preferredRoles
    .map((r) => r.roleName)
    .filter((r) => constraints.softRoles.includes(r) || constraints.hardRoles.includes(r));

  const reasons: string[] = [];

  if (uniqueSkillsAdded.length > 0) {
    reasons.push(`Adds ${uniqueSkillsAdded.length} new skill(s) to the team: ${uniqueSkillsAdded.join(', ')}.`);
  }
  if (filledRoles.length > 0) {
    reasons.push(`Fills required/recommended role(s): ${filledRoles.join(', ')}.`);
  }
  if (mc > 0.05) {
    reasons.push(`Improves team score by ${(mc * 100).toFixed(1)}%.`);
  }
  if (candidate.preferredRoles.length > 0) {
    reasons.push(`Preferred role(s): ${candidate.preferredRoles.map((r) => r.roleName).join(', ')}.`);
  }

  return {
    why_this_team: reasons.length > 0 ? reasons : ['Compatible profile with team composition.'],
    skills_added: uniqueSkillsAdded,
    roles_filled: filledRoles,
    diversity_improvement: `+${(mc * 100).toFixed(1)}%`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Auto-Match Entry Point
// ─────────────────────────────────────────────────────────────────────────────

export async function runAutoMatch(
  eventId: string,
  weights: MatchWeights = DEFAULT_WEIGHTS
): Promise<{
  roundId: string;
  teamsFormed: number;
  unmatched: string[];
}> {
  // 1. Load event constraints
  const event = await prisma.event.findUniqueOrThrow({
    where: { id: eventId },
    include: { requiredSkills: true, requiredRoles: true },
  });

  const constraints: EventConstraints = {
    minTeamSize: event.minTeamSize,
    maxTeamSize: event.maxTeamSize,
    hardSkills: event.requiredSkills.filter((s) => s.constraintType === 'hard').map((s) => s.skillName),
    softSkills: event.requiredSkills.filter((s) => s.constraintType === 'soft').map((s) => s.skillName),
    hardRoles: event.requiredRoles.filter((r) => r.constraintType === 'hard').map((r) => r.roleName),
    softRoles: event.requiredRoles.filter((r) => r.constraintType === 'soft').map((r) => r.roleName),
  };

  // 2. Load matchmaking pool
  const participants = await prisma.eventParticipant.findMany({
    where: { eventId, status: 'in_matchmaking' },
    include: {
      user: {
        include: { skills: true, interests: true, preferredRoles: true },
      },
    },
    orderBy: { registeredAt: 'asc' },
  });

  const pool: UserProfile[] = participants.map((p) => ({
    userId: p.userId,
    displayName: p.user.displayName,
    skills: p.user.skills.map((s) => ({
      skillName: s.skillName,
      proficiency: s.proficiency,
      yearsExperience: s.yearsExperience ? Number(s.yearsExperience) : undefined,
    })),
    interests: p.user.interests.map((i) => ({ interestName: i.interestName })),
    preferredRoles: p.user.preferredRoles.map((r) => ({
      roleName: r.roleName,
      priority: r.priority,
    })),
    registeredAt: p.registeredAt,
    matchmakingRestarts: p.matchmakingRestarts,
  }));

  // Create matchmaking round record
  const round = await prisma.matchingRound.create({
    data: {
      eventId,
      status: 'running',
      participantsCount: pool.length,
      algorithmParams: weights as unknown as object,
    },
  });

  if (pool.length < constraints.minTeamSize) {
    await prisma.matchingRound.update({
      where: { id: round.id },
      data: { status: 'completed', teamsFormed: 0, unmatchedCount: pool.length, completedAt: new Date() },
    });
    return { roundId: round.id, teamsFormed: 0, unmatched: pool.map((u) => u.userId) };
  }

  // 3. Precompute global metrics
  const poolUniqueSkills = new Set(pool.flatMap((u) => u.skills.map((s) => s.skillName))).size;
  const globalExpAvg =
    pool.length === 0
      ? 0.5
      : pool.reduce((sum, u) => sum + experienceScore(u), 0) / pool.length;

  const targetTeamSize = constraints.maxTeamSize;
  const k = Math.floor(pool.length / targetTeamSize);

  // 4. Seed selection (k-means++)
  const seeds = selectSeeds(pool, k);
  const teams: TeamComposition[] = seeds.map((seed) => ({ members: [seed] }));

  // 5. Greedy assignment
  const assigned = new Set(seeds.map((s) => s.userId));
  const remaining = pool.filter((u) => !assigned.has(u.userId));

  let roundIndex = 0;
  while (remaining.length > 0) {
    const teamIndex = roundIndex % teams.length;
    const team = teams[teamIndex]!;

    if (team.members.length >= targetTeamSize) {
      roundIndex++;
      // Check if all teams are full
      if (teams.every((t) => t.members.length >= targetTeamSize)) break;
      continue;
    }

    // Find best candidate for this team
    let bestCandidate: UserProfile | null = null;
    let bestMC = -Infinity;

    for (const candidate of remaining) {
      if (assigned.has(candidate.userId)) continue;

      const mc = marginalContribution(
        candidate, team, constraints, poolUniqueSkills, globalExpAvg, weights
      );

      if (mc > bestMC) {
        bestMC = mc;
        bestCandidate = candidate;
      }
    }

    if (bestCandidate) {
      team.members.push(bestCandidate);
      assigned.add(bestCandidate.userId);
      remaining.splice(remaining.findIndex((u) => u.userId === bestCandidate!.userId), 1);
    }

    roundIndex++;
  }

  // 6. Fairness pass — swap to reduce score gap
  const MAX_SWAPS = 100;
  const FAIRNESS_THRESHOLD = 0.15;

  for (let iter = 0; iter < MAX_SWAPS; iter++) {
    const scores = teams.map((t) =>
      computeTeamScore(t, constraints, poolUniqueSkills, globalExpAvg, weights).total
    );

    const maxScore = Math.max(...scores);
    const minScore = Math.min(...scores);

    if (maxScore - minScore < FAIRNESS_THRESHOLD) break;

    const bestTeamIdx = scores.indexOf(maxScore);
    const worstTeamIdx = scores.indexOf(minScore);

    const bestTeam = teams[bestTeamIdx]!;
    const worstTeam = teams[worstTeamIdx]!;

    let swapped = false;

    outer: for (let i = 0; i < bestTeam.members.length; i++) {
      for (let j = 0; j < worstTeam.members.length; j++) {
        const u1 = bestTeam.members[i]!;
        const u2 = worstTeam.members[j]!;

        const newBest: TeamComposition = {
          members: bestTeam.members.map((m, idx) => (idx === i ? u2 : m)),
        };
        const newWorst: TeamComposition = {
          members: worstTeam.members.map((m, idx) => (idx === j ? u1 : m)),
        };

        if (
          !satisfiesHardConstraints(newBest, constraints) ||
          !satisfiesHardConstraints(newWorst, constraints)
        )
          continue;

        const newBestScore = computeTeamScore(newBest, constraints, poolUniqueSkills, globalExpAvg, weights).total;
        const newWorstScore = computeTeamScore(newWorst, constraints, poolUniqueSkills, globalExpAvg, weights).total;

        const improvement = newBestScore + newWorstScore > maxScore + minScore;
        const moreBalanced = Math.abs(newBestScore - newWorstScore) < Math.abs(maxScore - minScore);

        if (improvement && moreBalanced) {
          bestTeam.members[i] = u2;
          worstTeam.members[j] = u1;
          swapped = true;
          break outer;
        }
      }
    }

    if (!swapped) break;
  }

  // 7. Handle remainders
  const unmatchedUserIds: string[] = [];
  const finalTeams = teams.filter((t) => t.members.length >= constraints.minTeamSize);
  const tooSmall = teams.filter((t) => t.members.length < constraints.minTeamSize && t.members.length > 0);

  for (const smallTeam of tooSmall) {
    for (const member of smallTeam.members) {
      // Try to add to existing teams
      let added = false;
      for (const team of finalTeams) {
        if (team.members.length < constraints.maxTeamSize) {
          team.members.push(member);
          added = true;
          break;
        }
      }
      if (!added) unmatchedUserIds.push(member.userId);
    }
  }

  // 8. Persist provisional teams
  const expiresAt = new Date(Date.now() + event.autoMatchTimeoutHrs * 60 * 60 * 1000);

  await prisma.$transaction(async (tx) => {
    for (const team of finalTeams) {
      const teamScore = computeTeamScore(team, constraints, poolUniqueSkills, globalExpAvg, weights);
      const explanation = buildTeamExplanation(team, teamScore, constraints, poolUniqueSkills);

      // Create chat room
      const chatRoom = await tx.chatRoom.create({
        data: { roomType: 'provisional', status: 'active' },
      });

      // Create provisional team
      const pt = await tx.provisionalTeam.create({
        data: {
          eventId,
          status: 'pending',
          targetSize: team.members.length,
          matchScore: teamScore.total,
          matchExplanation: explanation as object,
          createdByRound: round.id,
          chatRoomId: chatRoom.id,
          expiresAt,
        },
      });

      // Create provisional team members with per-user explanations
      for (const member of team.members) {
        const teamWithoutMember: TeamComposition = {
          members: team.members.filter((m) => m.userId !== member.userId),
        };
        const mc = marginalContribution(
          member, teamWithoutMember, constraints, poolUniqueSkills, globalExpAvg, weights
        );
        const memberExplanation = buildMemberExplanation(member, teamWithoutMember, mc, constraints);

        await tx.provisionalTeamMember.create({
          data: {
            provisionalTeamId: pt.id,
            userId: member.userId,
            status: 'pending',
            matchReason: memberExplanation as object,
          },
        });

        // Update participant state
        await tx.eventParticipant.update({
          where: { eventId_userId: { eventId, userId: member.userId } },
          data: {
            status: 'in_provisional_team',
            provisionalTeamId: pt.id,
            profileSnapshot: {
              skills: member.skills,
              interests: member.interests,
              preferredRoles: member.preferredRoles,
            } as object,
          },
        });
      }
    }

    // Return unmatched users to looking_for_team
    for (const userId of unmatchedUserIds) {
      await tx.eventParticipant.update({
        where: { eventId_userId: { eventId, userId } },
        data: { status: 'looking_for_team', provisionalTeamId: null },
      });
    }

    await tx.matchingRound.update({
      where: { id: round.id },
      data: {
        status: 'completed',
        teamsFormed: finalTeams.length,
        unmatchedCount: unmatchedUserIds.length,
        completedAt: new Date(),
      },
    });
  });

  return {
    roundId: round.id,
    teamsFormed: finalTeams.length,
    unmatched: unmatchedUserIds,
  };
}
