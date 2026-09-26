# System Architecture — TeamForge

## A. Product Understanding

TeamForge is an **event-scoped team-formation platform** for hackathons and academic projects. It enables participants to discover teammates, form provisional groups, and finalize teams through a deliberate, multi-stage workflow.

### Core Workflow

```
Profile Creation → Discover (People / Teams) OR Enter Matchmaking
    → Provisional Matching → Temporary Interaction & Approval
    → Final Team → Permanent Team Collaboration
```

### Key Differentiators

| Principle | What it means |
|---|---|
| **Event-scoped** | Availability and membership are tracked per event — joining one event does not make a user unavailable globally. |
| **Provisional-first** | No algorithm output is immediately permanent. Every auto-generated team goes through a human approval stage. |
| **Diversity-optimized** | The matching algorithm rewards complementary skills and role coverage rather than clustering similar profiles. |
| **Explainable** | Every match produces a human-readable justification grounded in scoring components. |
| **Concurrency-safe** | All membership transitions are atomic at the database level; the system never relies solely on frontend guards. |

---

## B. Problems & Ambiguities Resolved

| # | Ambiguity | Resolution |
|---|---|---|
| 1 | Who creates teams? | Any authenticated user can create a team within an event. The creator becomes the initial **Owner**. |
| 2 | Ownership transfer | Ownership can be transferred to any current member by the Owner. If the Owner leaves without transferring, the longest-tenured member is auto-promoted. If no members remain, the team dissolves. |
| 3 | Who can invite? | Owner and members with the **Admin** role can send invitations. Regular members cannot. |
| 4 | Who can remove members? | Only the Owner can remove members. Admins can remove non-admin members. |
| 5 | Who can finalize/dissolve? | Only the Owner can finalize or dissolve a team. |
| 6 | Provisional team viability | A provisional team is viable when `current_members ≥ event.min_team_size`. If it drops below, the system searches for replacements. If no replacement is found within the timeout window, remaining users are returned to the "Looking" state. |
| 7 | "Random team" naming | Renamed to **Auto-Match** throughout. It is optimization-based, not random. |
| 8 | Profile changes during matchmaking | Once a user enters matchmaking, a **snapshot** of their profile is used for the current round. Profile edits take effect only in subsequent rounds. |
| 9 | Repeated matchmaking restarts | Rate-limited to **3 restarts per hour per user per event** to prevent abuse and algorithmic churn. |
| 10 | Uneven participant counts | The algorithm allows the last team to be undersized (down to `min_team_size`). If even that is impossible, remaining users are placed in a "Waiting for more participants" queue. |

---

## N. Recommended Final Architecture

### High-Level Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Layer                             │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │   Web App     │  │  Mobile App  │  │  Organizer Dashboard  │  │
│  │  (React/Next) │  │  (React Nat.)│  │  (React/Next)         │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬────────────┘  │
└─────────┼─────────────────┼─────────────────────┼───────────────┘
          │ HTTPS / WSS     │ HTTPS / WSS         │ HTTPS / WSS
┌─────────┼─────────────────┼─────────────────────┼───────────────┐
│         ▼                 ▼                     ▼               │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                   API Gateway / LB                      │    │
│  │            (Rate Limiting, Auth Verification)           │    │
│  └────────┬───────────────────────────────────┬────────────┘    │
│           │                                   │                 │
│  ┌────────▼────────┐                 ┌────────▼────────┐        │
│  │   REST API      │                 │  WebSocket       │        │
│  │   Service       │                 │  Gateway         │        │
│  │                 │                 │                  │        │
│  │  • Auth         │                 │  • Chat          │        │
│  │  • Profiles     │                 │  • Notifications │        │
│  │  • Teams        │                 │  • Presence      │        │
│  │  • Events       │                 │  • Live Updates  │        │
│  │  • Search       │                 │                  │        │
│  │  • Requests     │                 └────────┬─────────┘        │
│  │  • Admin        │                          │                 │
│  └────────┬────────┘                          │                 │
│           │                                   │                 │
│  ┌────────▼───────────────────────────────────▼─────────┐       │
│  │                  Service Layer                       │       │
│  │                                                      │       │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │       │
│  │  │  Matching     │  │  Team        │  │  Chat      │  │       │
│  │  │  Engine       │  │  Manager     │  │  Service   │  │       │
│  │  │              │  │              │  │            │  │       │
│  │  │  • Scoring   │  │  • CRUD      │  │  • Rooms   │  │       │
│  │  │  • Grouping  │  │  • State     │  │  • Messages│  │       │
│  │  │  • Explain   │  │  • Members   │  │  • History │  │       │
│  │  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘  │       │
│  │         │                 │                │         │       │
│  │  ┌──────▼─────┐  ┌───────▼───────┐  ┌─────▼──────┐  │       │
│  │  │ Notification│  │  AI Service   │  │  Search    │  │       │
│  │  │ Service     │  │              │  │  Service   │  │       │
│  │  │             │  │  • Profile   │  │            │  │       │
│  │  │  • In-app   │  │    parsing   │  │  • Full-   │  │       │
│  │  │  • Push     │  │  • Skill     │  │    text    │  │       │
│  │  │  • Email    │  │    normalize │  │  • Filter  │  │       │
│  │  │             │  │  • Explain   │  │  • Rank    │  │       │
│  │  └─────────────┘  └─────────────┘  └────────────┘  │       │
│  └──────────────────────────┬───────────────────────────┘       │
│                             │                                   │
│  ┌──────────────────────────▼───────────────────────────┐       │
│  │                  Data Layer                          │       │
│  │                                                      │       │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │       │
│  │  │  PostgreSQL   │  │  Redis       │  │  S3/GCS    │  │       │
│  │  │              │  │              │  │            │  │       │
│  │  │  • Users     │  │  • Sessions  │  │  • Avatars │  │       │
│  │  │  • Teams     │  │  • Cache     │  │  • Uploads │  │       │
│  │  │  • Events    │  │  • Pub/Sub   │  │            │  │       │
│  │  │  • Messages  │  │  • Rate Lim. │  │            │  │       │
│  │  │  • Requests  │  │  • Presence  │  │            │  │       │
│  │  └──────────────┘  └──────────────┘  └────────────┘  │       │
│  └──────────────────────────────────────────────────────┘       │
│                         Backend Layer                           │
└─────────────────────────────────────────────────────────────────┘
```

### Component Justification

| Component | Why it exists |
|---|---|
| **API Gateway / LB** | Centralized rate limiting, TLS termination, auth token verification, and request routing. Prevents abuse at the edge before requests reach services. |
| **REST API Service** | Handles all CRUD operations, stateless request–response flows (profiles, teams, events, search, invitations). Stateless design allows horizontal scaling. |
| **WebSocket Gateway** | Long-lived connections for chat, notifications, presence, and live team-availability updates. Separated from REST to scale independently. |
| **Matching Engine** | Isolated compute-intensive service. Runs the scoring/grouping algorithm on-demand or on a schedule. Isolation ensures matching workloads don't degrade API latency. |
| **Team Manager** | Encapsulates all team state transitions (create, join, leave, finalize, dissolve). Enforces atomic state changes via database transactions. |
| **Chat Service** | Manages provisional and permanent chat rooms, message persistence, and room lifecycle (create on provisional match, archive on team dissolve). |
| **Notification Service** | Decoupled from business logic via an internal event bus. Listens for domain events (invitation_sent, match_proposed, team_finalized) and dispatches in-app, push, or email notifications. |
| **AI Service** | Optional service for profile parsing (natural language → structured skills), skill normalization (React ≡ React.js), and generating natural-language match explanations. Isolated so the core platform functions without it. |
| **Search Service** | Full-text and filtered search across users and teams. May use PostgreSQL full-text search (MVP) or Elasticsearch (Phase 2) depending on scale. |
| **PostgreSQL** | Primary relational store. Chosen for ACID transactions (critical for concurrency-safe membership changes), rich indexing, and JSONB support for flexible profile data. |
| **Redis** | Session store, cache layer, pub/sub backbone for WebSocket fan-out, rate-limiter backing store, and presence tracking. |
| **S3/GCS** | Object storage for user avatars, team logos, and any file uploads. |

### Technology Recommendations

| Layer | Technology | Rationale |
|---|---|---|
| Backend Framework | **Node.js (Express/Fastify)** or **Python (FastAPI)** | Both support async I/O, WebSockets, and have mature ORM/query-builder ecosystems. |
| Database | **PostgreSQL 15+** | ACID, advisory locks, `SELECT ... FOR UPDATE`, JSONB, full-text search. |
| Cache / Pub-Sub | **Redis 7+** | Pub/Sub for WebSocket fan-out, sorted sets for leaderboards, streams for event sourcing (optional). |
| WebSockets | **Socket.IO** or **native ws** (Node) / **WebSocket** (FastAPI) | Socket.IO adds reconnection, rooms, namespaces out of the box. |
| ORM | **Prisma** (Node) or **SQLAlchemy** (Python) | Type-safe queries, migration management. |
| Auth | **JWT (access + refresh tokens)** with **bcrypt** password hashing | Stateless auth with secure token rotation. |
| AI/LLM | **OpenAI API** or **Gemini API** | For profile parsing, skill normalization, explanation generation. Abstracted behind an internal service interface. |

---

## Real-Time Architecture (Section J)

### WebSocket Namespaces

```
/ws
  ├── /chat              # Provisional and permanent chat messages
  ├── /notifications     # In-app notification delivery
  ├── /presence          # User online/offline/typing status
  └── /teams             # Live team availability updates (slots, status changes)
```

### Chat Room Lifecycle

```
Provisional Match Created
    → Create provisional chat room (room_id = provisional_team_id)
    → Room metadata: { type: "provisional", status: "active" }
    → Banner: "Provisional Team — Not Yet Finalized"

All Members Accept
    → Finalize team
    → Create permanent chat room (room_id = team_id)
    → Migrate relevant context from provisional room
    → Archive provisional room (read-only)

Provisional Team Dissolved
    → Archive provisional room
    → Notify all members
    → No permanent room created
```

### Notification Flow

```
Domain Event (e.g., invitation_sent)
    → Event Bus (Redis Pub/Sub)
    → Notification Service
        ├── Store in DB (notifications table)
        ├── Push via WebSocket (if user online)
        └── Queue for push/email (if user offline) [Phase 2]
```

### Presence Tracking

- Heartbeat-based via WebSocket ping/pong (30-second intervals).
- Redis sorted set keyed by `event:{event_id}:presence` with user IDs and last-seen timestamps.
- Users not seen for 60 seconds are marked offline.
- Presence is **not** used for matchmaking eligibility — only explicit state (`looking_for_team`) matters.

---

## L. MVP vs. Advanced Features

### MVP (Phase 1)

| Feature | Scope |
|---|---|
| Authentication | Email/password signup, JWT auth |
| User profiles | Bio, skills (with proficiency), interests, preferred roles |
| Event management | Organizer creates events with team-size constraints |
| Manual team creation | User creates team, invites known users |
| Team search | Browse/filter teams by skills, roles, availability |
| User search | Teams search for users by skills, roles |
| Join requests | User → Team requests with accept/reject |
| Team invitations | Team → User invitations with accept/reject |
| Auto-matchmaking | Core matching algorithm with provisional teams |
| Provisional chat | Temporary chat room for provisional teams |
| Accept/reject flow | Per-user acceptance, rejection handling, replacement search |
| Team finalization | Provisional → Permanent transition |
| Permanent chat | Basic team chat after finalization |
| In-app notifications | Real-time notification delivery via WebSocket |
| Match explanations | Algorithmic explanations (structured, not NL) |
| Concurrency safety | Atomic state transitions for all membership operations |
| Basic admin dashboard | View events, participants, teams, unmatched users |

### Phase 2

| Feature | Scope |
|---|---|
| AI profile parsing | Natural-language bio → structured skills/roles |
| AI skill normalization | "React" ≡ "React.js" ≡ "ReactJS" |
| AI match explanations | Natural-language explanation generation |
| Email/push notifications | Offline notification delivery |
| Advanced organizer dashboard | Skill distribution charts, rebalancing tools, moderation queue |
| Project recommendations | AI suggests project ideas based on team composition |
| User blocking & reporting | Block users, report abuse, moderation workflow |
| Advanced search | Elasticsearch-backed full-text search with facets |
| Team analytics | Team composition scores, skill gap analysis |

### Optional / Future

| Feature | Scope |
|---|---|
| GitHub integration | Import skills from repositories, verify contributions |
| LinkedIn integration | Import profile data, verify experience |
| Portfolio integration | Link external portfolios |
| Calendar integration | Availability scheduling |
| External PM tools | Trello/Jira/Notion integration |
| Mobile app | React Native or Flutter client |
| SSO | OAuth2 with Google, GitHub, university SSO |
| Multi-language support | i18n/l10n |

---

## Deployment Architecture (Production)

```
┌─────────────────────────────────────────────┐
│                 CDN (CloudFlare)             │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│          Load Balancer (L7)                  │
│    ┌────────────────┬───────────────┐        │
│    │  /api/*        │  /ws/*        │        │
│    │  → REST pods   │  → WS pods   │        │
│    └────────────────┴───────────────┘        │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│            Kubernetes Cluster                │
│                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
│  │ REST API │ │ WS Gate  │ │ Match Engine │  │
│  │ (3 pods) │ │ (2 pods) │ │ (1-2 pods)   │  │
│  └──────────┘ └──────────┘ └──────────────┘  │
│                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
│  │ Notif.   │ │ AI Svc   │ │ Chat Svc     │  │
│  │ (2 pods) │ │ (1 pod)  │ │ (2 pods)     │  │
│  └──────────┘ └──────────┘ └──────────────┘  │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  ┌──────────────┐  ┌───────┐  ┌──────────┐  │
│  │  PostgreSQL   │  │ Redis │  │ S3/GCS   │  │
│  │  (Primary +   │  │ (HA)  │  │          │  │
│  │   Replica)    │  │       │  │          │  │
│  └──────────────┘  └───────┘  └──────────┘  │
│               Managed Data Services          │
└──────────────────────────────────────────────┘
```

### Scaling Strategy

| Component | Scaling approach |
|---|---|
| REST API | Horizontal — stateless, add pods behind LB |
| WebSocket Gateway | Horizontal with Redis Pub/Sub for cross-pod message fan-out |
| Matching Engine | Vertical for single-event runs; horizontal for concurrent events |
| PostgreSQL | Read replicas for search/read queries; primary for writes |
| Redis | Redis Cluster for partitioning if single-node limits are reached |
