# Security Model — TeamForge

## K. Security Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Security Layers                       │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Layer 1: Edge Protection                          │  │
│  │  • TLS 1.3 termination                             │  │
│  │  • DDoS protection (CloudFlare / AWS Shield)       │  │
│  │  • Global rate limiting                            │  │
│  └────────────────────────────────────────────────────┘  │
│                         │                                │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Layer 2: API Gateway                              │  │
│  │  • JWT validation                                  │  │
│  │  • Route-level rate limiting                       │  │
│  │  • Request size limits                             │  │
│  │  • CORS enforcement                                │  │
│  └────────────────────────────────────────────────────┘  │
│                         │                                │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Layer 3: Application                              │  │
│  │  • Role-based access control (RBAC)                │  │
│  │  • Resource-level authorization                    │  │
│  │  • Input validation & sanitization                 │  │
│  │  • Business logic guards                           │  │
│  └────────────────────────────────────────────────────┘  │
│                         │                                │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Layer 4: Data                                     │  │
│  │  • Encryption at rest (AES-256)                    │  │
│  │  • Database-level constraints                      │  │
│  │  • Audit logging                                   │  │
│  │  • Soft deletes                                    │  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## 1. Authentication

### JWT Token Strategy

```
Access Token:
  - Algorithm: RS256 (asymmetric — public key for verification, private for signing)
  - Expiry: 15 minutes
  - Payload: { sub: user_id, email, is_admin, iat, exp }
  - Stored: In-memory only (not localStorage)

Refresh Token:
  - Algorithm: RS256
  - Expiry: 7 days
  - Payload: { sub: user_id, jti: unique_token_id, iat, exp }
  - Stored: HTTP-only, Secure, SameSite=Strict cookie
  - Server-side: Token family tracked in DB for rotation detection
```

### Token Rotation

```
Client sends refresh token
    → Server validates token
    → Server checks token family (detect reuse attacks)
    → If token was already used:
        → Invalidate entire token family (all refresh tokens for this user)
        → Force re-authentication
        → Alert: possible token theft
    → If token is valid:
        → Issue new access token + new refresh token
        → Mark old refresh token as used
        → Return new tokens
```

### Password Security

| Aspect | Implementation |
|---|---|
| Hashing | bcrypt with cost factor 12 |
| Minimum length | 8 characters |
| Complexity | At least 1 uppercase, 1 lowercase, 1 digit, 1 special character |
| Breached password check | Check against HaveIBeenPwned API (k-anonymity model) — Phase 2 |
| Brute force protection | Account lockout after 5 failed attempts (15-minute cooldown) |

---

## 2. Authorization — Role-Based Access Control

### Platform Roles

| Role | Description |
|---|---|
| `platform_admin` | Full platform access. Can manage all events, users, reports. |
| `user` | Standard user. Can participate in events, create/join teams. |

### Event Roles

| Role | Scope | Permissions |
|---|---|---|
| `organizer` | Per-event | Create/edit event, define constraints, view all participants, run matchmaking, moderate, force-dissolve teams, rebalance |
| `participant` | Per-event | Register, create/join teams, search, chat, matchmaking |

### Team Roles

| Role | Scope | Permissions |
|---|---|---|
| `owner` | Per-team | All team operations: edit, invite, remove members, finalize, dissolve, transfer ownership |
| `admin` | Per-team | Invite members, remove non-admin members, edit team details |
| `member` | Per-team | View team, chat, leave team |

### Authorization Matrix

```
Resource: Team
┌──────────────────────┬───────┬───────┬────────┬───────────┐
│ Action               │ Owner │ Admin │ Member │ Non-member│
├──────────────────────┼───────┼───────┼────────┼───────────┤
│ View team profile    │  ✓    │  ✓    │  ✓     │  ✓ *      │
│ Edit team details    │  ✓    │  ✓    │  ✗     │  ✗        │
│ Invite user          │  ✓    │  ✓    │  ✗     │  ✗        │
│ Accept join request  │  ✓    │  ✓    │  ✗     │  ✗        │
│ Remove member        │  ✓    │  ✓ ** │  ✗     │  ✗        │
│ Finalize team        │  ✓    │  ✗    │  ✗     │  ✗        │
│ Dissolve team        │  ✓    │  ✗    │  ✗     │  ✗        │
│ Transfer ownership   │  ✓    │  ✗    │  ✗     │  ✗        │
│ Leave team           │  ✓    │  ✓    │  ✓     │  ✗        │
│ Access team chat     │  ✓    │  ✓    │  ✓     │  ✗        │
│ Send join request    │  ✗    │  ✗    │  ✗     │  ✓        │
└──────────────────────┴───────┴───────┴────────┴───────────┘
* Public fields only (no chat, no internal details)
** Admins can remove members but not other admins or the owner
```

### Authorization Middleware

```javascript
// Pseudocode — applied as middleware on each route
async function authorize(req, res, next) {
    const user = req.auth.user;
    const resource = await loadResource(req.params);
    
    // 1. Platform-level check
    if (route.requiresPlatformAdmin && !user.is_admin) {
        return res.status(403).json({ error: "PLATFORM_ADMIN_REQUIRED" });
    }
    
    // 2. Event-level check
    if (route.requiresOrganizer) {
        const event = await getEvent(req.params.event_id);
        if (event.organizer_id !== user.id && !user.is_admin) {
            return res.status(403).json({ error: "ORGANIZER_REQUIRED" });
        }
    }
    
    // 3. Team-level check
    if (route.requiresTeamRole) {
        const membership = await getTeamMembership(req.params.team_id, user.id);
        if (!membership || !route.allowedRoles.includes(membership.role_in_team)) {
            return res.status(403).json({ error: "INSUFFICIENT_TEAM_ROLE" });
        }
    }
    
    next();
}
```

---

## 3. Resource-Level Access Control

### Chat Access

```
Permanent chat room:
  - Accessible only by active team members (team_members where left_at IS NULL)
  - Verified on WebSocket connection AND on each message send
  - Room ID is not guessable (UUID)

Provisional chat room:
  - Accessible only by provisional team members (status IN ('pending', 'accepted'))
  - Read-only after provisional team is dissolved/expired/converted
```

### Profile Data Exposure

| Field | Owner | Same-event participant | Public |
|---|---|---|---|
| Email | ✓ | ✗ | ✗ |
| Display name | ✓ | ✓ | ✓ |
| Bio | ✓ | ✓ | ✓ |
| Skills & proficiency | ✓ | ✓ | ✓ |
| Interests | ✓ | ✓ | ✓ |
| Preferred roles | ✓ | ✓ | ✓ |
| Avatar | ✓ | ✓ | ✓ |
| Event participation status | ✓ | ✓ | ✗ |
| Team membership | ✓ | ✓ (team name only) | ✗ |
| Last login | ✓ | ✗ | ✗ |

---

## 4. Input Validation & Sanitization

### Validation Rules

| Field | Constraints |
|---|---|
| `email` | RFC 5322 format, max 255 chars, lowercase normalized |
| `display_name` | 2–100 chars, no HTML, trimmed whitespace |
| `bio` | Max 2000 chars, sanitized (strip HTML tags) |
| `password` | 8–128 chars, complexity requirements |
| `skill_display` | 1–100 chars, no HTML |
| `proficiency` | Integer 1–5 |
| `years_experience` | Decimal 0.0–50.0 |
| `team_name` | 2–200 chars, no HTML |
| `team_description` | Max 5000 chars, sanitized |
| `chat_message` | 1–5000 chars, sanitized (allow limited markdown) |
| `message` (request) | Max 500 chars, sanitized |

### XSS Prevention

```
1. All text outputs are HTML-entity encoded on the server
2. Content-Security-Policy header set:
   Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https:;
3. X-Content-Type-Options: nosniff
4. X-Frame-Options: DENY
5. Chat messages are rendered as plain text (no raw HTML)
6. User bios support limited markdown (bold, italic, links) — rendered with a safe markdown library that strips all HTML
```

### SQL Injection Prevention

- **Mandatory:** All queries use parameterized statements (prepared statements / query builder).
- **Forbidden:** String concatenation for SQL queries.
- **ORM:** Prisma / SQLAlchemy provide injection protection by default.
- **Audit:** No raw SQL queries allowed without team review.

---

## 5. Rate Limiting

### Global Limits

| Scope | Limit | Window |
|---|---|---|
| Unauthenticated requests | 30 requests | per minute per IP |
| Authenticated requests | 120 requests | per minute per user |
| Authentication endpoints | 5 attempts | per minute per IP |
| Account creation | 3 accounts | per hour per IP |

### Action-Specific Limits

| Action | Limit | Window | Rationale |
|---|---|---|---|
| Send invitation | 20 invitations | per hour per user | Prevent invitation spam |
| Send join request | 10 requests | per hour per user | Prevent mass applications |
| Send chat message | 60 messages | per minute per user | Prevent message spam |
| Enter matchmaking | 3 times | per hour per user per event | Prevent algorithmic churn |
| Create team | 5 teams | per hour per user | Prevent team-creation spam |
| Profile update | 30 updates | per hour per user | Prevent excessive API usage |
| Search queries | 60 queries | per minute per user | Prevent scraping |

### Implementation

```
Rate limiter: Redis-backed sliding window counter

Key format: rate_limit:{action}:{user_id}:{window_start}

Response on limit exceeded:
  HTTP 429 Too Many Requests
  Retry-After: <seconds>
  X-RateLimit-Limit: 20
  X-RateLimit-Remaining: 0
  X-RateLimit-Reset: 1695721200
```

---

## 6. Abuse Prevention

### Invitation Spam Protection

```
1. Rate limit: 20 invitations per hour
2. Duplicate detection: Unique partial index prevents duplicate pending invitations
3. Blocked users: Cannot send invitations to users who have blocked you
4. Auto-cancel: Invitations from dissolved teams are auto-cancelled
5. Organizer visibility: Organizer dashboard shows invitation activity per user
```

### Message Spam Protection

```
1. Rate limit: 60 messages per minute
2. Duplicate detection: Block identical messages sent within 5 seconds
3. Minimum interval: 500ms between messages from same user
4. Content length: Max 5000 characters per message
5. Room membership: Verified before every message send
```

### Block Functionality

```
POST /users/:id/block

Effects:
  - Blocked user cannot send requests/invitations to blocker
  - Blocked user is excluded from blocker's search results
  - Blocked user is excluded from matchmaking with blocker
  - Existing pending requests between the pair are auto-cancelled
  - Block is bidirectional in effect but unidirectional in action
  - Block does not reveal itself to the blocked user
    (requests simply fail with generic "unavailable" error)
```

### Report Functionality

```
POST /reports

{
  "reported_user_id": "uuid",
  "event_id": "uuid",       // Optional — context
  "reason": "harassment",   // Enum: spam, harassment, inappropriate_content, fake_profile, other
  "description": "Detailed description..."
}

Organizer/Admin workflow:
  1. Report appears in dashboard
  2. Reviewer can view context (chat messages, profile)
  3. Actions: warn user, suspend user, remove from event, dismiss report
  4. Reporter is notified of resolution (without revealing specifics)
```

---

## 7. Data Privacy

### GDPR Considerations (Phase 2)

| Right | Implementation |
|---|---|
| Right to access | `GET /users/me/data-export` — returns all user data as JSON |
| Right to erasure | `DELETE /users/me` — soft delete, anonymize PII, retain aggregate data |
| Right to rectification | Standard profile edit endpoints |
| Data portability | Export includes profile, skills, interests, team history |
| Consent | Registration requires explicit consent to data processing |

### Data Retention

| Data type | Retention | After deletion |
|---|---|---|
| User profiles | Active until deletion | Anonymized after 30 days |
| Chat messages | Active until room archived | Retained 90 days after archive, then purged |
| Team membership history | Indefinite (anonymized) | User ID replaced with hash |
| Matchmaking logs | 1 year | Purged |
| Notifications | 90 days | Purged |
| Audit logs | 2 years | Purged |

---

## 8. Security Headers

```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self' https://fonts.gstatic.com; connect-src 'self' wss://api.teamforge.dev
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 0    // Deprecated but set to 0 to avoid old browser quirks
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

---

## 9. WebSocket Security

```
1. Authentication: JWT verified on connection handshake
2. Token expiry: If access token expires during an active WebSocket session,
   the server sends a 'token_expired' event; client must re-authenticate
3. Room authorization: Checked on join AND on every message
4. Message validation: Same sanitization rules as REST API
5. Connection limits: Max 5 concurrent WebSocket connections per user
6. Idle timeout: Connections with no activity for 5 minutes are closed
7. Message size: Max 10KB per WebSocket message
```

---

## 10. Logging & Monitoring

### Security Events to Log

| Event | Severity | Details |
|---|---|---|
| Failed login attempt | WARN | IP, email, timestamp |
| Account lockout | WARN | User ID, IP, attempt count |
| Token refresh | INFO | User ID, token family |
| Token family invalidation | ALERT | User ID — possible token theft |
| Authorization failure (403) | WARN | User ID, resource, action |
| Rate limit exceeded | WARN | User ID/IP, endpoint, limit |
| User blocked another user | INFO | Blocker ID, blocked ID |
| Report submitted | INFO | Reporter ID, reported ID, reason |
| Admin action (force dissolve, etc.) | AUDIT | Admin ID, action, target |

### Log Format

```json
{
  "timestamp": "2026-09-26T10:30:00Z",
  "level": "WARN",
  "event": "AUTH_FAILED",
  "ip": "203.0.113.42",
  "email": "user@example.com",
  "user_agent": "Mozilla/5.0...",
  "details": { "attempt_number": 4 }
}
```

All logs are written to structured JSON. No PII in log messages — use user IDs, not emails or names, except for auth failure logs where email is necessary for investigation.
