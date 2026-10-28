'use client'

import { useEffect, useState } from 'react'
import { getSupabaseBrowserClient } from '@/lib/supabase-browser'
import { fetchRecentOpportunities, isVisibleOpportunity } from '@/lib/opportunity-filters'
import { ArrowLeft, BriefcaseBusiness, ClipboardList, Eye, EyeOff, LogIn, LogOut, RefreshCw, ShieldCheck, Sparkles, Users } from 'lucide-react'

// Only this account may open the dashboard; its password lives in Supabase Auth, never in code.
const ADMIN_EMAIL = 'njovujackson21@gmail.com'
const isAdminEmail = (email?: string | null) => email?.trim().toLowerCase() === ADMIN_EMAIL

type AdminUser = { id: string; applications: number; lastActive: string }
type AdminApplication = { id: string; userId: string; status: string; updatedAt: string; role: string; company: string }
type AdminState = { email: string; users: AdminUser[]; recent: AdminApplication[]; opportunities: number; newToday: number; applications: number; refreshedAt: string }

const shortId = (id: string) => `${id.slice(0, 8)}…${id.slice(-4)}`
const formatDate = (value: string) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const statusLabel = (status: string) => status === 'draft' ? 'Draft' : status === 'reviewing' ? 'Reviewing' : 'Applied'

export function AdminDashboard() {
  const [state, setState] = useState<AdminState | null>(null)
  const [message, setMessage] = useState('Loading admin data…')
  async function load() {
    setMessage('Loading admin data…')
    const supabase = getSupabaseBrowserClient()
    const { data: sessionData } = await supabase.auth.getSession()
    const user = sessionData.session?.user
    if (!user) { setMessage('Please sign in to access the admin dashboard.'); return }
    const isAuthorizedAdmin = isAdminEmail(user.email)
    if (!isAuthorizedAdmin) { setMessage('Please sign in with the administrator account.'); return }
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
    const [{ rows: opportunityRows, error: opportunityError }, { data: applicationRows, count: applicationCount, error: applicationError }] = await Promise.all([
      // Count with the same rules the Opportunities page uses, so both numbers match.
      fetchRecentOpportunities(supabase, 'id, source, company, role, location, description, posted_at'),
      supabase.from('applications').select('id, user_id, status, updated_at, opportunities(role, company)', { count: 'exact' }).order('updated_at', { ascending: false }),
    ])
    if (opportunityError || applicationError) { setMessage('Admin data could not be loaded. Check Supabase table access.'); return }
    const liveOpportunities = opportunityRows.filter(isVisibleOpportunity)
    const users = new Map<string, AdminUser>()
    ;(applicationRows ?? []).forEach((row) => { const existing = users.get(row.user_id); users.set(row.user_id, { id: row.user_id, applications: (existing?.applications ?? 0) + 1, lastActive: existing?.lastActive ?? row.updated_at }) })
    const recent = (applicationRows ?? []).slice(0, 8).map((row: any) => { const job = Array.isArray(row.opportunities) ? row.opportunities[0] : row.opportunities; return { id: row.id, userId: row.user_id, status: row.status, updatedAt: row.updated_at, role: job?.role ?? 'Removed listing', company: job?.company ?? '—' } })
    setState({ email: user.email ?? 'Signed-in user', users: Array.from(users.values()), recent, opportunities: liveOpportunities.length, newToday: liveOpportunities.filter((job) => new Date(job.posted_at) >= startOfToday).length, applications: applicationCount ?? 0, refreshedAt: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) }); setMessage('')
  }
  async function logout() {
    await getSupabaseBrowserClient().auth.signOut()
    setState(null); setMessage('Please sign in to access the admin dashboard.')
  }
  useEffect(() => { void load() }, [])
  if (!state && message.startsWith('Please')) return <AdminLogin onSuccess={() => void load()} />
  if (!state) return <main className="admin-page"><div className="admin-message"><p>{message}</p>{message.startsWith('You do not') ? <a className="admin-link" href="/">Return to app <LogIn size={15}/></a> : <button className="admin-link" onClick={() => void load()}>Retry <RefreshCw size={15}/></button>}</div></main>
  return <main className="admin-page"><header className="admin-header"><div><span className="section-kicker">ANTS.AI ADMINISTRATION</span><h1>Admin Dashboard<span className="heading-dot">.</span></h1><p>Signed in as <strong>{state.email}</strong> · Updated {state.refreshedAt}</p></div><div className="admin-header-actions"><button className="admin-button-ghost" onClick={() => void load()}><RefreshCw size={15}/> Refresh</button><a className="admin-button-ghost" href="/"><ArrowLeft size={15}/> Back to app</a><button className="admin-link" onClick={() => void logout()}><LogOut size={15}/> Log out</button></div></header>
    <section className="admin-metrics"><AdminMetric icon={<Users size={20}/>} label="Active users" value={state.users.length} hint="Users with at least one application"/><AdminMetric icon={<BriefcaseBusiness size={20}/>} label="Live opportunities" value={state.opportunities} hint="Listings from the last 2 months"/><AdminMetric icon={<Sparkles size={20}/>} label="New today" value={state.newToday} hint="Posted since midnight"/><AdminMetric icon={<ClipboardList size={20}/>} label="Total applications" value={state.applications} hint={state.users.length ? `${(state.applications / state.users.length).toFixed(1)} per active user` : 'No applications yet'}/></section>
    <div className="admin-panels"><section className="admin-panel"><div className="admin-panel-heading"><div><span className="section-kicker">LATEST ACTIVITY</span><h2>Recent applications</h2></div></div>{state.recent.length === 0 ? <p className="admin-empty">No applications yet.</p> : <div className="admin-table"><div className="admin-table-row admin-table-head admin-row-apps"><span>Opportunity</span><span>User</span><span>Status</span><span>Date</span></div>{state.recent.map((item) => <div className="admin-table-row admin-row-apps" key={item.id}><span className="admin-cell-main"><strong>{item.role}</strong><small>{item.company}</small></span><code title={item.userId}>{shortId(item.userId)}</code><span className={`status ${statusLabel(item.status).toLowerCase()}`}>{statusLabel(item.status)}</span><span className="admin-muted">{formatDate(item.updatedAt)}</span></div>)}</div>}</section>
    <section className="admin-panel"><div className="admin-panel-heading"><div><span className="section-kicker">MANAGE YOUR PLATFORM</span><h2>Users</h2></div><span className="admin-count">{state.users.length}</span></div>{state.users.length === 0 ? <p className="admin-empty">No application activity yet.</p> : <div className="admin-table"><div className="admin-table-row admin-table-head admin-row-users"><span>User</span><span>Applications</span><span>Last active</span></div>{state.users.map((item) => <div className="admin-table-row admin-row-users" key={item.id}><span className="admin-user"><span className="admin-avatar">{item.id.slice(0, 2).toUpperCase()}</span><code title={item.id}>{shortId(item.id)}</code></span><strong>{item.applications}</strong><span className="admin-muted">{formatDate(item.lastActive)}</span></div>)}</div>}</section></div></main>
}

function AdminLogin({ onSuccess }: { onSuccess: () => void }) {
  const [showPassword, setShowPassword] = useState(false); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  async function submit(event: React.FormEvent<HTMLFormElement>) { event.preventDefault(); setBusy(true); setError(''); const form = new FormData(event.currentTarget); const email = String(form.get('email') || '').trim(); if (!isAdminEmail(email)) { setBusy(false); setError('This account is not authorized for admin access.'); return } const supabase = getSupabaseBrowserClient(); const { data, error } = await supabase.auth.signInWithPassword({ email, password: String(form.get('password') || '') }); setBusy(false); if (error || !isAdminEmail(data.user?.email)) { if (!error) await supabase.auth.signOut(); setError('Unable to sign in. Check your administrator credentials.'); return } onSuccess() }
  return <main className="admin-login-page"><section className="admin-login-card"><div className="admin-login-copy"><span className="section-kicker">PRIVATE WORKSPACE</span><h1>Secure admin<br/><em>sign in.</em></h1><p>Access is limited to authorized Ants.AI administrators. Your credentials are encrypted and protected by Supabase Auth.</p><div className="admin-security"><ShieldCheck size={18}/><span><strong>Secure login</strong><small>Admin activity stays private and access is role-checked.</small></span></div></div><form className="admin-login-form" onSubmit={submit}><label>Email address<input name="email" type="email" autoComplete="email" required /></label><label>Password<div className="password-field"><input name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required /><button type="button" onClick={() => setShowPassword(value => !value)} aria-label="Toggle password visibility">{showPassword ? <EyeOff size={15}/> : <Eye size={15}/>}</button></div></label>{error && <p className="auth-error" role="alert">{error}</p>}<button className="admin-link admin-login-submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'} <LogIn size={15}/></button></form></section></main>
}

function AdminMetric({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: number; hint: string }) { return <article className="admin-metric"><span>{icon}</span><small>{label}</small><strong>{value.toLocaleString()}</strong><em>{hint}</em></article> }

export default AdminDashboard
