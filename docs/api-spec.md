# API Specification — TeamForge

## Base URL

```
Production:  https://api.teamforge.dev/v1
Development: http://localhost:3000/v1
WebSocket:   wss://api.teamforge.dev/ws
```

## Common Patterns

### Authentication

All endpoints (except auth) require a Bearer token:

```
Authorization: Bearer <jwt_access_token>
```

### Pagination

List endpoints support cursor-based pagination:

```
GET /resource?limit=20&cursor=<opaque_cursor>
```

Response includes:

```json
{
  "data": [...],
  "pagination": {
    "next_cursor": "eyJpZCI6...",
    "has_more": true,
    "total_count": 142
  }
}
```

### Error Response Format

```json
{
  "error": {
    "code": "TEAM_FULL",
    "message": "This team has no available slots.",
    "details": {
      "team_id": "uuid",
      "max_size": 5,
      "current_size": 5
    }
  }
}
```

### Standard HTTP Status Codes

| Code | Usage |
|---|---|
| 200 | Success (with body) |
| 201 | Created |
| 204 | Success (no body) |
| 400 | Validation error |
| 401 | Unauthenticated |
| 403 | Forbidden |
| 404 | Not found |
| 409 | Conflict (e.g., duplicate, state violation) |
| 429 | Rate limited |
| 500 | Internal server error |

---

## I. API Endpoints

### 1. Authentication

#### `POST /auth/register`

Create a new user account.

```json
// Request
{
  "email": "user@example.com",
  "password": "securePassword123!",
  "display_name": "Jane Doe"
}

// Response 201
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "display_name": "Jane Doe",
    "created_at": "2026-09-26T10:00:00Z"
  },
  "tokens": {
    "access_token": "eyJ...",
    "refresh_token": "eyJ...",
    "expires_in": 3600
  }
}
```

#### `POST /auth/login`

```json
// Request
{
  "email": "user@example.com",
  "password": "securePassword123!"
}

// Response 200 — same token structure as register
```

#### `POST /auth/refresh`

```json
// Request
{
  "refresh_token": "eyJ..."
}

// Response 200
{
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",    // Rotated
  "expires_in": 3600
}
```

#### `POST /auth/logout`

Invalidate the current refresh token.

```
// Response 204
```

---

### 2. User Profile

#### `GET /users/me`

Get the authenticated user's profile.

```json
// Response 200
{
  "id": "uuid",
  "email": "user@example.com",
  "display_name": "Jane Doe",
  "avatar_url": "https://...",
  "bio": "Full-stack developer with 3 years experience...",
  "skills": [
    { "skill_name": "react", "skill_display": "React.js", "proficiency": 4, "years_experience": 2.5 },
    { "skill_name": "python", "skill_display": "Python", "proficiency": 3, "years_experience": 1.0 }
  ],
  "interests": [
    { "interest_name": "machine_learning", "interest_display": "Machine Learning" },
    { "interest_name": "web_development", "interest_display": "Web Development" }
  ],
  "preferred_roles": [
    { "role_name": "frontend_developer", "role_display": "Frontend Developer", "priority": 1 },
    { "role_name": "ui_ux_designer", "role_display": "UI/UX Designer", "priority": 2 }
  ],
  "created_at": "2026-09-26T10:00:00Z"
}
```

#### `PUT /users/me`

Update profile. Partial updates supported.

```json
// Request
{
  "display_name": "Jane D.",
  "bio": "Updated bio..."
}

// Response 200 — updated user object
```

#### `PUT /users/me/skills`

Replace entire skill list.

```json
// Request
{
  "skills": [
    { "skill_display": "React.js", "proficiency": 4, "years_experience": 2.5 },
    { "skill_display": "Python", "proficiency": 3, "years_experience": 1.0 },
    { "skill_display": "TypeScript", "proficiency": 4, "years_experience": 2.0 }
  ]
}

// Response 200 — normalized skills returned
```

#### `PUT /users/me/interests`

```json
// Request
{
  "interests": [
    { "interest_display": "Machine Learning" },
    { "interest_display": "Web Development" }
  ]
}
```

#### `PUT /users/me/roles`

```json
// Request
{
  "preferred_roles": [
    { "role_display": "Frontend Developer", "priority": 1 },
    { "role_display": "UI/UX Designer", "priority": 2 }
  ]
}
```

#### `GET /users/:id`

Get a public user profile. Restricted fields are omitted (email, etc.).

#### `GET /users/search`

Search users. Used by teams looking for members.

```
GET /users/search?event_id=uuid&skills=react,python&roles=frontend_developer&status=looking_for_team&limit=20
```

```json
// Response 200
{
  "data": [
    {
      "user": { /* public profile */ },
      "relevance_score": 0.85,
      "matching_skills": ["react"],
      "matching_roles": ["frontend_developer"]
    }
  ],
  "pagination": { ... }
}
```

---

### 3. Events

#### `GET /events`

List events. Filterable by status, type.

```
GET /events?status=registration_open&type=hackathon&limit=20
```

#### `GET /events/:id`

Get event details.

```json
// Response 200
{
  "id": "uuid",
  "name": "Hackathon 2026",
  "description": "Annual university hackathon...",
  "event_type": "hackathon",
  "organizer": { "id": "uuid", "display_name": "Org Name" },
  "min_team_size": 3,
  "max_team_size": 5,
  "registration_opens": "2026-10-01T00:00:00Z",
  "registration_closes": "2026-10-15T00:00:00Z",
  "event_starts": "2026-10-20T09:00:00Z",
  "event_ends": "2026-10-22T18:00:00Z",
  "matchmaking_enabled": true,
  "required_skills": [
    { "skill_name": "python", "constraint_type": "hard" },
    { "skill_name": "ml", "constraint_type": "soft" }
  ],
  "required_roles": [
    { "role_name": "developer", "constraint_type": "hard" }
  ],
  "status": "registration_open",
  "participant_count": 142,
  "team_count": 28,
  "looking_count": 34
}
```

#### `POST /events` *(Organizer only)*

Create a new event.

#### `PUT /events/:id` *(Organizer only)*

Update event details and constraints.

#### `POST /events/:id/register`

Register for an event.

```json
// Response 201
{
  "participant": {
    "event_id": "uuid",
    "user_id": "uuid",
    "status": "registered",
    "registered_at": "2026-09-26T10:00:00Z"
  }
}
```

#### `PUT /events/:id/participation`

Update participation status (e.g., start looking, withdraw).

```json
// Request
{
  "status": "looking_for_team"
}

// Response 200
```

#### `GET /events/:id/participants`

List participants. Filterable by status.

```
GET /events/:id/participants?status=looking_for_team&skills=react&limit=20
```

---

### 4. Teams

#### `POST /events/:event_id/teams`

Create a team within an event.

```json
// Request
{
  "name": "Team Alpha",
  "description": "Building an AI-powered study tool",
  "max_size": 4,
  "project_idea": "An NLP-based tool that...",
  "requirements": [
    { "type": "skill", "name": "React", "priority": "must_have" },
    { "type": "skill", "name": "UI/UX", "priority": "nice_to_have" },
    { "type": "role", "name": "Frontend Developer", "priority": "must_have" }
  ]
}

// Response 201
{
  "team": {
    "id": "uuid",
    "name": "Team Alpha",
    "owner": { "id": "uuid", "display_name": "Jane Doe" },
    "status": "forming",
    "current_size": 1,
    "max_size": 4,
    "open_slots": 3,
    ...
  }
}
```

#### `GET /events/:event_id/teams`

List teams. Filterable.

```
GET /events/:event_id/teams?status=forming&needs_skill=react&limit=20
```

#### `GET /events/:event_id/teams/:team_id`

Get team profile (public information).

```json
// Response 200
{
  "id": "uuid",
  "name": "Team Alpha",
  "description": "Building an AI-powered study tool",
  "owner": { "id": "uuid", "display_name": "Jane Doe" },
  "members": [
    {
      "user": { "id": "uuid", "display_name": "Jane Doe", "skills": [...], "preferred_roles": [...] },
      "role_in_team": "owner",
      "assigned_role": "Backend Developer"
    }
  ],
  "current_size": 2,
  "max_size": 4,
  "open_slots": 2,
  "requirements": [...],
  "project_idea": "An NLP-based tool that...",
  "status": "forming",
  "source": "manual"
}
```

#### `PUT /events/:event_id/teams/:team_id` *(Owner/Admin)*

Update team details.

#### `POST /events/:event_id/teams/:team_id/finalize` *(Owner only)*

Finalize the team.

```json
// Response 200
{
  "team": { ...status: "finalized"... },
  "chat_room": { "id": "uuid", "room_type": "permanent" }
}
```

#### `POST /events/:event_id/teams/:team_id/dissolve` *(Owner only)*

Dissolve the team. All members returned to `looking_for_team`.

#### `DELETE /events/:event_id/teams/:team_id/members/:user_id` *(Owner/Admin)*

Remove a member.

#### `POST /events/:event_id/teams/:team_id/leave`

Current user leaves the team.

#### `POST /events/:event_id/teams/:team_id/transfer-ownership` *(Owner only)*

```json
// Request
{ "new_owner_id": "uuid" }
```

#### `GET /events/:event_id/teams/discover`

Discover teams for the current user.

```
GET /events/:event_id/teams/discover?mode=match_my_skills&limit=20
GET /events/:event_id/teams/discover?mode=explore&limit=20
```

```json
// Response 200 (match_my_skills mode)
{
  "data": [
    {
      "team": { /* team profile */ },
      "match_score": 0.82,
      "matching_skills": ["react", "typescript"],
      "matching_roles": ["Frontend Developer"],
      "why_good_fit": "This team needs your React and TypeScript skills."
    }
  ]
}
```

#### `GET /events/:event_id/teams/:team_id/candidates`

Search for candidates to add to the team. *(Owner/Admin)*

```
GET /events/:event_id/teams/:team_id/candidates?limit=20
```

```json
// Response 200
{
  "data": [
    {
      "user": { /* public profile */ },
      "marginal_contribution": 0.12,
      "must_have_match": ["react"],
      "nice_to_have_match": ["figma"],
      "role_match": "Frontend Developer",
      "overall_score": 0.78
    }
  ]
}
```

---

### 5. Requests & Invitations

#### `POST /events/:event_id/requests`

Create a join request or invitation.

```json
// Join request (User → Team)
{
  "type": "join_request",
  "team_id": "uuid",
  "message": "I'd love to join! I have experience with..."
}

// Team invite (Team → User)
{
  "type": "team_invite",
  "recipient_id": "uuid",
  "team_id": "uuid",
  "message": "We think your React skills would be great for our team."
}

// Personal invite (User → Known person)
{
  "type": "personal_invite",
  "recipient_id": "uuid",
  "team_id": "uuid",
  "message": "Hey! Want to join my team for this hackathon?"
}

// Response 201
{
  "request": {
    "id": "uuid",
    "type": "join_request",
    "status": "pending",
    "sender": { ... },
    "recipient": { ... },
    "team": { ... },
    "expires_at": "2026-10-10T00:00:00Z",
    "created_at": "2026-09-26T10:00:00Z"
  }
}
```

#### `GET /events/:event_id/requests`

List requests (sent and received).

```
GET /events/:event_id/requests?direction=received&status=pending&type=team_invite
```

#### `PUT /events/:event_id/requests/:request_id`

Respond to a request.

```json
// Accept
{ "action": "accept" }

// Reject
{ "action": "reject" }

// Cancel (sender only)
{ "action": "cancel" }

// Response 200
{
  "request": { ...status: "accepted"... },
  "side_effects": {
    "team_joined": { "id": "uuid", "name": "Team Alpha" },
    "cancelled_requests": 3    // Other pending requests auto-cancelled
  }
}
```

---

### 6. Matchmaking

#### `POST /events/:event_id/matchmaking/enter`

Enter the auto-match queue.

```json
// Response 200
{
  "status": "in_matchmaking",
  "position_in_queue": 12,
  "estimated_wait": "Next round starts when 20+ participants are queued"
}
```

#### `POST /events/:event_id/matchmaking/leave`

Leave the auto-match queue.

#### `GET /events/:event_id/matchmaking/status`

Check matchmaking status.

#### `POST /events/:event_id/matchmaking/run` *(Organizer only)*

Trigger a matchmaking round manually.

```json
// Request (optional overrides)
{
  "weights": {
    "skill_diversity": 0.20,
    "skill_coverage": 0.25,
    "role_coverage": 0.20,
    "experience_balance": 0.10,
    "interest_compatibility": 0.15,
    "preference_satisfaction": 0.10
  }
}

// Response 202 (Accepted — async operation)
{
  "round_id": "uuid",
  "status": "running",
  "participants_count": 48
}
```

---

### 7. Provisional Teams

#### `GET /events/:event_id/provisional-teams/:pt_id`

Get provisional team details.

```json
// Response 200
{
  "id": "uuid",
  "status": "pending",
  "members": [
    {
      "user": { /* profile */ },
      "status": "accepted",
      "match_reason": { /* per-user explanation */ }
    },
    {
      "user": { /* profile */ },
      "status": "pending",
      "match_reason": { /* per-user explanation */ }
    }
  ],
  "match_explanation": { /* team-level explanation */ },
  "expires_at": "2026-09-28T10:00:00Z",
  "chat_room_id": "uuid"
}
```

#### `POST /events/:event_id/provisional-teams/:pt_id/respond`

Accept or reject a provisional team placement.

```json
// Request
{ "action": "accept" }   // or "reject"

// Response 200
{
  "member_status": "accepted",
  "team_status": "pending",       // or "accepted" if you were the last one
  "awaiting_response_from": 1     // N members still pending
}
```

---

### 8. Chat

#### `GET /chat/rooms/:room_id/messages`

Get message history (paginated).

```
GET /chat/rooms/:room_id/messages?limit=50&before=<message_id>
```

#### `POST /chat/rooms/:room_id/messages`

Send a message (also works via WebSocket).

```json
// Request
{
  "content": "Hey team! Excited to work together."
}
```

---

### 9. Notifications

#### `GET /notifications`

```
GET /notifications?unread_only=true&limit=20
```

#### `PUT /notifications/:id/read`

Mark notification as read.

#### `PUT /notifications/read-all`

Mark all notifications as read.

---

### 10. Admin / Organizer

#### `GET /admin/events/:event_id/dashboard`

Organizer dashboard data.

```json
// Response 200
{
  "participant_count": 142,
  "team_count": 28,
  "looking_count": 34,
  "in_matchmaking_count": 12,
  "in_provisional_count": 8,
  "finalized_count": 88,
  "unmatched_count": 34,
  "skill_distribution": {
    "python": 67,
    "react": 45,
    "ml": 38,
    ...
  },
  "role_distribution": {
    "backend_developer": 42,
    "frontend_developer": 35,
    ...
  },
  "pending_reports": 3
}
```

#### `POST /admin/events/:event_id/teams/:team_id/rebalance` *(Organizer)*

Move a user between teams.

#### `DELETE /admin/events/:event_id/teams/:team_id` *(Organizer)*

Force-dissolve a team.

#### `GET /admin/reports`

View moderation reports.

#### `PUT /admin/reports/:id`

Resolve a report.

---

## WebSocket Events

### Connection

```javascript
const socket = io("wss://api.teamforge.dev/ws", {
  auth: { token: "Bearer <jwt>" }
});
```

### Client → Server Events

| Event | Payload | Description |
|---|---|---|
| `chat:send_message` | `{ room_id, content }` | Send a chat message |
| `chat:typing` | `{ room_id, is_typing }` | Typing indicator |
| `presence:heartbeat` | `{}` | Keep-alive ping |

### Server → Client Events

| Event | Payload | Description |
|---|---|---|
| `chat:new_message` | `{ room_id, message }` | New chat message received |
| `chat:user_typing` | `{ room_id, user_id, is_typing }` | Another user is typing |
| `notification:new` | `{ notification }` | New notification |
| `team:updated` | `{ team_id, changes }` | Team details changed |
| `team:member_joined` | `{ team_id, user }` | New member joined |
| `team:member_left` | `{ team_id, user_id }` | Member left |
| `team:finalized` | `{ team_id }` | Team has been finalized |
| `team:dissolved` | `{ team_id, reason }` | Team was dissolved |
| `provisional:created` | `{ provisional_team }` | You were placed in a provisional team |
| `provisional:member_responded` | `{ pt_id, user_id, status }` | A provisional member accepted/rejected |
| `provisional:replacement` | `{ pt_id, new_member }` | A replacement was found |
| `provisional:dissolved` | `{ pt_id, reason }` | Provisional team dissolved |
| `provisional:converted` | `{ pt_id, team }` | Provisional team became permanent |
| `matchmaking:status` | `{ status, detail }` | Matchmaking queue update |
| `request:received` | `{ request }` | New request/invitation received |
| `request:updated` | `{ request_id, status }` | Request status changed |
