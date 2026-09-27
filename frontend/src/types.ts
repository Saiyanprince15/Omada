export type UserStatus =
  | 'registered'
  | 'looking_for_team'
  | 'in_matchmaking'
  | 'in_provisional_team'
  | 'in_forming_team'
  | 'in_finalized_team'
  | 'withdrawn';

export type TeamStatus = 'forming' | 'finalized' | 'locked' | 'dissolved';

export interface Skill {
  skillName: string;
  skillDisplay: string;
  proficiency: number;
  yearsExperience?: number;
}

export interface Interest {
  interestName: string;
  interestDisplay: string;
}

export interface PreferredRole {
  roleName: string;
  roleDisplay: string;
  priority: number;
}

export interface User {
  id: string;
  email?: string;
  displayName: string;
  avatarUrl?: string | null;
  bio?: string | null;
  skills: Skill[];
  interests: Interest[];
  preferredRoles: PreferredRole[];
  isAdmin?: boolean;
  status?: UserStatus;
}

export interface EventRequirement {
  id?: string;
  skillName?: string;
  roleName?: string;
  constraintType?: 'hard' | 'soft';
}

export interface Event {
  id: string;
  name: string;
  description?: string | null;
  eventType: string;
  status: string;
  matchmakingEnabled: boolean;
  autoMatchTimeoutHrs: number;
  organizer: { id: string; displayName: string };
  requiredSkills: EventRequirement[];
  requiredRoles: EventRequirement[];
  participant_count: number;
  team_count: number;
  looking_count?: number;
  registrationOpens?: string | null;
  registrationCloses?: string | null;
  eventStarts?: string | null;
  eventEnds?: string | null;
}

export interface TeamMember {
  id: string;
  userId: string;
  roleInTeam: 'owner' | 'admin' | 'member';
  joinedAt: string;
  user: User;
}

export interface TeamRequirement {
  id: string;
  requirementType: 'skill' | 'role';
  name: string;
  priority: 'must_have' | 'nice_to_have';
}

export interface Team {
  id: string;
  eventId: string;
  name: string;
  description?: string | null;
  projectIdea?: string | null;
  status: TeamStatus;
  source: 'manual' | 'auto_match';
  recruiting: boolean;
  owner: { id: string; displayName: string; avatarUrl?: string | null };
  members: TeamMember[];
  requirements: TeamRequirement[];
  chatRoomId?: string | null;
  current_size: number;
}

export interface Request {
  id: string;
  eventId: string;
  type: 'join_request' | 'team_invite' | 'personal_invite';
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';
  sender: { id: string; displayName: string; avatarUrl?: string | null };
  recipient: { id: string; displayName: string; avatarUrl?: string | null };
  team?: { id: string; name: string; status?: TeamStatus } | null;
  message?: string | null;
  createdAt: string;
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  body?: string | null;
  data: Record<string, unknown>;
  isRead: boolean;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  content: string;
  messageType: string;
  createdAt: string;
  sender: { id: string; displayName: string; avatarUrl?: string | null };
}

export interface ProvisionalTeam {
  id: string;
  eventId: string;
  status: string;
  matchScore?: number | string | null;
  matchExplanation?: {
    team_score?: number;
    components?: Record<string, unknown>;
  } | null;
  expiresAt: string;
  chatRoomId?: string | null;
  members: Array<{
    id: string;
    userId: string;
    status: 'pending' | 'accepted' | 'rejected' | 'left' | 'expired' | 'replaced';
    matchReason?: Record<string, unknown> | null;
    user: User;
  }>;
}
