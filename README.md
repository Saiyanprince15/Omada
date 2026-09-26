# Omada

Omada is a team-formation platform for hackathons and academic projects. It forms teams around complementary skills, interests, experience, and preferred roles, while keeping team completion under human control.

## Product model

- Users create a structured profile.
- Users can browse events, search for known people, discover forming teams, or enter auto-match.
- Auto-match creates **provisional** teams first. Each member accepts or declines.
- A provisional group becomes a **forming** team only after all active members accept.
- A forming team can keep recruiting indefinitely. There is **no minimum, maximum, or target team size** enforced by the product.
- Only the team owner finalizes a forming team.
- Finalization creates the permanent team chat and moves members to the finalized state.
- No organizer dashboard is part of the participant-facing product.

## Repository

```
backend/   Express + Prisma + PostgreSQL + Redis + Socket.IO
frontend/  React + Vite + TypeScript
docs/      API, architecture, state-machine, testing and matching references
```

## Local development

### Backend

1. Start PostgreSQL and Redis.
2. Copy `backend/.env.example` to `backend/.env`.
3. Install dependencies:

```bash
cd backend
npm install
npx prisma generate
npx prisma migrate dev
npm run db:seed
npm run dev
```

The API runs on `http://localhost:3000`.

### Frontend

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

The web app runs on `http://localhost:5173`.

Set `VITE_API_URL` and `VITE_WS_URL` in `.env` when the API is hosted elsewhere.

## Core routes

The backend exposes authentication, profiles, event participation, team discovery, manual teams, invitations, auto-match, provisional approvals, chat, notifications, and admin APIs under `/v1`.

The frontend intentionally consumes the participant-facing APIs and does not expose an organizer portal.
