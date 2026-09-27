import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import * as api from './lib/api';
import { useAuth } from './lib/auth';
import { Avatar, Badge, Button, Field, PageHeader, TeamCard, Textarea, UserCard } from './components';
import type { Event, Notification, ProvisionalTeam, Request, Team, User } from './types';

function useAsync<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const run = async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try { setState({ data: await load(), loading: false, error: null }); }
    catch (e) { setState({ data: null, loading: false, error: e instanceof Error ? e.message : 'Something went wrong.' }); }
  };
  useEffect(() => { void run(); }, deps);
  return { ...state, reload: run };
}

export function LoginPage() {
  const { user, signIn, signUp } = useAuth();
  const navigate = useNavigate();
  const [signup, setSignup] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (user) navigate('/', { replace: true }); }, [user, navigate]);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { signup ? await signUp(name, email, password) : await signIn(email, password); navigate('/', { replace: true }); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not authenticate.'); }
    finally { setBusy(false); }
  }
  return <div className="auth-screen"><div className="auth-art"><div className="orb orb-a"/><div className="orb orb-b"/><div className="auth-brand">omada</div><div className="quote">The best teams are built around complementary people, not matching résumés.</div></div><form className="auth-card" onSubmit={submit}><div className="eyebrow">{signup ? 'Create account' : 'Welcome back'}</div><h1>{signup ? 'Build your profile.' : 'Find your people.'}</h1><p>{signup ? 'Start with the skills and roles you want to bring to a team.' : 'Sign in to continue building your next team.'}</p>{signup && <Field label="Display name" value={name} onChange={(e) => setName(e.target.value)} required /> }<Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /><Field label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />{error && <div className="alert alert-danger">{error}</div>}<Button type="submit" disabled={busy}>{busy ? 'Working…' : signup ? 'Create account' : 'Sign in'}</Button><button type="button" className="text-button" onClick={() => setSignup((v) => !v)}>{signup ? 'Already have an account? Sign in' : 'Need an account? Create one'}</button></form></div>;
}

export function HomePage() {
  const { user } = useAuth();
  const events = useAsync(api.listEvents, []);
  const [eventId, setEventId] = useState('');
  const selected = events.data?.data ?? [];
  const active = selected.filter((e) => ['registration_open', 'in_progress'].includes(e.status));
  return <>
    <PageHeader title={`Good to see you, ${user?.displayName.split(' ')[0] ?? 'there'}.`} description="Choose an event, shape your profile, and let Omada handle the team-finding work." />
    <div className="home-grid">
      <section className="hero-panel">
        <div><Badge tone="accent">Omada</Badge><h2>Build a team that fills the gaps.</h2><p>Search people you already know, discover teams looking for your skills, or let auto-match propose a complementary group.</p></div>
        <div className="hero-actions"><Link className="btn btn-primary" to="/events">Explore events</Link><Link className="btn btn-soft" to="/profile">Complete profile</Link></div>
      </section>
      <section className="stats-grid"><Stat label="Active events" value={active.length}/><Stat label="Looking for a team" value={active.reduce((sum,e)=>sum+(e.looking_count ?? 0),0)}/><Stat label="Teams forming" value={active.reduce((sum,e)=>sum+e.team_count,0)}/></section>
      <section className="surface"><div className="section-heading"><div><h3>Your next step</h3><p>Select an event and jump into discovery.</p></div></div><div className="inline-form"><select value={eventId} onChange={(e) => setEventId(e.target.value)}><option value="">Select an event</option>{active.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select><Link className={`btn ${eventId ? 'btn-primary' : 'btn-disabled'}`} to={eventId ? `/event/${eventId}` : '#'} onClick={(e)=>!eventId && e.preventDefault()}>Open event</Link></div></section>
    </div>
  </>;
}

function Stat({ label, value }: { label: string; value: number }) { return <div className="stat-card"><span>{label}</span><strong>{value}</strong></div>; }

export function EventsPage() {
  const events = useAsync(api.listEvents, []);
  return <><PageHeader eyebrow="Explore" title="Events" description="Pick a project, competition, or hackathon and start building your team."/><div className="card-grid">{events.loading ? <Loading /> : events.error ? <ErrorBox message={events.error}/> : events.data?.data.map((event) => <Link className="event-card" to={`/event/${event.id}`} key={event.id}><Badge tone={event.status === 'registration_open' ? 'good' : 'neutral'}>{event.status.replaceAll('_',' ')}</Badge><h3>{event.name}</h3><p>{event.description || 'No description available.'}</p><div className="event-footer"><span>{event.participant_count} participants</span><span>{event.team_count} teams</span></div></Link>)}</div></>;
}

export function EventPage() {
  const { id = '' } = useParams();
  const event = useAsync(() => api.getEvent(id), [id]);
  const { refreshUser } = useAuth();
  const participation = useAsync(() => api.getParticipation(id), [id]);
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  async function act(fn: () => Promise<unknown>) { setAction('working'); setError(''); try { await fn(); await refreshUser(); await Promise.all([event.reload(), participation.reload()]); } catch(e){setError(e instanceof Error ? e.message : 'Action failed.');} finally {setAction('');} }
  if (event.loading) return <Loading />;
  if (!event.data) return <ErrorBox message={event.error ?? 'Event not found.'}/>;
  const participantStatus = participation.data?.status;
  return <><PageHeader eyebrow={event.data.eventType.replaceAll('_',' ')} title={event.data.name} description={event.data.description || undefined} action={<Link className="btn btn-soft" to={`/teams?event=${id}`}>Discover teams</Link>}/>
    {error && <div className="alert alert-danger">{error}</div>}
    <div className="two-col"><section className="surface"><div className="metric-row"><Stat label="Participants" value={event.data.participant_count}/><Stat label="Teams" value={event.data.team_count}/><Stat label="Looking" value={event.data.looking_count ?? 0}/></div><div className="section-block"><h3>Your status</h3><Badge tone={participantStatus ? 'accent' : 'neutral'}>{participantStatus ? participantStatus.replaceAll('_',' ') : 'Not registered'}</Badge><div className="action-row">{!participantStatus && event.data.status === 'registration_open' && <Button disabled={!!action} onClick={()=>void act(()=>api.registerForEvent(id))}>Register</Button>}{participantStatus === 'registered' && <Button disabled={!!action} onClick={()=>void act(()=>api.setParticipation(id,'looking_for_team'))}>I’m looking for a team</Button>}{participantStatus === 'looking_for_team' && event.data.matchmakingEnabled && <Button disabled={!!action} onClick={()=>void act(()=>api.enterMatchmaking(id))}>Join auto-match</Button>}{participantStatus === 'in_matchmaking' && <Button variant="ghost" disabled={!!action} onClick={()=>void act(()=>api.leaveMatchmaking(id))}>Leave auto-match</Button>}{['in_forming_team','in_finalized_team'].includes(participantStatus ?? '') && participation.data?.team?.id && <Link className="btn btn-primary" to={`/team/${id}/${participation.data.team.id}`}>Open your team</Link>}</div></div></section><section className="surface"><h3>Event focus</h3><div className="chip-column">{event.data.requiredSkills.map((r)=><div className="requirement-row" key={r.skillName}><Badge tone={r.constraintType==='hard'?'danger':'neutral'}>{r.constraintType}</Badge><span>{r.skillName}</span></div>)}{event.data.requiredRoles.map((r)=><div className="requirement-row" key={r.roleName}><Badge tone={r.constraintType==='hard'?'danger':'neutral'}>{r.constraintType}</Badge><span>{r.roleName}</span></div>)}</div></section></div></>;
}

export function TeamsPage() {
  const [search] = useSearchParams();
  const eventId = search.get('event') ?? '';
  const [mode, setMode] = useState<'explore'|'match_my_skills'>('explore');
  const teams = useAsync(() => eventId ? api.listTeams(eventId, mode) : Promise.resolve({ data: [] }), [eventId, mode]);
  const participation = useAsync(() => eventId
    ? api.getParticipation(eventId)
    : Promise.resolve({ registered: false, status: undefined, team: null, provisional_team: null }), [eventId]);
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [idea, setIdea] = useState('');
  const [requirements, setRequirements] = useState('');
  const [error, setError] = useState('');
  async function create(e: React.FormEvent) { e.preventDefault(); setError(''); try { const parsed = requirements.split(',').map((x)=>x.trim()).filter(Boolean).map((name)=>({type:'skill' as const,name,priority:'nice_to_have' as const})); const result = await api.createTeam(eventId,{name:createName,description:createDescription,project_idea:idea,requirements:parsed}); navigate(`/team/${eventId}/${result.team.id}`); } catch(e){setError(e instanceof Error?e.message:'Could not create team.');} }
  if (!eventId) return <ErrorBox message="Choose an event first." />;
  const myTeam = participation.data?.team ?? null;
  return <><PageHeader eyebrow="Discovery" title="Find a team" description="Explore forming teams, or rank them against your own skills and preferred roles." action={<Button onClick={()=>setShowCreate(true)}>Create a team</Button>}/>{myTeam&&<section className="surface section-margin"><div className="section-heading"><div><h3>Your team</h3><p>You are already a member of this team.</p></div><Link className="btn btn-primary" to={`/team/${eventId}/${myTeam.id}`}>Open team</Link></div><Badge tone={myTeam.status==='finalized'?'good':'warn'}>{myTeam.status}</Badge></section>}<div className="segmented"><button className={mode==='explore'?'selected':''} onClick={()=>setMode('explore')}>Explore all</button><button className={mode==='match_my_skills'?'selected':''} onClick={()=>setMode('match_my_skills')}>Match my skills</button></div>{teams.loading?<Loading/>:teams.error?<ErrorBox message={teams.error}/>:<div className="card-grid">{(teams.data?.data ?? []).map((item:any)=><TeamCard key={item.team?.id ?? item.id} team={item.team ?? item} action={<Link className="btn btn-soft btn-sm" to={`/team/${eventId}/${item.team?.id ?? item.id}`}>View</Link>}/>)}</div>}{showCreate&&<Modal title="Start a team" onClose={()=>setShowCreate(false)}><form className="form-stack" onSubmit={create}><Field label="Team name" value={createName} onChange={(e)=>setCreateName(e.target.value)} required/><Textarea label="Description" value={createDescription} onChange={(e)=>setCreateDescription(e.target.value)}/><Textarea label="Project idea" value={idea} onChange={(e)=>setIdea(e.target.value)}/><Field label="Skills you want (comma separated)" value={requirements} onChange={(e)=>setRequirements(e.target.value)}/>{error&&<div className="alert alert-danger">{error}</div>}<Button type="submit">Create team</Button></form></Modal>}</>;
}

export function TeamPage() {
  const { eventId = '', teamId = '' } = useParams();
  const team = useAsync(() => api.getTeam(eventId,teamId), [eventId,teamId]);
  const participation = useAsync(() => api.getParticipation(eventId), [eventId]);
  const { user, refreshUser } = useAuth();
  const navigate = useNavigate();
  const [candidateData,setCandidateData] = useState<Array<{user:User;overallScore:number;mustHaveMatch:string[];niceToHaveMatch:string[];roleMatch:string|null}>>([]);
  const [candidateQuery,setCandidateQuery]=useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  async function action(fn:()=>Promise<unknown>){setBusy(true);setError('');try{await fn();await refreshUser();await team.reload();}catch(e){setError(e instanceof Error?e.message:'Action failed.');}finally{setBusy(false);}}
  async function loadCandidates(){try{setCandidateData((await api.teamCandidates(eventId,teamId,candidateQuery)).data);}catch(e){setError(e instanceof Error?e.message:'Could not load candidates.');}}
  if(team.loading)return <Loading/>;
  if(!team.data)return <ErrorBox message={team.error??'Team not found.'}/>;
  const currentTeam = team.data;
  const isOwner=currentTeam.owner.id===user?.id;
  const currentMembership = currentTeam.members.find((m)=>m.userId===user?.id);
  const canManageMembers = currentMembership?.roleInTeam === 'owner' || currentMembership?.roleInTeam === 'admin';
  async function leaveCurrentTeam() {
    if (!window.confirm('Leave this team?')) return;
    await action(async()=>{ await api.leaveTeam(eventId,teamId); navigate(`/teams?event=${eventId}`); });
  }
  async function removeMember(userId: string, displayName: string) {
    if (!window.confirm(`Remove ${displayName} from this team?`)) return;
    await action(()=>api.removeTeamMember(eventId,teamId,userId));
  }
  return <><PageHeader eyebrow="Team workspace" title={currentTeam.name} description={currentTeam.projectIdea || currentTeam.description || undefined} action={<Link className="btn btn-soft" to={`/teams?event=${eventId}`}>Back to discovery</Link>}/>{error&&<div className="alert alert-danger">{error}</div>}<div className="two-col"><section className="surface"><div className="section-heading"><div><h3>Members</h3><p>{currentTeam.current_size} active member{currentTeam.current_size===1?'':'s'}</p></div><Badge tone={currentTeam.status==='forming'?'warn':'good'}>{currentTeam.status}</Badge></div><div className="member-list">{currentTeam.members.map(m=><div className="member-row" key={m.id}><Avatar user={m.user}/><div><strong>{m.user.displayName}</strong><small>{m.roleInTeam}{m.user.preferredRoles[0] ? ` · ${m.user.preferredRoles[0].roleDisplay}` : ''}</small></div><div className="chip-row">{m.user.skills.slice(0,2).map(s=><Badge key={s.skillName}>{s.skillDisplay}</Badge>)}</div>{canManageMembers && m.userId!==user?.id && (currentMembership?.roleInTeam==='owner' || m.roleInTeam==='member') && <Button variant="danger" className="btn-sm" disabled={busy} onClick={()=>void removeMember(m.userId,m.user.displayName)}>Remove</Button>}</div>)}</div></section><section className="surface"><h3>Team actions</h3><div className="action-grid">{currentTeam.chatRoomId&&<Link className="btn btn-soft" to={`/chat/${currentTeam.chatRoomId}?team=${teamId}&event=${eventId}`}>Open chat</Link>}{currentTeam.status==='forming'&&participation.data?.status==='looking_for_team'&&!currentTeam.members.some((m)=>m.userId===user?.id)&&<Button disabled={busy} onClick={()=>void action(async()=>{await api.sendRequest(eventId,{type:'join_request',team_id:teamId,message:'I’d like to join your team.'}); await participation.reload();})}>Request to join</Button>}{isOwner&&currentTeam.status==='forming'&&<><Button variant="soft" onClick={()=>void loadCandidates()}>Find candidates</Button><Button disabled={busy} onClick={()=>void action(()=>api.finalizeTeam(eventId,teamId))}>Finalize team</Button><Button variant="danger" disabled={busy} onClick={()=>void action(()=>api.dissolveTeam(eventId,teamId))}>Dissolve</Button></>}{user?.id&&currentTeam.members.some(m=>m.userId===user.id)&&['forming','finalized'].includes(currentTeam.status)&&<Button variant="ghost" disabled={busy} onClick={()=>void leaveCurrentTeam()}>Leave team</Button>}</div></section></div>{candidateData.length>0&&<section className="surface section-margin"><div className="section-heading"><div><h3>Candidate search</h3><p>Search by name or let Omada rank compatible people.</p></div><div className="inline-form"><input className="candidate-search" placeholder="Search a person by name…" value={candidateQuery} onChange={e=>setCandidateQuery(e.target.value)}/><Button variant="soft" onClick={()=>void loadCandidates()}>Search</Button></div></div><div className="card-grid">{candidateData.map(c=><UserCard key={c.user.id} user={c.user} extra={<div className="candidate-footer"><span>Score {(c.overallScore*100).toFixed(0)}%</span><Button variant="soft" onClick={()=>void api.sendRequest(eventId,{type:'team_invite',team_id:teamId,recipient_id:c.user.id,message:`We think you could complement ${currentTeam.name}.`})}>Invite</Button></div>}/>)}</div></section>}</>;
}

export function ProvisionalPage() {
  const { eventId = '', provisionalId = '' } = useParams();
  const pt = useAsync(() => api.getProvisional(eventId, provisionalId), [eventId, provisionalId]);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function respond(action: 'accept' | 'reject') {
    setBusy(true); setError('');
    try {
      const result = await api.respondProvisional(eventId, provisionalId, action);
      if (result.team_id) navigate(`/team/${eventId}/${result.team_id}`, { replace: true });
      else await pt.reload();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not respond.'); }
    finally { setBusy(false); }
  }
  if (pt.loading) return <Loading />;
  if (!pt.data) return <ErrorBox message={pt.error ?? 'Match proposal not found.'} />;
  return <>
    <PageHeader eyebrow="Auto-match proposal" title="A team for you" description="Review the people, the match reasoning, and decide whether this group is right for you." />
    {error && <div className="alert alert-danger">{error}</div>}
    <div className="two-col">
      <section className="surface">
        <div className="section-heading"><div><h3>Match quality</h3><p>Score is a model signal, not a requirement to accept.</p></div><Badge tone="accent">{Math.round(Number(pt.data.matchScore ?? 0) * 100)}%</Badge></div>
        <div className="member-list">{pt.data.members.map((m)=><div className="member-row" key={m.id}><Avatar user={m.user}/><div><strong>{m.user.displayName}</strong><small>{m.status} {m.user.preferredRoles[0] ? ` · ${m.user.preferredRoles[0].roleDisplay}` : ''}</small></div><div className="chip-row">{m.user.skills.slice(0,3).map(s=><Badge key={s.skillName}>{s.skillDisplay}</Badge>)}</div></div>)}</div>
      </section>
      <section className="surface">
        <h3>Why this team?</h3>
        <p className="muted">Omada uses complementary skills, role coverage, experience balance, interests, and role preferences to score the proposal.</p>
        <div className="action-grid"><Button disabled={busy} onClick={()=>void respond('accept')}>Accept proposal</Button><Button variant="danger" disabled={busy} onClick={()=>void respond('reject')}>Decline & find replacement</Button></div>
      </section>
    </div>
  </>;
}

export function ProfilePage() {
  const { user, refreshUser } = useAuth();
  const [name,setName]=useState(user?.displayName??''); const [bio,setBio]=useState(user?.bio??'');
  const [skills,setSkills]=useState(user?.skills.map(s=>s.skillDisplay).join(', ')??'');
  const [roles,setRoles]=useState(user?.preferredRoles.map(r=>r.roleDisplay).join(', ')??'');
  const [interests,setInterests]=useState(user?.interests.map(i=>i.interestDisplay).join(', ')??'');
  const [saved,setSaved]=useState('');
  async function save(){try{await api.updateProfile({display_name:name,bio});await api.updateSkills(skills.split(',').map(s=>s.trim()).filter(Boolean).map(s=>({skill_display:s,proficiency:3})));await api.updateRoles(roles.split(',').map(s=>s.trim()).filter(Boolean).map((s,i)=>({role_display:s,priority:i+1})));await api.updateInterests(interests.split(',').map(s=>s.trim()).filter(Boolean).map(s=>({interest_display:s})));await refreshUser();setSaved('Saved.')}catch(e){setSaved(e instanceof Error?e.message:'Could not save.');}}
  return <><PageHeader eyebrow="Your profile" title="Show teams what you bring." description="Your profile powers both team discovery and auto-match."/><div className="profile-grid"><section className="surface"><div className="profile-hero"><Avatar user={user!} size={72}/><div><h2>{user?.displayName}</h2><p>{user?.email}</p></div></div><div className="form-stack"><Field label="Display name" value={name} onChange={e=>setName(e.target.value)}/><Textarea label="Bio" value={bio} onChange={e=>setBio(e.target.value)} /><Field label="Skills" value={skills} onChange={e=>setSkills(e.target.value)}/><Field label="Preferred roles" value={roles} onChange={e=>setRoles(e.target.value)}/><Field label="Interests" value={interests} onChange={e=>setInterests(e.target.value)}/>{saved&&<div className="alert">{saved}</div>}<Button onClick={()=>void save()}>Save profile</Button></div></section><section className="surface"><h3>Your profile at a glance</h3><div className="stack"><div><span className="label">Skills</span><div className="chip-row">{user?.skills.map(s=><Badge key={s.skillName}>{s.skillDisplay}</Badge>)}</div></div><div><span className="label">Roles</span><div className="chip-row">{user?.preferredRoles.map(r=><Badge tone="accent" key={r.roleName}>{r.roleDisplay}</Badge>)}</div></div><div><span className="label">Interests</span><div className="chip-row">{user?.interests.map(i=><Badge tone="good" key={i.interestName}>{i.interestDisplay}</Badge>)}</div></div></div></section></div></>;
}

export function RequestsPage() {
  const events=useAsync(api.listEvents,[]);
  const [direction,setDirection]=useState<'received'|'sent'>('received');
  const [eventId,setEventId]=useState('');
  const requests=useAsync(()=>eventId?api.listRequests(eventId,direction):Promise.resolve({data:[]}),[eventId,direction]);
  async function respond(id:string,action:'accept'|'reject'|'cancel'){try{await api.respondRequest(eventId,id,action);await requests.reload();}catch(e){alert(e instanceof Error?e.message:'Could not update request.');}}
  return <><PageHeader eyebrow="Inbox" title="Requests" description="Manage team invites and join requests."/><div className="toolbar"><select value={eventId} onChange={e=>setEventId(e.target.value)}><option value="">Choose event</option>{events.data?.data.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select><div className="segmented compact"><button className={direction==='received'?'selected':''} onClick={()=>setDirection('received')}>Received</button><button className={direction==='sent'?'selected':''} onClick={()=>setDirection('sent')}>Sent</button></div></div><div className="card-grid">{requests.data?.data.map(r=><div className="request-card" key={r.id}><div><Badge tone={r.status==='pending'?'warn':r.status==='accepted'?'good':'neutral'}>{r.status}</Badge><h3>{r.type.replaceAll('_',' ')}</h3><p>{r.message || 'No message.'}</p><small>{direction==='received'?`From ${r.sender.displayName}`:`To ${r.recipient.displayName}`}{r.team? ` · ${r.team.name}`:''}</small></div>{r.status==='pending'&&<div className="action-row">{direction==='received'?<><Button onClick={()=>void respond(r.id,'accept')}>Accept</Button><Button variant="ghost" onClick={()=>void respond(r.id,'reject')}>Decline</Button></>:<Button variant="ghost" onClick={()=>void respond(r.id,'cancel')}>Cancel</Button>}</div>}</div>)}</div></>;
}

export function NotificationsPage() {
  const data=useAsync(api.notifications,[]);
  async function read(id:string){await api.markNotification(id);await data.reload();}
  async function all(){await api.markAllNotifications();await data.reload();}
  return <><PageHeader eyebrow="Updates" title="Notifications" description="Stay on top of invitations, match proposals, and team activity." action={<Button variant="soft" onClick={()=>void all()}>Mark all read</Button>}/><div className="notification-list">{data.data?.data.map((n:Notification)=>{const provisionalId=typeof n.data?.provisional_team_id==='string'?n.data.provisional_team_id:null; const eventId=typeof n.data?.event_id==='string'?n.data.event_id:null; const body=<><div className="notification-dot"/><div><strong>{n.title}</strong><p>{n.body}</p><small>{new Date(n.createdAt).toLocaleString()}</small></div></>; return provisionalId&&eventId?<Link className={n.isRead?'notification read':'notification'} key={n.id} to={`/provisional/${eventId}/${provisionalId}`} onClick={()=>void read(n.id)}>{body}</Link>:<button className={n.isRead?'notification read':'notification'} key={n.id} onClick={()=>void read(n.id)}>{body}</button>;})}</div></>;
}

export function ChatPage() {
  const { roomId='' }=useParams(); const [query]=useSearchParams();
  const eventId=query.get('event')??''; const teamId=query.get('team')??'';
  const { user }=useAuth(); const data=useAsync(()=>api.messages(roomId),[roomId]);
  const [content,setContent]=useState(''); const [socketReady,setSocketReady]=useState(false); const [live,setLive]=useState(data.data?.data??[]);
  useEffect(()=>{ if(data.data?.data) setLive(data.data.data); },[data.data]);
  useEffect(()=>{const token=api.getAccessToken();if(!token)return;let socket: import('socket.io-client').Socket;let cancelled=false;(async()=>{const mod=await import('socket.io-client');if(cancelled)return;socket=mod.io(import.meta.env.VITE_WS_URL??'http://localhost:3000',{auth:{token:`Bearer ${token}`}});socket.on('connect',()=>{setSocketReady(true);socket.emit('chat:join_room',{room_id:roomId});});socket.on('disconnect',()=>setSocketReady(false));socket.on('chat:new_message',(payload:{message:any})=>{setLive(old=>[...old,payload.message]);});})();return()=>{cancelled=true;socket?.disconnect();};},[roomId]);
  async function send(e:React.FormEvent){e.preventDefault();if(!content.trim())return;try{await api.postMessage(roomId,content);setContent('');}catch(e){alert(e instanceof Error?e.message:'Could not send.');}}
  return <div className="chat-page"><PageHeader eyebrow="Team chat" title="Workspace" description={socketReady?'Live connection':'Connecting…'} action={<Link className="btn btn-soft" to={teamId? `/team/${eventId}/${teamId}`:'/'}>Back</Link>}/><div className="chat-panel"><div className="message-list">{(live.length?live:(data.data?.data??[])).map(m=><div className={m.sender.id===user?.id?'message me':'message'} key={m.id}><Avatar user={m.sender} size={30}/><div><strong>{m.sender.displayName}</strong><p>{m.content}</p><small>{new Date(m.createdAt).toLocaleTimeString()}</small></div></div>)}</div><form className="chat-input" onSubmit={send}><input value={content} onChange={e=>setContent(e.target.value)} placeholder="Write a message…" maxLength={5000}/><Button type="submit">Send</Button></form></div></div>;
}

function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:React.ReactNode}){return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal" onMouseDown={e=>e.stopPropagation()}><div className="section-heading"><h3>{title}</h3><button className="icon-button" onClick={onClose}>×</button></div>{children}</div></div>}
function Loading(){return <div className="screen-center"><div className="spinner"/></div>}
function ErrorBox({message}:{message:string}){return <div className="alert alert-danger">{message}</div>}
