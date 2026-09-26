-- Initial Prisma migration — no team-size fields, no capacity constraints.
-- The only relationship that needs care is:
--   ProvisionalTeam.finalizedTeamId → Team.id  (one-to-one, nullable)
-- This FK must point FROM provisional_teams TO teams, not vice versa.

-- CreateEnum
CREATE TYPE "UserEventStatus" AS ENUM ('registered', 'looking_for_team', 'in_matchmaking', 'in_provisional_team', 'in_forming_team', 'in_finalized_team', 'withdrawn');

-- CreateEnum
CREATE TYPE "TeamStatus" AS ENUM ('forming', 'finalized', 'locked', 'dissolved');

-- CreateEnum
CREATE TYPE "ProvisionalTeamStatus" AS ENUM ('pending', 'accepted', 'dissolved', 'expired', 'converted');

-- CreateEnum
CREATE TYPE "ProvisionalMemberStatus" AS ENUM ('pending', 'accepted', 'rejected', 'left', 'expired', 'replaced');

-- CreateEnum
CREATE TYPE "RequestType" AS ENUM ('join_request', 'team_invite', 'personal_invite');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('pending', 'accepted', 'rejected', 'cancelled', 'expired');

-- CreateEnum
CREATE TYPE "ChatRoomType" AS ENUM ('provisional', 'permanent');

-- CreateEnum
CREATE TYPE "ChatRoomStatus" AS ENUM ('active', 'archived', 'deleted');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('text', 'system', 'file');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('hackathon', 'academic_project', 'competition', 'research_project', 'other');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('draft', 'registration_open', 'registration_closed', 'in_progress', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "ConstraintType" AS ENUM ('hard', 'soft');

-- CreateEnum
CREATE TYPE "TeamSource" AS ENUM ('manual', 'auto_match');

-- CreateEnum
CREATE TYPE "TeamMemberRole" AS ENUM ('owner', 'admin', 'member');

-- CreateEnum
CREATE TYPE "RequirementPriority" AS ENUM ('must_have', 'nice_to_have');

-- CreateEnum
CREATE TYPE "RequirementType" AS ENUM ('skill', 'role');

-- CreateEnum
CREATE TYPE "MatchingRoundStatus" AS ENUM ('running', 'completed', 'failed');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "avatar_url" TEXT,
    "bio" TEXT,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_skills" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "skill_name" TEXT NOT NULL,
    "skill_display" TEXT NOT NULL,
    "proficiency" INTEGER NOT NULL,
    "years_experience" DECIMAL(3,1),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_skills_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_interests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "interest_name" TEXT NOT NULL,
    "interest_display" TEXT NOT NULL,
    CONSTRAINT "user_interests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_preferred_roles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_name" TEXT NOT NULL,
    "role_display" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "user_preferred_roles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "organizer_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "event_type" "EventType" NOT NULL,
    "registration_opens" TIMESTAMP(3),
    "registration_closes" TIMESTAMP(3),
    "event_starts" TIMESTAMP(3),
    "event_ends" TIMESTAMP(3),
    "matchmaking_enabled" BOOLEAN NOT NULL DEFAULT true,
    "auto_match_timeout_hrs" INTEGER NOT NULL DEFAULT 48,
    "status" "EventStatus" NOT NULL DEFAULT 'draft',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "event_required_skills" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "skill_name" TEXT NOT NULL,
    "constraint_type" "ConstraintType" NOT NULL,
    CONSTRAINT "event_required_skills_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "event_required_roles" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "role_name" TEXT NOT NULL,
    "constraint_type" "ConstraintType" NOT NULL,
    CONSTRAINT "event_required_roles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "event_participants" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "UserEventStatus" NOT NULL DEFAULT 'registered',
    "team_id" TEXT,
    "provisional_team_id" TEXT,
    "matchmaking_restarts" INTEGER NOT NULL DEFAULT 0,
    "last_matchmaking_at" TIMESTAMP(3),
    "profile_snapshot" JSONB,
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "event_participants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "chat_rooms" (
    "id" TEXT NOT NULL,
    "room_type" "ChatRoomType" NOT NULL,
    "status" "ChatRoomStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_rooms_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "owner_id" TEXT NOT NULL,
    "status" "TeamStatus" NOT NULL DEFAULT 'forming',
    "project_idea" TEXT,
    "chat_room_id" TEXT,
    "source" "TeamSource" NOT NULL DEFAULT 'manual',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "team_members" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_in_team" "TeamMemberRole" NOT NULL DEFAULT 'member',
    "assigned_role" TEXT,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),
    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "team_requirements" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "requirement_type" "RequirementType" NOT NULL,
    "name" TEXT NOT NULL,
    "priority" "RequirementPriority" NOT NULL,
    CONSTRAINT "team_requirements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "provisional_teams" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "status" "ProvisionalTeamStatus" NOT NULL DEFAULT 'pending',
    "match_score" DECIMAL(5,3),
    "match_explanation" JSONB,
    "created_by_round" TEXT,
    "chat_room_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    -- FK pointing TO teams.id; NULL until the provisional team is converted
    "finalized_team_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "provisional_teams_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "provisional_team_members" (
    "id" TEXT NOT NULL,
    "provisional_team_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "ProvisionalMemberStatus" NOT NULL DEFAULT 'pending',
    "match_reason" JSONB,
    "responded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provisional_team_members_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "requests_invitations" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "type" "RequestType" NOT NULL,
    "sender_id" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "team_id" TEXT,
    "status" "RequestStatus" NOT NULL DEFAULT 'pending',
    "message" TEXT,
    "expires_at" TIMESTAMP(3),
    "responded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "requests_invitations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "sender_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "message_type" "MessageType" NOT NULL DEFAULT 'text',
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "event_id" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "matching_rounds" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "status" "MatchingRoundStatus" NOT NULL DEFAULT 'running',
    "participants_count" INTEGER,
    "teams_formed" INTEGER,
    "unmatched_count" INTEGER,
    "algorithm_params" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    CONSTRAINT "matching_rounds_pkey" PRIMARY KEY ("id")
);

-- Unique indexes
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "user_skills_user_id_skill_name_key" ON "user_skills"("user_id", "skill_name");
CREATE UNIQUE INDEX "user_interests_user_id_interest_name_key" ON "user_interests"("user_id", "interest_name");
CREATE UNIQUE INDEX "user_preferred_roles_user_id_role_name_key" ON "user_preferred_roles"("user_id", "role_name");
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");
CREATE UNIQUE INDEX "event_required_skills_event_id_skill_name_key" ON "event_required_skills"("event_id", "skill_name");
CREATE UNIQUE INDEX "event_required_roles_event_id_role_name_key" ON "event_required_roles"("event_id", "role_name");
CREATE UNIQUE INDEX "event_participants_event_id_user_id_key" ON "event_participants"("event_id", "user_id");
CREATE UNIQUE INDEX "teams_chat_room_id_key" ON "teams"("chat_room_id");
CREATE UNIQUE INDEX "team_members_team_id_user_id_key" ON "team_members"("team_id", "user_id");
CREATE UNIQUE INDEX "team_requirements_team_id_requirement_type_name_key" ON "team_requirements"("team_id", "requirement_type", "name");
-- provisional_teams.finalized_team_id is unique: one provisional → one permanent team
CREATE UNIQUE INDEX "provisional_teams_chat_room_id_key" ON "provisional_teams"("chat_room_id");
CREATE UNIQUE INDEX "provisional_teams_finalized_team_id_key" ON "provisional_teams"("finalized_team_id");
CREATE UNIQUE INDEX "provisional_team_members_provisional_team_id_user_id_key" ON "provisional_team_members"("provisional_team_id", "user_id");

-- Regular indexes
CREATE INDEX "user_skills_skill_name_idx" ON "user_skills"("skill_name");
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens"("family");
CREATE INDEX "events_status_idx" ON "events"("status");
CREATE INDEX "events_organizer_id_idx" ON "events"("organizer_id");
CREATE INDEX "event_participants_event_id_status_idx" ON "event_participants"("event_id", "status");
CREATE INDEX "event_participants_user_id_idx" ON "event_participants"("user_id");
CREATE INDEX "teams_event_id_status_idx" ON "teams"("event_id", "status");
CREATE INDEX "teams_owner_id_idx" ON "teams"("owner_id");
CREATE INDEX "team_members_team_id_idx" ON "team_members"("team_id");
CREATE INDEX "team_members_user_id_idx" ON "team_members"("user_id");
CREATE INDEX "team_requirements_team_id_idx" ON "team_requirements"("team_id");
CREATE INDEX "provisional_teams_event_id_status_idx" ON "provisional_teams"("event_id", "status");
CREATE INDEX "provisional_team_members_provisional_team_id_status_idx" ON "provisional_team_members"("provisional_team_id", "status");
CREATE INDEX "provisional_team_members_user_id_idx" ON "provisional_team_members"("user_id");
CREATE INDEX "requests_invitations_recipient_id_status_idx" ON "requests_invitations"("recipient_id", "status");
CREATE INDEX "requests_invitations_sender_id_status_idx" ON "requests_invitations"("sender_id", "status");
CREATE INDEX "requests_invitations_team_id_status_idx" ON "requests_invitations"("team_id", "status");
CREATE INDEX "chat_messages_room_id_created_at_idx" ON "chat_messages"("room_id", "created_at" DESC);
CREATE INDEX "chat_messages_sender_id_idx" ON "chat_messages"("sender_id");
CREATE INDEX "notifications_user_id_is_read_created_at_idx" ON "notifications"("user_id", "is_read", "created_at" DESC);
CREATE INDEX "matching_rounds_event_id_idx" ON "matching_rounds"("event_id");

-- Foreign Keys
ALTER TABLE "user_skills" ADD CONSTRAINT "user_skills_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_interests" ADD CONSTRAINT "user_interests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_preferred_roles" ADD CONSTRAINT "user_preferred_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "events" ADD CONSTRAINT "events_organizer_id_fkey" FOREIGN KEY ("organizer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "event_required_skills" ADD CONSTRAINT "event_required_skills_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "event_required_roles" ADD CONSTRAINT "event_required_roles_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_provisional_team_id_fkey" FOREIGN KEY ("provisional_team_id") REFERENCES "provisional_teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "teams" ADD CONSTRAINT "teams_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "teams" ADD CONSTRAINT "teams_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "teams" ADD CONSTRAINT "teams_chat_room_id_fkey" FOREIGN KEY ("chat_room_id") REFERENCES "chat_rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "team_requirements" ADD CONSTRAINT "team_requirements_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provisional_teams" ADD CONSTRAINT "provisional_teams_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provisional_teams" ADD CONSTRAINT "provisional_teams_chat_room_id_fkey" FOREIGN KEY ("chat_room_id") REFERENCES "chat_rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- FK: provisional_teams.finalized_team_id → teams.id
ALTER TABLE "provisional_teams" ADD CONSTRAINT "provisional_teams_finalized_team_id_fkey" FOREIGN KEY ("finalized_team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "provisional_team_members" ADD CONSTRAINT "provisional_team_members_provisional_team_id_fkey" FOREIGN KEY ("provisional_team_id") REFERENCES "provisional_teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provisional_team_members" ADD CONSTRAINT "provisional_team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "requests_invitations" ADD CONSTRAINT "requests_invitations_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "requests_invitations" ADD CONSTRAINT "requests_invitations_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "requests_invitations" ADD CONSTRAINT "requests_invitations_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "requests_invitations" ADD CONSTRAINT "requests_invitations_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "chat_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "matching_rounds" ADD CONSTRAINT "matching_rounds_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
