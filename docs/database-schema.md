# Database Schema — TeamForge

## Design Principles

1. **Event-scoped isolation** — Availability and membership are per-event, never global.
2. **ACID for state transitions** — All membership changes use `SELECT ... FOR UPDATE` or advisory locks.
3. **Explicit state columns** — No implicit states; every entity has an enum status column.
4. **Soft deletes** — Critical entities use `deleted_at` timestamps rather than hard deletes.
5. **Audit trail** — Created/updated timestamps on every table; membership changes are logged.

---

## Entity-Relationship Diagram

```
┌──────────┐       ┌─────────────────┐       ┌──────────┐
│  users   │──1:N──│ user_profiles   │       │  events  │
└──────────┘       │ (skills, roles) │       └──────────┘
     │             └─────────────────┘            │
     │                                            │
     │  ┌─────────────────────────────────────┐   │
     └──│       event_participants            │───┘
        │  (user ↔ event, availability state) │
        └──────────────┬──────────────────────┘
                       │
        ┌──────────────┼──────────────────────┐
        │              │                      │
  ┌─────▼──────┐ ┌─────▼──────┐  ┌────────────▼──────────┐
  │   teams    │ │ provisional│  │  requests_invitations  │
  │            │ │ _teams     │  │                        │
  └─────┬──────┘ └─────┬──────┘  └────────────────────────┘
        │              │
  ┌─────▼──────┐ ┌─────▼──────┐
  │ team_      │ │ prov_team_ │
  │ members    │ │ members    │
  └────────────┘ └────────────┘
        │              │
        └──────┬───────┘
               │
        ┌──────▼───────┐
        │  chat_rooms  │──1:N──▶ chat_messages
        └──────────────┘
```

---

## Tables

### 1. `users`

Primary identity table. Authentication credentials and global profile.

```sql
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    display_name    VARCHAR(100) NOT NULL,
    avatar_url      TEXT,
    bio             TEXT,
    is_verified     BOOLEAN DEFAULT FALSE,
    is_admin        BOOLEAN DEFAULT FALSE,      -- Platform-level admin
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ                  -- Soft delete
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_display_name ON users(display_name);
```

---

### 2. `user_skills`

Normalized skill entries per user. Skills are stored as structured data, not free-text.

```sql
CREATE TABLE user_skills (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    skill_name      VARCHAR(100) NOT NULL,       -- Normalized name (e.g., "react")
    skill_display   VARCHAR(100) NOT NULL,       -- User-entered display (e.g., "React.js")
    proficiency     SMALLINT NOT NULL CHECK (proficiency BETWEEN 1 AND 5),
                    -- 1=Beginner, 2=Elementary, 3=Intermediate, 4=Advanced, 5=Expert
    years_experience NUMERIC(3,1),               -- e.g., 2.5 years
    created_at      TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(user_id, skill_name)
);

CREATE INDEX idx_user_skills_user ON user_skills(user_id);
CREATE INDEX idx_user_skills_name ON user_skills(skill_name);
```

---

### 3. `user_interests`

```sql
CREATE TABLE user_interests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    interest_name   VARCHAR(100) NOT NULL,       -- Normalized
    interest_display VARCHAR(100) NOT NULL,       -- User-entered

    UNIQUE(user_id, interest_name)
);

CREATE INDEX idx_user_interests_user ON user_interests(user_id);
```

---

### 4. `user_preferred_roles`

```sql
CREATE TABLE user_preferred_roles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_name       VARCHAR(100) NOT NULL,        -- e.g., "frontend_developer"
    role_display    VARCHAR(100) NOT NULL,         -- e.g., "Frontend Developer"
    priority        SMALLINT DEFAULT 1,            -- 1 = most preferred

    UNIQUE(user_id, role_name)
);

CREATE INDEX idx_user_roles_user ON user_preferred_roles(user_id);
```

---

### 5. `events`

An event/project context within which team formation occurs.

```sql
CREATE TABLE events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id        UUID NOT NULL REFERENCES users(id),
    name                VARCHAR(200) NOT NULL,
    description         TEXT,
    event_type          VARCHAR(50) NOT NULL CHECK (event_type IN (
                            'hackathon', 'academic_project', 'competition',
                            'research_project', 'other'
                        )),
    min_team_size       SMALLINT NOT NULL DEFAULT 2 CHECK (min_team_size >= 1),
    max_team_size       SMALLINT NOT NULL DEFAULT 5 CHECK (max_team_size >= min_team_size),
    registration_opens  TIMESTAMPTZ,
    registration_closes TIMESTAMPTZ,
    event_starts        TIMESTAMPTZ,
    event_ends          TIMESTAMPTZ,
    matchmaking_enabled BOOLEAN DEFAULT TRUE,
    auto_match_timeout  INTERVAL DEFAULT '48 hours',   -- Provisional team expiry
    status              VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN (
                            'draft', 'registration_open', 'registration_closed',
                            'in_progress', 'completed', 'cancelled'
                        )),
    settings            JSONB DEFAULT '{}',             -- Flexible event config
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_events_organizer ON events(organizer_id);
CREATE INDEX idx_events_status ON events(status);
```

---

### 6. `event_required_skills`

Hard/soft constraints defined by the organizer.

```sql
CREATE TABLE event_required_skills (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    skill_name      VARCHAR(100) NOT NULL,
    constraint_type VARCHAR(10) NOT NULL CHECK (constraint_type IN ('hard', 'soft')),
                    -- hard = every team must have this
                    -- soft = preferred but not mandatory

    UNIQUE(event_id, skill_name)
);
```

---

### 7. `event_required_roles`

```sql
CREATE TABLE event_required_roles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    role_name       VARCHAR(100) NOT NULL,
    constraint_type VARCHAR(10) NOT NULL CHECK (constraint_type IN ('hard', 'soft')),

    UNIQUE(event_id, role_name)
);
```

---

### 8. `event_participants`

**Central availability state table.** Tracks each user's status within an event.

```sql
CREATE TABLE event_participants (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id            UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status              VARCHAR(30) NOT NULL DEFAULT 'registered' CHECK (status IN (
                            'registered',           -- Signed up but not yet looking
                            'looking_for_team',     -- Available for manual/auto matching
                            'in_matchmaking',       -- Currently being processed by auto-match
                            'in_provisional_team',  -- In a provisional group
                            'in_finalized_team',    -- Committed to a permanent team
                            'withdrawn'             -- Left the event
                        )),
    team_id             UUID REFERENCES teams(id),           -- NULL until finalized
    provisional_team_id UUID REFERENCES provisional_teams(id), -- NULL unless in provisional
    matchmaking_restarts SMALLINT DEFAULT 0,                  -- Rate-limit counter
    last_matchmaking_at TIMESTAMPTZ,
    profile_snapshot    JSONB,                                -- Frozen profile for matchmaking
    registered_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(event_id, user_id)
);

CREATE INDEX idx_ep_event_status ON event_participants(event_id, status);
CREATE INDEX idx_ep_user ON event_participants(user_id);
CREATE INDEX idx_ep_team ON event_participants(team_id);
CREATE INDEX idx_ep_provisional ON event_participants(provisional_team_id);
```

> **Concurrency Note:** All status transitions on this table MUST use `SELECT ... FOR UPDATE` to prevent race conditions (e.g., two teams accepting the same user simultaneously).

---

### 9. `teams`

Finalized (permanent) teams.

```sql
CREATE TABLE teams (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name            VARCHAR(200) NOT NULL,
    description     TEXT,
    owner_id        UUID NOT NULL REFERENCES users(id),
    status          VARCHAR(20) NOT NULL DEFAULT 'forming' CHECK (status IN (
                        'forming',          -- Manually created, still recruiting
                        'finalized',        -- All slots filled or owner finalized
                        'locked',           -- Event started, no more changes
                        'dissolved'         -- Team disbanded
                    )),
    max_size        SMALLINT NOT NULL,       -- Inherits from event or custom
    project_idea    TEXT,
    chat_room_id    UUID,                    -- Link to permanent chat
    source          VARCHAR(20) DEFAULT 'manual' CHECK (source IN (
                        'manual',           -- Created by user
                        'auto_match'        -- Created from provisional team
                    )),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_teams_event ON teams(event_id, status);
CREATE INDEX idx_teams_owner ON teams(owner_id);
```

---

### 10. `team_members`

```sql
CREATE TABLE team_members (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id         UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_in_team    VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role_in_team IN (
                        'owner',            -- Full permissions
                        'admin',            -- Can invite, manage
                        'member'            -- Basic member
                    )),
    assigned_role   VARCHAR(100),            -- e.g., "Frontend Developer"
    joined_at       TIMESTAMPTZ DEFAULT NOW(),
    left_at         TIMESTAMPTZ,             -- NULL if still active

    UNIQUE(team_id, user_id)
);

CREATE INDEX idx_tm_team ON team_members(team_id) WHERE left_at IS NULL;
CREATE INDEX idx_tm_user ON team_members(user_id) WHERE left_at IS NULL;
```

---

### 11. `team_requirements`

What the team is looking for (must-have / nice-to-have).

```sql
CREATE TABLE team_requirements (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id         UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    requirement_type VARCHAR(10) NOT NULL CHECK (requirement_type IN ('skill', 'role')),
    name            VARCHAR(100) NOT NULL,
    priority        VARCHAR(15) NOT NULL CHECK (priority IN ('must_have', 'nice_to_have')),

    UNIQUE(team_id, requirement_type, name)
);

CREATE INDEX idx_tr_team ON team_requirements(team_id);
```

---

### 12. `provisional_teams`

Auto-match generated candidate teams.

```sql
CREATE TABLE provisional_teams (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN (
                        'pending',          -- Awaiting member responses
                        'accepted',         -- All required members accepted
                        'dissolved',        -- Could not reach consensus
                        'expired',          -- Timed out
                        'converted'         -- Became a finalized team
                    )),
    target_size     SMALLINT NOT NULL,
    match_score     NUMERIC(5,3),            -- Overall team score from algorithm
    match_explanation JSONB,                  -- Structured explanation data
    created_by_round VARCHAR(50),             -- Matchmaking round identifier
    chat_room_id    UUID,                     -- Link to provisional chat
    expires_at      TIMESTAMPTZ NOT NULL,     -- Auto-dissolve deadline
    finalized_team_id UUID REFERENCES teams(id), -- Set on conversion
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pt_event ON provisional_teams(event_id, status);
```

---

### 13. `provisional_team_members`

```sql
CREATE TABLE provisional_team_members (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provisional_team_id UUID NOT NULL REFERENCES provisional_teams(id) ON DELETE CASCADE,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status              VARCHAR(15) NOT NULL DEFAULT 'pending' CHECK (status IN (
                            'pending',      -- Hasn't responded
                            'accepted',     -- Accepted the match
                            'rejected',     -- Rejected the match
                            'left',         -- Left after initial view
                            'expired',      -- Didn't respond in time
                            'replaced'      -- Was replaced by another candidate
                        )),
    match_reason        JSONB,               -- Why this user was matched here
    responded_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(provisional_team_id, user_id)
);

CREATE INDEX idx_ptm_prov ON provisional_team_members(provisional_team_id, status);
CREATE INDEX idx_ptm_user ON provisional_team_members(user_id);
```

---

### 14. `requests_invitations`

Unified table for all request/invitation types.

```sql
CREATE TABLE requests_invitations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    type            VARCHAR(20) NOT NULL CHECK (type IN (
                        'join_request',     -- User → Team
                        'team_invite',      -- Team → User
                        'personal_invite'   -- User → Known person (to their team)
                    )),
    sender_id       UUID NOT NULL REFERENCES users(id),
    recipient_id    UUID NOT NULL REFERENCES users(id),     -- The invited user or team owner
    team_id         UUID REFERENCES teams(id),               -- Target team
    status          VARCHAR(15) NOT NULL DEFAULT 'pending' CHECK (status IN (
                        'pending',
                        'accepted',
                        'rejected',
                        'cancelled',        -- Sender withdrew
                        'expired'           -- Time-based expiry
                    )),
    message         TEXT,                    -- Optional cover message
    expires_at      TIMESTAMPTZ,
    responded_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Prevent duplicate pending requests of the same type
CREATE UNIQUE INDEX idx_ri_no_duplicate_pending
    ON requests_invitations(event_id, type, sender_id, recipient_id, team_id)
    WHERE status = 'pending';

CREATE INDEX idx_ri_recipient ON requests_invitations(recipient_id, status);
CREATE INDEX idx_ri_sender ON requests_invitations(sender_id, status);
CREATE INDEX idx_ri_team ON requests_invitations(team_id, status);
CREATE INDEX idx_ri_expires ON requests_invitations(expires_at) WHERE status = 'pending';
```

---

### 15. `chat_rooms`

```sql
CREATE TABLE chat_rooms (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_type       VARCHAR(15) NOT NULL CHECK (room_type IN (
                        'provisional',      -- Temporary matchmaking chat
                        'permanent'         -- Finalized team chat
                    )),
    team_id         UUID REFERENCES teams(id),
    provisional_team_id UUID REFERENCES provisional_teams(id),
    status          VARCHAR(15) NOT NULL DEFAULT 'active' CHECK (status IN (
                        'active',
                        'archived',         -- Read-only
                        'deleted'
                    )),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_cr_team ON chat_rooms(team_id);
CREATE INDEX idx_cr_provisional ON chat_rooms(provisional_team_id);
```

---

### 16. `chat_messages`

```sql
CREATE TABLE chat_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id         UUID NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
    sender_id       UUID NOT NULL REFERENCES users(id),
    content         TEXT NOT NULL,
    message_type    VARCHAR(15) DEFAULT 'text' CHECK (message_type IN (
                        'text', 'system', 'file'
                    )),
    is_deleted      BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_cm_room_time ON chat_messages(room_id, created_at DESC);
CREATE INDEX idx_cm_sender ON chat_messages(sender_id);
```

---

### 17. `notifications`

```sql
CREATE TABLE notifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id        UUID REFERENCES events(id),
    type            VARCHAR(50) NOT NULL,        -- e.g., 'team_invite', 'match_proposed'
    title           VARCHAR(200) NOT NULL,
    body            TEXT,
    data            JSONB DEFAULT '{}',          -- Structured payload for deep-linking
    is_read         BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notif_user_unread ON notifications(user_id, is_read, created_at DESC)
    WHERE is_read = FALSE;
```

---

### 18. `user_blocks`

```sql
CREATE TABLE user_blocks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blocker_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(blocker_id, blocked_id),
    CHECK(blocker_id != blocked_id)
);
```

---

### 19. `reports`

```sql
CREATE TABLE reports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id     UUID NOT NULL REFERENCES users(id),
    reported_id     UUID NOT NULL REFERENCES users(id),
    event_id        UUID REFERENCES events(id),
    reason          VARCHAR(50) NOT NULL CHECK (reason IN (
                        'spam', 'harassment', 'inappropriate_content',
                        'fake_profile', 'other'
                    )),
    description     TEXT,
    status          VARCHAR(20) DEFAULT 'pending' CHECK (status IN (
                        'pending', 'reviewing', 'resolved', 'dismissed'
                    )),
    resolved_by     UUID REFERENCES users(id),
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_reports_status ON reports(status, created_at);
```

---

### 20. `matchmaking_rounds`

Tracks algorithmic matchmaking runs for auditability.

```sql
CREATE TABLE matchmaking_rounds (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID NOT NULL REFERENCES events(id),
    status          VARCHAR(15) NOT NULL DEFAULT 'running' CHECK (status IN (
                        'running', 'completed', 'failed'
                    )),
    participants_count  INTEGER,
    teams_formed        INTEGER,
    unmatched_count     INTEGER,
    algorithm_params    JSONB,               -- Weights, constraints used
    started_at          TIMESTAMPTZ DEFAULT NOW(),
    completed_at        TIMESTAMPTZ
);

CREATE INDEX idx_mr_event ON matchmaking_rounds(event_id);
```

---

## Concurrency Control Patterns

### Pattern 1: Claiming a Team Slot

```sql
BEGIN;

-- Lock the participant row
SELECT status FROM event_participants
    WHERE event_id = $1 AND user_id = $2
    FOR UPDATE;

-- Verify user is still available
-- (status must be 'looking_for_team')

-- Lock the team row to count members
SELECT COUNT(*) as member_count, t.max_size
    FROM team_members tm
    JOIN teams t ON t.id = tm.team_id
    WHERE tm.team_id = $3 AND tm.left_at IS NULL
    FOR UPDATE OF t;

-- Verify slot available (member_count < max_size)

-- Insert member and update participant status
INSERT INTO team_members (team_id, user_id, role_in_team) VALUES ($3, $2, 'member');
UPDATE event_participants SET status = 'in_finalized_team', team_id = $3
    WHERE event_id = $1 AND user_id = $2;

-- Cancel any other pending requests/invitations for this user in this event
UPDATE requests_invitations SET status = 'cancelled'
    WHERE event_id = $1
    AND (recipient_id = $2 OR sender_id = $2)
    AND status = 'pending';

COMMIT;
```

### Pattern 2: Accepting a Provisional Team

```sql
BEGIN;

-- Lock the participant row
SELECT status FROM event_participants
    WHERE event_id = $1 AND user_id = $2
    FOR UPDATE;

-- Lock the provisional team member row
SELECT status FROM provisional_team_members
    WHERE provisional_team_id = $3 AND user_id = $2
    FOR UPDATE;

-- Update member acceptance
UPDATE provisional_team_members
    SET status = 'accepted', responded_at = NOW()
    WHERE provisional_team_id = $3 AND user_id = $2;

-- Check if all members have accepted
-- If so, convert to finalized team (separate service logic)

COMMIT;
```

---

## Migration Strategy

- Use an ORM migration tool (Prisma Migrate / Alembic).
- All schema changes are version-controlled.
- Destructive migrations require manual approval.
- Data migrations run in transactions with savepoints.
