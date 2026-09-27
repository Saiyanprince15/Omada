import type {
  ChatMessage,
  Event,
  Notification,
  ProvisionalTeam,
  Request,
  Team,
  User,
} from '../types';

const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:3000/v1').replace(/\/$/, '');

let accessToken = localStorage.getItem('omada_access_token');
let refreshToken = localStorage.getItem('omada_refresh_token');

export function getAccessToken() {
  return accessToken;
}

export function setTokens(nextAccessToken: string | null, nextRefreshToken: string | null) {
  accessToken = nextAccessToken;
  refreshToken = nextRefreshToken;
  if (nextAccessToken) localStorage.setItem('omada_access_token', nextAccessToken);
  else localStorage.removeItem('omada_access_token');
  if (nextRefreshToken) localStorage.setItem('omada_refresh_token', nextRefreshToken);
  else localStorage.removeItem('omada_refresh_token');
}

export function clearTokens() {
  setTokens(null, null);
}

async function rawRequest<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);

  const response = await fetch(`${API_URL}${path}`, { ...init, headers });
  const payload = await response.json().catch(() => ({}));

  if (response.status === 401 && retry && refreshToken && !path.includes('/auth/')) {
    const refreshed = await rawRequest<{ tokens: { access_token: string; refresh_token: string } }>(
      '/auth/refresh',
      { method: 'POST', body: JSON.stringify({ refresh_token: refreshToken }) },
      false,
    ).catch(() => null);

    if (refreshed) {
      setTokens(refreshed.tokens.access_token, refreshed.tokens.refresh_token);
      return rawRequest<T>(path, init, false);
    }

    clearTokens();
  }

  if (!response.ok) {
    const error = payload?.error;
    throw new Error(error?.message ?? payload?.message ?? `Request failed (${response.status})`);
  }

  return payload as T;
}

export async function login(email: string, password: string) {
  const data = await rawRequest<{ user: User; tokens: { access_token: string; refresh_token: string } }>(
    '/auth/login',
    { method: 'POST', body: JSON.stringify({ email, password }) },
    false,
  );
  setTokens(data.tokens.access_token, data.tokens.refresh_token);
  return data.user;
}

export async function register(display_name: string, email: string, password: string) {
  const data = await rawRequest<{ user: User; tokens: { access_token: string; refresh_token: string } }>(
    '/auth/register',
    { method: 'POST', body: JSON.stringify({ display_name, email, password }) },
    false,
  );
  setTokens(data.tokens.access_token, data.tokens.refresh_token);
  return data.user;
}

export async function logout() {
  try {
    await rawRequest('/auth/logout', { method: 'POST' });
  } finally {
    clearTokens();
  }
}

export async function getMe() {
  return rawRequest<User>('/users/me');
}

export async function updateProfile(body: { display_name?: string; bio?: string; avatar_url?: string }) {
  return rawRequest<User>('/users/me', { method: 'PUT', body: JSON.stringify(body) });
}

export async function updateSkills(skills: Array<{ skill_display: string; proficiency: number; years_experience?: number }>) {
  return rawRequest<unknown>('/users/me/skills', { method: 'PUT', body: JSON.stringify({ skills }) });
}

export async function updateInterests(interests: Array<{ interest_display: string }>) {
  return rawRequest<unknown>('/users/me/interests', { method: 'PUT', body: JSON.stringify({ interests }) });
}

export async function updateRoles(preferred_roles: Array<{ role_display: string; priority: number }>) {
  return rawRequest<unknown>('/users/me/roles', { method: 'PUT', body: JSON.stringify({ preferred_roles }) });
}

export async function listEvents() {
  return rawRequest<{ data: Event[] }>('/events?limit=50');
}

export async function getEvent(eventId: string) {
  return rawRequest<Event>(`/events/${eventId}`);
}

export async function getParticipation(eventId: string) {
  return rawRequest<{
    registered: boolean;
    status?: string;
    team?: { id: string; name: string; status: string } | null;
    provisional_team?: { id: string; status: string; expiresAt: string } | null;
  }>(`/events/${eventId}/participation/me`);
}

export async function registerForEvent(eventId: string) {
  return rawRequest(`/events/${eventId}/register`, { method: 'POST' });
}

export async function setParticipation(eventId: string, status: 'looking_for_team' | 'registered' | 'withdrawn') {
  return rawRequest(`/events/${eventId}/participation`, { method: 'PUT', body: JSON.stringify({ status }) });
}

export async function listTeams(eventId: string, mode = 'explore') {
  if (mode === 'match_my_skills') {
    return rawRequest<{ data: Array<{ team: Team; match_score: number; matching_skills: string[]; matching_roles: string[]; current_size: number }> }>(
      `/events/${eventId}/teams/discover?mode=match_my_skills&limit=50`,
    );
  }
  return rawRequest<{ data: Team[]; pagination?: { next_cursor: string | null; has_more: boolean } }>(
    `/events/${eventId}/teams?limit=50`,
  );
}

export async function getTeam(eventId: string, teamId: string) {
  return rawRequest<Team>(`/events/${eventId}/teams/${teamId}`);
}

export async function createTeam(eventId: string, body: {
  name: string;
  description?: string;
  project_idea?: string;
  requirements?: Array<{ type: 'skill' | 'role'; name: string; priority: 'must_have' | 'nice_to_have' }>;
}) {
  return rawRequest<{ team: Team }>(`/events/${eventId}/teams`, { method: 'POST', body: JSON.stringify(body) });
}

export async function updateTeam(eventId: string, teamId: string, body: Partial<{
  name: string;
  description: string;
  project_idea: string;
  requirements: Array<{ type: 'skill' | 'role'; name: string; priority: 'must_have' | 'nice_to_have' }>;
}>) {
  return rawRequest<Team>(`/events/${eventId}/teams/${teamId}`, { method: 'PUT', body: JSON.stringify(body) });
}

export async function finalizeTeam(eventId: string, teamId: string) {
  return rawRequest<{ team: Team }>(`/events/${eventId}/teams/${teamId}/finalize`, { method: 'POST' });
}

export async function setTeamRecruiting(eventId: string, teamId: string, open: boolean) {
  return rawRequest<{ team: Team }>(`/events/${eventId}/teams/${teamId}/recruiting`, {
    method: 'POST',
    body: JSON.stringify({ open }),
  });
}

export async function leaveTeam(eventId: string, teamId: string) {
  return rawRequest(`/events/${eventId}/teams/${teamId}/leave`, { method: 'POST' });
}

export async function removeTeamMember(eventId: string, teamId: string, userId: string) {
  return rawRequest(`/events/${eventId}/teams/${teamId}/members/${userId}`, { method: 'DELETE' });
}

export async function dissolveTeam(eventId: string, teamId: string) {
  return rawRequest(`/events/${eventId}/teams/${teamId}/dissolve`, { method: 'POST' });
}

export async function sendRequest(eventId: string, body: {
  type: 'join_request' | 'team_invite' | 'personal_invite';
  team_id: string;
  recipient_id?: string;
  message?: string;
}) {
  return rawRequest<{ request: Request }>(`/events/${eventId}/requests`, { method: 'POST', body: JSON.stringify(body) });
}

export async function listRequests(eventId: string, direction: 'received' | 'sent') {
  return rawRequest<{ data: Request[] }>(`/events/${eventId}/requests?direction=${direction}&limit=50`);
}

export async function respondRequest(eventId: string, requestId: string, action: 'accept' | 'reject' | 'cancel') {
  return rawRequest(`/events/${eventId}/requests/${requestId}`, { method: 'PUT', body: JSON.stringify({ action }) });
}

export async function searchUsers(eventId: string, query = '') {
  const params = new URLSearchParams({ event_id: eventId, limit: '50' });
  if (query.trim()) params.set('skills', query.trim());
  return rawRequest<{ data: Array<{ user: User; matching_skills: string[]; matching_roles: string[] }> }>(`/users/search?${params}`);
}

export async function teamCandidates(eventId: string, teamId: string, query = '') {
  const suffix = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
  return rawRequest<{ data: Array<{ user: User; overallScore: number; mustHaveMatch: string[]; niceToHaveMatch: string[]; roleMatch: string | null }> }>(
    `/events/${eventId}/teams/${teamId}/candidates${suffix}`,
  );
}

export async function enterMatchmaking(eventId: string) {
  return rawRequest<{ status: string; position_in_queue: number; estimated_wait: string }>(
    `/events/${eventId}/matchmaking/enter`,
    { method: 'POST' },
  );
}

export async function leaveMatchmaking(eventId: string) {
  return rawRequest(`/events/${eventId}/matchmaking/leave`, { method: 'POST' });
}

export async function matchmakingStatus(eventId: string) {
  return rawRequest<{ your_status: string; queue_size: number; last_matchmaking_at?: string; restarts_count: number }>(
    `/events/${eventId}/matchmaking/status`,
  );
}

export async function getProvisional(eventId: string, provisionalId: string) {
  return rawRequest<ProvisionalTeam>(`/events/${eventId}/provisional-teams/${provisionalId}`);
}

export async function respondProvisional(eventId: string, provisionalId: string, action: 'accept' | 'reject') {
  return rawRequest<{ member_status: string; team_status: string; awaiting_response_from: number; team_id?: string; replacement_user_id?: string | null; dissolved?: boolean }>(
    `/events/${eventId}/provisional-teams/${provisionalId}/respond`,
    { method: 'POST', body: JSON.stringify({ action }) },
  );
}

export async function notifications() {
  return rawRequest<{ data: Notification[] }>('/notifications?limit=50');
}

export async function markNotification(id: string) {
  return rawRequest(`/notifications/${id}/read`, { method: 'PUT' });
}

export async function markAllNotifications() {
  return rawRequest('/notifications/read-all', { method: 'PUT' });
}

export async function messages(roomId: string) {
  return rawRequest<{ data: ChatMessage[] }>(`/chat/rooms/${roomId}/messages?limit=100`);
}

export async function postMessage(roomId: string, content: string) {
  return rawRequest<{ message: ChatMessage }>(`/chat/rooms/${roomId}/messages`, { method: 'POST', body: JSON.stringify({ content }) });
}
