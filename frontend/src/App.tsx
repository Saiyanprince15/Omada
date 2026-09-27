import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './lib/auth';
import { Shell } from './components';
import {
  ChatPage, EventPage, EventsPage, HomePage, LoginPage,
  NotificationsPage, ProfilePage, RequestsPage, TeamPage, TeamsPage,
  ProvisionalPage, OrganizerPage,
} from './pages';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth><Shell /></RequireAuth>}>
        <Route path="/" element={<HomePage />} />
        <Route path="/events" element={<EventsPage />} />
        <Route path="/event/:id" element={<EventPage />} />
        <Route path="/teams" element={<TeamsPage />} />
        <Route path="/team/:eventId/:teamId" element={<TeamPage />} />
        <Route path="/provisional/:eventId/:provisionalId" element={<ProvisionalPage />} />
        <Route path="/requests" element={<RequestsPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/chat/:roomId" element={<ChatPage />} />
        <Route path="/organizer" element={<OrganizerPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
