import type { ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './lib/auth';
import type { Event, Team, User } from './types';

export function Avatar({ user, size = 40 }: { user: Pick<User, 'displayName' | 'avatarUrl'>; size?: number }) {
  const initials = user.displayName.split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase();
  return user.avatarUrl
    ? <img className="avatar" style={{ width: size, height: size }} src={user.avatarUrl} alt={user.displayName} />
    : <div className="avatar avatar-fallback" style={{ width: size, height: size }}>{initials}</div>;
}

export function Button({ children, variant = 'primary', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'soft' }) {
  return <button {...props} className={`btn btn-${variant} ${props.className ?? ''}`}>{children}</button>;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'danger' | 'accent' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Field(props: React.InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  const { label, ...input } = props;
  return <label className="field">{label && <span>{label}</span>}<input {...input} /></label>;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string }) {
  const { label, ...input } = props;
  return <label className="field">{label && <span>{label}</span>}<textarea {...input} /></label>;
}

export function Shell() {
  const { user, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const eventId = new URLSearchParams(location.search).get('event');

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" to="/"><span className="brand-mark">O</span><span>omada</span></Link>
        <nav>
          <NavLink to="/" end className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>Home</NavLink>
          <NavLink to="/events" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>Explore events</NavLink>
          {eventId && <NavLink to={`/teams?event=${eventId}`} className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>Discover teams</NavLink>}
          <NavLink to="/requests" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>Requests</NavLink>
          <NavLink to="/notifications" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>Notifications</NavLink>
          <NavLink to="/profile" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>Profile</NavLink>
          <NavLink to="/organizer" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>Organizer</NavLink>
        </nav>
        <div className="sidebar-bottom">
          <button className="profile-mini" onClick={() => navigate('/profile')}><Avatar user={user!} size={36}/><span><strong>{user?.displayName}</strong><small>View profile</small></span></button>
          <button className="nav-link nav-link-button" onClick={() => void signOut()}>Sign out</button>
        </div>
      </aside>
      <main className="main-area"><Outlet /></main>
    </div>
  );
}

export function PageHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return <header className="page-header"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</header>;
}

export function UserCard({ user, extra }: { user: User; extra?: ReactNode }) {
  return <div className="person-card"><div className="person-main"><Avatar user={user}/><div><h3>{user.displayName}</h3><p>{user.bio || 'No bio yet.'}</p></div></div><div className="chip-row">{user.preferredRoles.slice(0, 3).map((r) => <Badge key={r.roleName} tone="accent">{r.roleDisplay}</Badge>)}</div>{extra}</div>;
}

export function TeamCard({ team, event, action }: { team: Team; event?: Event; action?: ReactNode }) {
  return <article className="team-card"><div className="team-card-top"><div><Badge tone={team.status === 'forming' ? 'warn' : 'good'}>{team.status.replaceAll('_', ' ')}</Badge><h3>{team.name}</h3><p>{team.description || 'No description yet.'}</p></div>{action}</div><div className="team-meta"><span>{team.current_size} member{team.current_size === 1 ? '' : 's'}</span><span>{team.source === 'auto_match' ? 'Auto-match' : 'Manual'}</span>{event && <span>{event.name}</span>}</div><div className="chip-row">{team.requirements.slice(0, 4).map((r) => <Badge key={`${r.requirementType}-${r.name}`}>{r.name.replaceAll('_', ' ')}</Badge>)}</div></article>;
}
