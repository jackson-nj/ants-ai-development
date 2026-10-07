'use client'

import { useEffect, useState } from 'react'
import { getSupabaseBrowserClient } from '@/lib/supabase-browser'
import { ArrowLeft, BriefcaseBusiness, ClipboardList, Eye, EyeOff, LogIn, RefreshCw, ShieldCheck, Users } from 'lucide-react'

type AdminState = { email: string; users: { id: string; applications: number }[]; opportunities: number; applications: number }

export function AdminDashboard() {
  const [state, setState] = useState<AdminState | null>(null)
  const [message, setMessage] = useState('Loading admin data…')
  async function load() {
    setMessage('Loading admin data…')
    const supabase = getSupabaseBrowserClient()
    const { data: sessionData } = await supabase.auth.getSession()
    const user = sessionData.session?.user
    if (!user) { setMessage('Please sign in to access the admin dashboard.'); return }
    const isAuthorizedAdmin = user.app_metadata?.role === 'admin' || user.email?.toLowerCase() === 'jnjovu@gmail.com'
  if (!isAuthorizedAdmin) { setMessage('You do not have permission to access the admin dashboard.'); return }
    const [{ count: opportunityCount, error: opportunityError }, { data: applicationRows, count: applicationCount, error: applicationError }] = await Promise.all([supabase.from('opportunities').select('id', { count: 'exact', head: true }), supabase.from('applications').select('user_id', { count: 'exact' })])
    if (opportunityError || applicationError) { setMessage('Admin data could not be loaded. Check Supabase table access.'); return }
    const users = new Map<string, number>(); (applicationRows ?? []).forEach((row) => users.set(row.user_id, (users.get(row.user_id) ?? 0) + 1))
    setState({ email: user.email ?? 'Signed-in user', users: Array.from(users, ([id, applications]) => ({ id, applications })), opportunities: opportunityCount ?? 0, applications: applicationCount ?? 0 }); setMessage('')
  }
  useEffect(() => { void load() }, [])
  if (!state && message.startsWith('Please')) return <AdminLogin onSuccess={() => void load()} />
  if (!state) return <main className="admin-page"><div className="admin-message"><p>{message}</p>{message.startsWith('You do not') ? <a className="admin-link" href="/">Return to app <LogIn size={15}/></a> : <button className="admin-link" onClick={() => void load()}>Retry <RefreshCw size={15}/></button>}</div></main>
  return <main className="admin-page"><header className="admin-header"><div><span className="section-kicker">ANTS.AI ADMINISTRATION</span><h1>Admin Dashboard<span className="heading-dot">.</span></h1><p>Signed in as {state.email}</p></div><a className="admin-link" href="/"><ArrowLeft size={15}/> Back to app</a></header><section className="admin-metrics"><AdminMetric icon={<Users/>} label="Users Details" value={state.users.length}/><AdminMetric icon={<BriefcaseBusiness/>} label="Total Opportunities" value={state.opportunities}/><AdminMetric icon={<ClipboardList/>} label="Total Applications" value={state.applications}/></section><section className="admin-panel"><div className="admin-panel-heading"><div><span className="section-kicker">MANAGE YOUR PLATFORM</span><h2>Users</h2></div><button className="admin-link" onClick={() => void load()}><RefreshCw size={15}/> Refresh</button></div><div className="admin-table"><div className="admin-table-row admin-table-head"><span>User ID</span><span>Applications</span></div>{state.users.length === 0 ? <p className="admin-empty">No application activity yet.</p> : state.users.map((user) => <div className="admin-table-row" key={user.id}><span>{user.id}</span><strong>{user.applications}</strong></div>)}</div></section></main>
}

function AdminLogin({ onSuccess }: { onSuccess: () => void }) {
  const [showPassword, setShowPassword] = useState(false); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  async function submit(event: React.FormEvent<HTMLFormElement>) { event.preventDefault(); setBusy(true); setError(''); const form = new FormData(event.currentTarget); const { error } = await getSupabaseBrowserClient().auth.signInWithPassword({ email: String(form.get('email') || ''), password: String(form.get('password') || '') }); setBusy(false); if (error) { setError('Unable to sign in. Check your administrator credentials.'); return } onSuccess() }
  return <main className="admin-login-page"><section className="admin-login-card"><div className="admin-login-copy"><span className="section-kicker">PRIVATE WORKSPACE</span><h1>Secure admin<br/><em>sign in.</em></h1><p>Access is limited to authorized Ants.AI administrators. Your credentials are encrypted and protected by Supabase Auth.</p><div className="admin-security"><ShieldCheck size={18}/><span><strong>Secure login</strong><small>Admin activity stays private and access is role-checked.</small></span></div></div><form className="admin-login-form" onSubmit={submit}><label>Email address<input name="email" type="email" autoComplete="email" required /></label><label>Password<div className="password-field"><input name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required /><button type="button" onClick={() => setShowPassword(value => !value)} aria-label="Toggle password visibility">{showPassword ? <EyeOff size={15}/> : <Eye size={15}/>}</button></div></label>{error && <p className="auth-error" role="alert">{error}</p>}<button className="admin-link admin-login-submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'} <LogIn size={15}/></button></form></section></main>
}

function AdminMetric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) { return <article className="admin-metric"><span>{icon}</span><small>{label}</small><strong>{value}</strong></article> }

export default AdminDashboard
