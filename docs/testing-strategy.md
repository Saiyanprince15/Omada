# Testing Strategy — TeamForge

## M. Testing Overview

```
┌──────────────────────────────────────────────────────┐
│                Testing Pyramid                        │
│                                                       │
│                    ┌───────┐                          │
│                   /  E2E   \          ~10 tests       │
│                  /  Tests   \                         │
│                 /─────────────\                        │
│                / Integration   \      ~50 tests       │
│               /     Tests       \                     │
│              /───────────────────\                     │
│             /      Unit Tests     \   ~200+ tests     │
│            /─────────────────────────\                 │
│                                                       │
│  + Concurrency tests (specialized)    ~20 tests      │
│  + Security tests (specialized)       ~30 tests      │
│  + Load tests (pre-release)           ~10 scenarios  │
└──────────────────────────────────────────────────────┘
```

---

## 1. Unit Tests

### 1.1 Matching Algorithm

The matching engine is the most algorithmically complex component. Each scoring function is tested independently.

#### Skill Diversity Tests

| # | Test Case | Input | Expected |
|---|---|---|---|
| SD-1 | All users have identical skills | Team of 4 Python devs | Low diversity score (≤ 0.2) |
| SD-2 | All users have unique skills | Team: Python, React, Figma, DevOps | High diversity score (≥ 0.8) |
| SD-3 | Partial overlap | 2 Python devs + 1 React + 1 ML | Medium diversity (0.5–0.7) |
| SD-4 | Single-member team | Team of 1 | Diversity = their unique skills / cap |
| SD-5 | Max-size team, all different | 5 members, 0 overlap | Score ≈ 1.0 |
| SD-6 | Empty skill sets | Users with no skills listed | Score = 0 (graceful, no divide-by-zero) |

#### Skill Coverage Tests

| # | Test Case | Input | Expected |
|---|---|---|---|
| SC-1 | Team covers all event soft skills | Event needs Python, ML, Web; team has all | Score ≈ 1.0 |
| SC-2 | Team covers none | Event needs Python, ML; team has Rust, Go | Score ≈ 0.0 |
| SC-3 | Partial coverage, high proficiency | Covers 3/5 skills at proficiency 5 | Higher than covering 3/5 at proficiency 1 |
| SC-4 | No soft skills defined | Event has no soft skill requirements | Fallback to pool-common skills |
| SC-5 | Multiple members cover same skill | 2 members with Python | Counted once, uses highest proficiency |

#### Role Coverage Tests

| # | Test Case | Input | Expected |
|---|---|---|---|
| RC-1 | All desired roles filled | Team has Frontend, Backend, ML, Design | Score ≈ 1.0 |
| RC-2 | No roles filled | Team members have no matching roles | Score ≈ 0.0 |
| RC-3 | Some roles filled | 2/4 desired roles present | Score ≈ 0.5 |
| RC-4 | User has multiple preferred roles | User prefers Frontend and UI/UX | Both count toward coverage |

#### Experience Balance Tests

| # | Test Case | Input | Expected |
|---|---|---|---|
| EB-1 | All members near pool average | Pool avg 0.6; team avg 0.58 | High score (≥ 0.9) |
| EB-2 | All experts | Pool avg 0.5; team avg 0.95 | Low score (≤ 0.3) |
| EB-3 | All beginners | Pool avg 0.5; team avg 0.10 | Low score (≤ 0.3) |
| EB-4 | Mix that averages to pool avg | Pool avg 0.5; team has 0.2, 0.5, 0.8 | High score |
| EB-5 | Single-member team | Pool avg 0.5; member at 0.5 | Score = 1.0 |

#### Interest Compatibility Tests

| # | Test Case | Input | Expected |
|---|---|---|---|
| IC-1 | Perfect overlap (all same interests) | Jaccard = 1.0 | Moderate score (not max — we want some diversity) |
| IC-2 | Zero overlap | Jaccard = 0.0 | Low score |
| IC-3 | Sweet spot (50% overlap) | Jaccard ≈ 0.5 | Highest score (≈ 1.0) |
| IC-4 | Users with no interests listed | Empty interest sets | Score = 0.5 (neutral, no penalty) |

#### Preference Satisfaction Tests

| # | Test Case | Input | Expected |
|---|---|---|---|
| PS-1 | All members get #1 choice | 4 members, 4 distinct preferred roles | Score = 1.0 |
| PS-2 | Role conflicts (2 want same role) | 2 members both want Frontend | One gets 1.0, other gets 0.8 (2nd choice) |
| PS-3 | No preferences set | Members have empty role lists | Score = 0.2 (base) |
| PS-4 | Single preferred role, not available | Member wants "PM" but no team needs it | Score based on best fallback |

#### Composite TeamScore Tests

| # | Test Case | Expected |
|---|---|---|
| TS-1 | Perfect team (all components ≈ 1.0) | TeamScore ≈ 1.0 |
| TS-2 | Terrible team (all components ≈ 0.0) | TeamScore ≈ 0.0 |
| TS-3 | Custom weights (organizer override) | Verify weighted sum uses custom weights |
| TS-4 | Weights sum to 1.0 validation | Reject if Σwᵢ ≠ 1.0 |

#### Marginal Contribution Tests

| # | Test Case | Expected |
|---|---|---|
| MC-1 | Team needs Frontend, candidate has Frontend | Positive marginal contribution |
| MC-2 | Team has 3 Backend devs, candidate is Backend | Low marginal contribution |
| MC-3 | Team has 3 Backend devs, candidate is Frontend | High marginal contribution |
| MC-4 | Adding candidate violates hard constraint | Candidate excluded (not ranked) |
| MC-5 | Empty team + first candidate | Contribution = TeamScore({candidate}) |

#### Team Formation Algorithm Tests

| # | Test Case | Expected |
|---|---|---|
| TF-1 | Pool of 20, team size 4 | 5 teams formed, all satisfy hard constraints |
| TF-2 | Pool of 22, team size 4 | 5 teams of 4 + 1 team of 2 (if ≥ min_size) |
| TF-3 | Pool of 3, min team size 4 | No teams formed; users remain in pool |
| TF-4 | Pool of 21, team size 4, min 3 | 5 teams of 4 + 1 user waiting OR 4 teams of 4 + 1 team of 5 |
| TF-5 | Fairness pass | After refinement, max score difference between best/worst team < threshold |
| TF-6 | Hard constraint: every team needs a developer | All formed teams contain ≥1 user with "developer" role |
| TF-7 | Blocked pair | Blocked users never placed on same team |
| TF-8 | All identical profiles | Teams formed fairly (random distribution); no crash |
| TF-9 | Reproducibility | Same input + same seed = same output |

---

### 1.2 State Machine Transitions

#### User State Transitions

| # | Test Case | Expected |
|---|---|---|
| US-1 | registered → looking_for_team | ✓ Valid transition |
| US-2 | registered → in_finalized_team | ✗ Invalid (must go through looking_for_team) |
| US-3 | looking_for_team → in_matchmaking | ✓ Valid (if matchmaking enabled, rate-limit not exceeded) |
| US-4 | in_matchmaking → looking_for_team | ✓ Valid (no match found) |
| US-5 | in_provisional_team → looking_for_team | ✓ Valid (user rejects) |
| US-6 | in_finalized_team → looking_for_team | ✓ Valid (if event allows re-entry) |
| US-7 | in_finalized_team → in_matchmaking | ✗ Invalid (must leave team first) |
| US-8 | withdrawn → looking_for_team | ✗ Invalid (must re-register) |
| US-9 | Any state → withdrawn | ✓ Always valid |

#### Team State Transitions

| # | Test Case | Expected |
|---|---|---|
| TS-1 | forming → finalized (with enough members) | ✓ Valid |
| TS-2 | forming → finalized (below min_size) | ✗ Rejected |
| TS-3 | forming → dissolved (owner dissolves) | ✓ Members returned to looking_for_team |
| TS-4 | finalized → forming (owner re-opens) | ✓ Valid if event not started |
| TS-5 | finalized → locked (event starts) | ✓ System-triggered |
| TS-6 | locked → forming | ✗ Invalid (no changes during event) |
| TS-7 | dissolved → any | ✗ Terminal state |

#### Request State Transitions

| # | Test Case | Expected |
|---|---|---|
| RS-1 | pending → accepted | ✓ Side effects execute (add to team, cancel other requests) |
| RS-2 | pending → rejected | ✓ No side effects on membership |
| RS-3 | pending → cancelled (by sender) | ✓ |
| RS-4 | accepted → pending | ✗ Invalid (irreversible) |
| RS-5 | rejected → accepted | ✗ Invalid (must create new request) |
| RS-6 | Duplicate pending request | ✗ Rejected (unique constraint) |

---

### 1.3 Business Logic

| # | Test Case | Expected |
|---|---|---|
| BL-1 | Matchmaking restart rate limit | 4th restart within 1 hour → rejected |
| BL-2 | Profile snapshot on matchmaking entry | Profile edits after entry don't affect current round |
| BL-3 | Ownership transfer | New owner gets 'owner' role; old owner becomes 'member' |
| BL-4 | Owner leaves without transfer | Longest-tenured member auto-promoted |
| BL-5 | Last member leaves team | Team auto-dissolves |
| BL-6 | Team at max capacity receives join request | Request rejected with TEAM_FULL error |
| BL-7 | Provisional team expires | All members returned to looking_for_team; notifications sent |
| BL-8 | Replacement search after rejection | System finds candidate from available pool |
| BL-9 | No replacement available after rejection | If remaining < min_size, dissolve provisional team |

---

## 2. Integration Tests

### 2.1 User Flow: Manual Team Formation

```
Test: Complete manual team formation flow

Steps:
1. Register User A and User B
2. Create Event (organizer)
3. User A registers for event → status: registered
4. User A starts looking → status: looking_for_team
5. User A creates Team Alpha → status: forming; User A is owner
6. User B registers for event, starts looking
7. User A invites User B → request: pending
8. User B accepts invitation → 
   - User B added to Team Alpha
   - User B status: in_finalized_team
   - Other pending requests for User B: cancelled
9. User A finalizes team → team status: finalized
10. Permanent chat room created

Verify: All database states are consistent at each step.
```

### 2.2 User Flow: Auto-Matchmaking

```
Test: Complete auto-matchmaking flow

Steps:
1. Create Event with min_size=3, max_size=4
2. Register 12 users with diverse profiles
3. All users enter matchmaking → status: in_matchmaking
4. Trigger matchmaking round
5. Verify: 3 provisional teams created (4 members each)
6. Verify: Each user is in exactly one provisional team
7. Verify: Provisional chat rooms created
8. All members of PT-1 accept
9. Verify: PT-1 → status: converted
10. Verify: Finalized team created from PT-1
11. Verify: PT-1 members → status: in_finalized_team
12. One member of PT-2 rejects
13. Verify: Replacement search executed
14. If replacement found → new member added to PT-2
15. If not found → check viability, potentially dissolve

Verify: No orphaned users. All users in a valid state.
```

### 2.3 User Flow: Team Discovery

```
Test: Team discovery modes

Setup: 
- Event with 5 teams, varying requirements
- User with React, TypeScript, UI/UX skills

Steps:
1. GET /teams/discover?mode=match_my_skills
2. Verify: Teams needing React/TypeScript/UI appear first
3. Verify: Match scores are correct
4. GET /teams/discover?mode=explore
5. Verify: All open teams returned, not just matching ones
```

### 2.4 User Flow: Join Request

```
Test: Join request lifecycle

Steps:
1. User A creates team
2. User B sends join request with message
3. Verify: Request created, notification sent to User A
4. User A accepts
5. Verify: User B added to team, other requests cancelled
6. Verify: User B cannot send another join request (in_finalized_team)
```

### 2.5 Provisional Team Rejection & Replacement

```
Test: Replacement after rejection in provisional team

Setup: 
- Provisional team of 4 members (min_size=3)
- 2 additional users in looking_for_team state

Steps:
1. Member C rejects provisional team
2. System searches for replacement among available users
3. Verify: Best-fit replacement is found and added
4. Verify: Replacement gets match explanation
5. Verify: Original team explanation is updated
6. Remaining members re-notified
```

---

## 3. Concurrency Tests

> These tests MUST run against a real database (not mocks) to verify transaction isolation.

### 3.1 Two Users Claiming One Slot

```
Test: Race condition — two users try to join a team with 1 slot remaining

Setup:
- Team with max_size=4, current_size=3 (1 slot)
- User A and User B both have pending join requests

Steps:
1. Concurrently execute:
   Thread 1: Accept User A's request
   Thread 2: Accept User B's request
   
Expected:
- Exactly one user is added to the team
- The other receives a TEAM_FULL or CONFLICT error
- No inconsistent state (team size never exceeds 4)
- The rejected user's request is still in a valid state
```

### 3.2 Same User Accepting Two Teams

```
Test: Race condition — user accepts two team invitations simultaneously

Setup:
- User C has pending invitations from Team A and Team B

Steps:
1. Concurrently execute:
   Thread 1: User C accepts Team A invitation
   Thread 2: User C accepts Team B invitation

Expected:
- User C joins exactly one team
- The other invitation is auto-cancelled
- User C has exactly one team_members row
- event_participants.team_id points to the accepted team
```

### 3.3 Team Filling While User Applies

```
Test: Team fills up between request creation and acceptance

Setup:
- Team with 1 remaining slot
- User D sends join request
- Meanwhile, User E is accepted by the team (filling the slot)

Steps:
1. User D sends join request (succeeds — slot was available)
2. Before User D's request is reviewed, User E fills the slot
3. Team owner tries to accept User D's request

Expected:
- Acceptance fails with TEAM_FULL error
- User D's request transitions to 'cancelled' (auto-cancelled due to full team)
- User D is notified
```

### 3.4 Simultaneous Accept/Reject in Provisional Team

```
Test: Two members respond to provisional team at the exact same time

Setup:
- Provisional team with 4 members, all pending

Steps:
1. Concurrently execute:
   Thread 1: Member A accepts
   Thread 2: Member B rejects

Expected:
- Both responses recorded correctly
- Replacement search triggered for Member B
- No deadlock
- Provisional team status updated correctly
```

### 3.5 Matchmaking During State Transition

```
Test: User changes state while matchmaking is running

Setup:
- User is in_matchmaking state
- Matchmaking round starts processing

Steps:
1. User withdraws from event during matchmaking computation
2. Algorithm tries to place the user in a team

Expected:
- Algorithm's attempt to update user fails gracefully
- User remains in withdrawn state
- Team is formed without the user (replacement if needed)
```

---

## 4. Security Tests

### 4.1 Authentication Tests

| # | Test Case | Expected |
|---|---|---|
| AUTH-1 | Access protected endpoint without token | 401 Unauthorized |
| AUTH-2 | Access with expired access token | 401 Unauthorized |
| AUTH-3 | Access with malformed JWT | 401 Unauthorized |
| AUTH-4 | Refresh with valid refresh token | New access + refresh token pair |
| AUTH-5 | Refresh with expired refresh token | 401, must re-login |
| AUTH-6 | Refresh token reuse (replay attack) | Entire token family invalidated |
| AUTH-7 | Login with wrong password (5 times) | Account lockout |
| AUTH-8 | Login after lockout expires | Succeeds |

### 4.2 Authorization Tests

| # | Test Case | Expected |
|---|---|---|
| AUTHZ-1 | Non-owner tries to dissolve team | 403 Forbidden |
| AUTHZ-2 | Non-member tries to access team chat | 403 Forbidden |
| AUTHZ-3 | Regular user tries to run matchmaking | 403 Forbidden |
| AUTHZ-4 | Member tries to remove another member | 403 Forbidden |
| AUTHZ-5 | Admin tries to remove the owner | 403 Forbidden |
| AUTHZ-6 | Non-participant tries to view event participants | 403 Forbidden |
| AUTHZ-7 | User tries to accept a request they didn't receive | 403 Forbidden |

### 4.3 Data Exposure Tests

| # | Test Case | Expected |
|---|---|---|
| DATA-1 | GET /users/:other_id returns email | ✗ Email not in response |
| DATA-2 | GET /chat/rooms/:room_id (non-member) | 403 Forbidden |
| DATA-3 | GET /events/:id/participants (non-participant) | Limited data (no status, no team info) |
| DATA-4 | GET /admin/dashboard (non-organizer) | 403 Forbidden |

### 4.4 Input Validation Tests

| # | Test Case | Expected |
|---|---|---|
| INP-1 | XSS in display_name (`<script>alert(1)</script>`) | Sanitized, stored as plain text |
| INP-2 | SQL injection in search query | Parameterized query, no injection |
| INP-3 | Oversized bio (> 2000 chars) | 400 Validation Error |
| INP-4 | Negative proficiency value | 400 Validation Error |
| INP-5 | Invalid email format | 400 Validation Error |
| INP-6 | HTML in chat message | Stripped or escaped |

### 4.5 Rate Limiting Tests

| # | Test Case | Expected |
|---|---|---|
| RL-1 | 6th login attempt within 1 minute | 429 Too Many Requests |
| RL-2 | 21st invitation in 1 hour | 429 Too Many Requests |
| RL-3 | Rate limit resets after window | Request succeeds |
| RL-4 | Rate limit headers present | `X-RateLimit-*` headers in response |

### 4.6 Abuse Prevention Tests

| # | Test Case | Expected |
|---|---|---|
| ABUSE-1 | Blocked user sends invitation | Fails with generic "unavailable" error |
| ABUSE-2 | Duplicate pending request | 409 Conflict |
| ABUSE-3 | 4th matchmaking restart in 1 hour | 429 Rate limited |
| ABUSE-4 | Send message to room after leaving team | 403 Forbidden |
| ABUSE-5 | Rapid-fire identical chat messages | 2nd message blocked (duplicate detection) |

---

## 5. End-to-End Tests

### E2E-1: New User Journey

```
1. Register account
2. Complete profile (skills, interests, roles)
3. Browse events
4. Register for a hackathon
5. Start looking for teams
6. Discover teams matching skills
7. Send join request with message
8. Receive acceptance notification
9. View team chat
10. Send first message
```

### E2E-2: Team Leader Journey

```
1. Register and create profile
2. Register for event
3. Create team with description and requirements
4. Search for candidates
5. Invite top candidate
6. Candidate accepts
7. Search for another candidate
8. Finalize team
9. View permanent chat
10. Assign roles
```

### E2E-3: Auto-Match Journey

```
1. 16 users register and complete profiles
2. All enter matchmaking queue
3. Organizer triggers matchmaking round
4. 4 provisional teams of 4 created
5. Users view match explanations
6. Users chat in provisional rooms
7. All members of Team 1 accept
8. Team 1 finalizes
9. One member of Team 2 rejects
10. Replacement found and notified
11. Remaining teams finalize
```

### E2E-4: Organizer Journey

```
1. Create event with constraints
2. Configure team size limits and required skills
3. Open registration
4. Monitor participant registrations
5. View skill distribution dashboard
6. Trigger auto-matchmaking
7. View formed teams
8. View unmatched participants
9. Manually assign remaining participant to a team
10. Lock teams when event starts
```

---

## 6. Load / Performance Tests (Pre-Release)

| Scenario | Parameters | Target |
|---|---|---|
| Concurrent registrations | 500 users registering simultaneously | < 500ms p95 response time |
| Team search | 200 concurrent search queries | < 300ms p95 |
| Matchmaking (large pool) | 500 users, team size 4-5 | < 30 seconds total computation |
| Chat message throughput | 100 concurrent users, 10 msgs/sec each | < 100ms message delivery |
| WebSocket connections | 1000 concurrent connections | Stable for 1 hour |
| Join request spike | 50 users requesting same team simultaneously | Exactly 1 succeeds per slot |

---

## Testing Tools

| Layer | Tool | Rationale |
|---|---|---|
| Unit tests | Jest (Node) / Pytest (Python) | Standard, well-supported |
| Integration tests | Supertest (Node) / httpx (Python) + test DB | Real HTTP requests against test server |
| Database | Docker PostgreSQL (test container) | Isolated, disposable test database |
| Concurrency | Custom test harness with async workers | Simulate true concurrent requests |
| E2E | Playwright | Browser automation for full user flows |
| Load | k6 / Artillery | Scriptable load testing |
| Security | OWASP ZAP (automated scan) | Vulnerability scanning |

---

## CI/CD Integration

```
On every pull request:
  1. Lint + type check
  2. Unit tests (parallelized)
  3. Integration tests (with test DB)
  4. Security scan (dependency audit)

On merge to main:
  5. Full test suite including concurrency tests
  6. Build and push container images

Pre-release:
  7. Load tests against staging
  8. OWASP ZAP scan against staging
  9. Manual E2E verification
```
