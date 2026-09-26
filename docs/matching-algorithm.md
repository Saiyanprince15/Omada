# Matching Algorithm — TeamForge

## Overview

The matching engine serves two distinct use cases:

| Use Case | Trigger | Input | Output |
|---|---|---|---|
| **Auto-Match** | Users opt into automatic team formation | All available users in the matchmaking pool | Set of provisional teams |
| **Candidate Ranking** | A team searches for a new member | Team's current composition + search criteria + available users | Ranked list of candidates |

Both share the same underlying **scoring model** but differ in their optimization strategy.

---

## G. Mathematical Scoring Model

### Notation

| Symbol | Meaning |
|---|---|
| T | A candidate team (set of users) |
| u | A single user |
| S(u) | Set of normalized skills for user u, each with proficiency p ∈ [1,5] |
| R(u) | Set of preferred roles for user u |
| I(u) | Set of normalized interests for user u |
| E(u) | Experience score for user u (derived from proficiency and years) |
| n | Team size (|T|) |
| E_req | Event-level required skills/roles (hard constraints) |

---

### Hard Constraints (Must be satisfied — violations disqualify the team)

These are evaluated **before** scoring. A team that violates any hard constraint is invalid.

| # | Constraint | Formula |
|---|---|---|
| H1 | Team size within bounds | `event.min_team_size ≤ |T| ≤ event.max_team_size` |
| H2 | Required skills covered | `∀ s ∈ E_req.hard_skills: ∃ u ∈ T where s ∈ S(u)` |
| H3 | Required roles covered | `∀ r ∈ E_req.hard_roles: ∃ u ∈ T where r ∈ R(u)` |
| H4 | No blocked pairs | `∀ (u₁, u₂) ∈ T: no block relationship between u₁ and u₂` |

---

### Soft Objectives (Scored — higher is better)

The total team score is a **weighted sum** of six normalized components, each producing a value in [0, 1]:

```
TeamScore(T) = w₁·SkillDiversity(T)
             + w₂·SkillCoverage(T)
             + w₃·RoleCoverage(T)
             + w₄·ExperienceBalance(T)
             + w₅·InterestCompatibility(T)
             + w₆·PreferenceSatisfaction(T)
```

#### Default Weights

| Weight | Component | Default | Justification |
|---|---|---|---|
| w₁ | Skill Diversity | 0.20 | Core differentiator — prevents homogeneous teams |
| w₂ | Skill Coverage | 0.25 | Ensures teams have the capabilities to execute |
| w₃ | Role Coverage | 0.20 | Teams need distinct functional roles |
| w₄ | Experience Balance | 0.10 | Fairness — distribute experience evenly across teams |
| w₅ | Interest Compatibility | 0.15 | Teams need enough common ground to collaborate |
| w₆ | Preference Satisfaction | 0.10 | Respect individual role preferences when possible |
| | **Total** | **1.00** | |

> **Justification:** Coverage and diversity receive the highest combined weight (0.65) because the core design principle is complementary teams. Interest compatibility gets moderate weight because some common ground is needed for collaboration. Experience balance and preference satisfaction are important but secondary — they optimize fairness rather than team capability.

> **Organizer override:** Event organizers can adjust these weights via event settings. Weights are validated to sum to 1.0.

---

### Component Definitions

#### 1. Skill Diversity — `SkillDiversity(T)`

Measures how many **distinct** skill categories a team covers relative to the maximum possible.

```
UniqueSkills(T) = |⋃ᵤ∈T S(u)|               // union of all skill sets
MaxPossibleSkills = total unique skills in the event participant pool

SkillDiversity(T) = UniqueSkills(T) / min(MaxPossibleSkills, K)
```

Where `K` is a normalization cap (e.g., `K = 3 × |T|`) to prevent the score from being artificially low when the global skill pool is enormous.

**Penalizes** teams where everyone shares the same skills.

#### 2. Skill Coverage — `SkillCoverage(T)`

Measures how well the team covers the **event's soft required skills** and the team's own desired skills.

```
SoftSkills = E_req.soft_skills ∪ event-relevant skills
CoveredSoftSkills = SoftSkills ∩ ⋃ᵤ∈T S(u)

// Weighted by proficiency — a skill covered at proficiency 4 counts more than at 1
WeightedCoverage = Σ (max proficiency of skill s among team members) / 5
                   for each s ∈ CoveredSoftSkills

SkillCoverage(T) = WeightedCoverage / |SoftSkills|
```

If no soft skills are defined, fall back to measuring coverage of the most common skills in the participant pool.

#### 3. Role Coverage — `RoleCoverage(T)`

Measures how many distinct **functional roles** are represented.

```
DesiredRoles = E_req.soft_roles ∪ standard role set
TeamRoles = ⋃ᵤ∈T R(u)
CoveredRoles = DesiredRoles ∩ TeamRoles

RoleCoverage(T) = |CoveredRoles| / |DesiredRoles|
```

Standard role set (if not defined by organizer):
`{Frontend, Backend, ML/Data, Design/UX, Research, DevOps, PM}`

#### 4. Experience Balance — `ExperienceBalance(T)`

Measures how evenly experience is distributed **across all teams**, not just within one team.

```
// Per-user experience score (normalized to [0, 1])
E(u) = (avg_proficiency(u) - 1) / 4     // proficiency is 1-5, normalize to 0-1

// Team average experience
TeamExp(T) = mean(E(u) for u ∈ T)

// Global average experience (across all participants in matchmaking)
GlobalExp = mean(E(u) for all u in pool)

// Penalize deviation from global average
ExperienceBalance(T) = 1 - |TeamExp(T) - GlobalExp| / max(GlobalExp, 1 - GlobalExp)
```

A perfectly balanced team (matching global average) scores 1.0. Teams with all experts or all beginners score lower.

#### 5. Interest Compatibility — `InterestCompatibility(T)`

Teams need **some** shared interests but not total overlap.

```
// Pairwise interest overlap
For each pair (u₁, u₂) ∈ T:
    Overlap(u₁, u₂) = |I(u₁) ∩ I(u₂)| / |I(u₁) ∪ I(u₂)|   // Jaccard similarity

// Average pairwise overlap
AvgOverlap = mean(Overlap(u₁, u₂) for all pairs)

// Sweet spot: we want moderate overlap (0.3-0.7 range)
// Too high = homogeneous interests; too low = no common ground
InterestCompatibility(T) = 1 - 2 × |AvgOverlap - 0.5|
```

This produces a bell curve peaking at 0.5 Jaccard overlap, rewarding teams with a mix of shared and diverse interests.

#### 6. Preference Satisfaction — `PreferenceSatisfaction(T)`

Measures how well team assignments respect individual role preferences.

```
// For each user, check if any of their preferred roles are "available" in this team
// A role is available if no one else with higher priority claims it

For each u ∈ T:
    preferred_roles = R(u) ordered by priority
    assigned = false
    for role in preferred_roles:
        if role not already claimed by another member with higher priority:
            assign u → role
            satisfaction(u) = 1.0 - (role.priority_index × 0.2)
            // 1st choice = 1.0, 2nd = 0.8, 3rd = 0.6, etc.
            assigned = true
            break
    if not assigned:
        satisfaction(u) = 0.2    // Base score for being on a team

PreferenceSatisfaction(T) = mean(satisfaction(u) for u ∈ T)
```

---

### Candidate Ranking (Team Search)

When an existing team searches for a new member, candidates are ranked by **marginal contribution**:

```
MarginalContribution(u, T) = TeamScore(T ∪ {u}) - TeamScore(T)
```

This naturally rewards candidates who fill gaps. If a team has three backend developers, a frontend developer will have higher marginal contribution than another backend developer.

#### Additional Ranking Signals for Team Search

```
CandidateScore(u, T, SearchCriteria) =
    α · MarginalContribution(u, T)
  + β · MustHaveMatch(u, SearchCriteria)
  + γ · NiceToHaveMatch(u, SearchCriteria)
  + δ · RoleMatch(u, SearchCriteria)
```

| Weight | Component | Default |
|---|---|---|
| α | Marginal contribution | 0.40 |
| β | Must-have skills match | 0.30 |
| γ | Nice-to-have skills match | 0.15 |
| δ | Role match | 0.15 |

```
MustHaveMatch(u, SC) = |S(u) ∩ SC.must_have| / |SC.must_have|
    // Weighted by proficiency

NiceToHaveMatch(u, SC) = |S(u) ∩ SC.nice_to_have| / |SC.nice_to_have|

RoleMatch(u, SC) =
    1.0  if SC.required_role ∈ R(u)
    0.5  if SC.preferred_role ∈ R(u) and no required_role match
    0.0  otherwise
```

---

## Team Formation Algorithm (Auto-Match)

### Algorithm: Modified Greedy with Fairness Optimization

The auto-match algorithm creates **all teams simultaneously** from the available pool. Pure optimal assignment is NP-hard, so we use a **multi-phase greedy approach with local search refinement**.

### Phase 1: Preprocessing

```
1. Snapshot all profiles in the matchmaking pool
2. Normalize all skills (using skill normalization map)
3. Compute E(u) for each user
4. Compute GlobalExp (pool-wide average)
5. Determine target team count: k = floor(|pool| / target_team_size)
6. Determine target team size: n = event.max_team_size (or organizer preference)
7. Handle remainder: last team may be smaller (≥ min_team_size)
```

### Phase 2: Seed Selection

Select `k` **seed users** that are maximally spread across the skill/role space.

```
1. Represent each user as a feature vector:
   - Skill dimensions (binary: has skill or not)
   - Role dimensions (binary: prefers role or not)
   - Experience dimension (continuous: 0-1)

2. Use k-means++ initialization to select k seeds
   - Pick first seed randomly
   - Each subsequent seed is chosen with probability proportional
     to squared distance from nearest existing seed
   
   This ensures seeds are diverse and well-spread.
```

### Phase 3: Greedy Assignment

```
remaining_users = pool - seeds
for each round:
    for each team (in rotating order, least-filled first):
        if team is full: skip
        
        best_candidate = argmax(MarginalContribution(u, team))
                         for u in remaining_users
                         subject to hard constraints
        
        assign best_candidate to team
        remove best_candidate from remaining_users
    
    if remaining_users is empty: break
```

**Rotating order** prevents earlier teams from systematically getting better candidates.

### Phase 4: Local Search Refinement (Fairness Pass)

After greedy assignment, some teams may have significantly better scores than others. This phase improves **global fairness**.

```
for iteration in 1..MAX_SWAP_ITERATIONS (default: 100):
    best_team = team with highest TeamScore
    worst_team = team with lowest TeamScore
    
    if (best_score - worst_score) < fairness_threshold (default: 0.15):
        break   // Teams are balanced enough
    
    for each pair (u₁ ∈ best_team, u₂ ∈ worst_team):
        // Try swapping
        new_best_score = TeamScore(best_team - u₁ + u₂)
        new_worst_score = TeamScore(worst_team - u₂ + u₁)
        
        if both teams still satisfy hard constraints
        AND (new_best_score + new_worst_score) > (old_best_score + old_worst_score)
        AND (|new_best_score - new_worst_score|) < (|old_best_score - old_worst_score|):
            execute swap
            break
```

### Phase 5: Handle Remainders

```
remaining = users not assigned to any team

if |remaining| ≥ event.min_team_size:
    form one more team from remaining
    
else if |remaining| > 0:
    // Try to distribute into existing teams (if under max_size)
    for each remaining_user:
        best_team = argmax(MarginalContribution(user, team))
                    for teams where |team| < event.max_team_size
        if best_team exists:
            assign user to best_team
        else:
            place user in "waiting for more participants" queue
```

---

### Tie-Breaking

When multiple candidates have equal scores:

1. **Prefer the user who has been waiting longer** (registered_at timestamp).
2. If still tied, **prefer the user with fewer matchmaking restarts** (reward patience).
3. If still tied, **random selection** (seeded for reproducibility).

---

### Handling Unmatched Users

| Scenario | Action |
|---|---|
| Pool size < `min_team_size` | All users remain in `looking_for_team`. Notification: "Not enough participants for auto-matching. Try manual team discovery." |
| Remainder after team formation (< `min_team_size`) | Try to fit into existing teams. If impossible, keep in pool with notification: "Waiting for more participants to form another team." |
| User has rare/unique skills that don't complement any team | Place in highest-scoring team. Flag to organizer dashboard. |
| User is blocked by many others | Reduce candidate pool accordingly. If no valid team exists, notify organizer. |

---

## H. Explainability System

Every auto-generated team produces two levels of explanation:

### 1. Team-Level Explanation

Generated alongside `TeamScore(T)` and stored in `provisional_teams.match_explanation`:

```json
{
  "team_score": 0.782,
  "components": {
    "skill_diversity": {
      "score": 0.85,
      "weight": 0.20,
      "weighted_score": 0.170,
      "detail": "Team covers 11 unique skills across 4 members",
      "skills_covered": ["react", "python", "ml", "nodejs", "figma", "sql", "docker", "git", "typescript", "pytorch", "research"]
    },
    "skill_coverage": {
      "score": 0.80,
      "weight": 0.25,
      "weighted_score": 0.200,
      "detail": "Covers 4 of 5 event-recommended skills",
      "covered": ["python", "ml", "web_development", "data_analysis"],
      "missing": ["cloud_deployment"]
    },
    "role_coverage": {
      "score": 0.75,
      "weight": 0.20,
      "weighted_score": 0.150,
      "detail": "3 of 4 desired roles filled",
      "covered": ["Frontend Developer", "ML Engineer", "Backend Developer"],
      "missing": ["DevOps"]
    },
    "experience_balance": {
      "score": 0.90,
      "weight": 0.10,
      "weighted_score": 0.090,
      "detail": "Team average experience (0.65) is close to pool average (0.60)"
    },
    "interest_compatibility": {
      "score": 0.72,
      "weight": 0.15,
      "weighted_score": 0.108,
      "detail": "Moderate shared interest overlap (0.45 Jaccard)",
      "shared_interests": ["machine_learning", "web_apps"],
      "diverse_interests": ["robotics", "nlp", "ui_design"]
    },
    "preference_satisfaction": {
      "score": 0.80,
      "weight": 0.10,
      "weighted_score": 0.080,
      "detail": "3 of 4 members assigned their #1 preferred role"
    }
  },
  "algorithm_metadata": {
    "round_id": "round-2026-09-26-001",
    "pool_size": 48,
    "teams_formed": 12,
    "seed_method": "k-means++",
    "swap_iterations": 23,
    "timestamp": "2026-09-26T10:30:00Z"
  }
}
```

### 2. Per-User Explanation

Stored in `provisional_team_members.match_reason`:

```json
{
  "why_this_team": [
    "This team needed a Frontend Developer — your #1 preferred role.",
    "You have React (proficiency 4/5) and TypeScript (proficiency 3/5), which complement the team's backend and ML skills.",
    "Your UI/UX interest aligns with the team's need for design capability.",
    "Adding you improved the team's skill diversity score from 0.70 to 0.85."
  ],
  "your_contribution": {
    "skills_added": ["react", "typescript", "figma", "css"],
    "role_filled": "Frontend Developer",
    "diversity_improvement": "+0.15",
    "experience_impact": "Your experience level (intermediate) keeps the team balanced."
  },
  "team_summary": {
    "members": [
      { "display_name": "Alice", "primary_role": "ML Engineer" },
      { "display_name": "Bob", "primary_role": "Backend Developer" },
      { "display_name": "Carol", "primary_role": "Researcher" }
    ],
    "collective_strengths": ["Strong technical depth", "Good research capability", "Full-stack coverage with your addition"],
    "potential_gaps": ["No dedicated DevOps — team may need to share deployment responsibilities"]
  }
}
```

### Natural Language Generation (Phase 2 — AI Service)

In Phase 2, the structured explanation JSON is passed to an LLM to generate a conversational summary:

> **Why were you matched with Team Alpha?**
>
> Team Alpha needed a frontend developer, and that's your top preferred role. You bring React and TypeScript skills that perfectly complement their existing backend (Bob — Node.js, Python) and ML (Alice — PyTorch, TensorFlow) expertise. Your UI/UX interest adds design capability that the team was missing. Experience-wise, you're a great fit — your intermediate level keeps the team balanced between Alice's advanced ML skills and Carol's research background.
>
> **What the team still needs:** No one has strong DevOps experience, so you'll need to share deployment responsibilities or look for a 5th member.

### Explanation Pipeline

```
Scoring Engine computes TeamScore(T)
    → Each component produces structured data
    → Store in provisional_teams.match_explanation (team-level)
    → For each member, extract relevant subset
    → Store in provisional_team_members.match_reason (per-user)
    → [Phase 2] Pass to AI Service for NL generation
    → Display in provisional team UI
```

### Display Rules

- **Always show:** Component scores with labels ("Skill Diversity: 85%").
- **Always show:** "Why you were matched" bullets (per-user reasons).
- **Always show:** Team composition and role assignments.
- **Never show:** Raw algorithmic weights or internal parameters.
- **Never show:** Other candidates' scores or comparisons.
- **Phase 2:** Natural-language paragraph alongside structured display.
