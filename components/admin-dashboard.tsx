'use client'

import { useEffect, useState } from 'react'
import { getSupabaseBrowserClient } from '@/lib/supabase-browser'
import { ArrowLeft, BriefcaseBusiness, ClipboardList, LogIn, RefreshCw, Users } from 'lucide-react'

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
    const [{ count: opportunityCount, error: opportunityError }, { data: applicationRows, count: applicationCount, error: applicationError }] = await Promise.all([
      supabase.from('opportunities').select('id', { count: 'exact', head: true }),
      supabase.from('applications').select('user_id', { count: 'exact' }),
    ])
    if (opportunityError || applicationError) { setMessage('Admin data could not be loaded. Check Supabase table access.'); return }
    const users = new Map<string, number>()
    ;(applicationRows ?? []).forEach((row) => users.set(row.user_id, (users.get(row.user_id) ?? 0) + 1))
    setState({ email: user.email ?? 'Signed-in user', users: Array.from(users, ([id, applications]) => ({ id, applications })), opportunities: opportunityCount ?? 0, applications: applicationCount ?? 0 })
    setMessage('')
  }

  useEffect(() => { void load() }, [])

  if (!state) return <main className="admin-page"><div className="admin-message"><p>{message}</p>{message.startsWith('Please') ? <a className="admin-link" href="/">Return to sign in <LogIn size={15}/></a> : <button className="admin-link" onClick={() => void load()}>Retry <RefreshCw size={15}/></button>}</div></main>
  return <main className="admin-page"><header className="admin-header"><div><span className="section-kicker">ANTS.AI ADMINISTRATION</span><h1>Admin Dashboard<span className="heading-dot">.</span></h1><p>Signed in as {state.email}</p></div><a className="admin-link" href="/"><ArrowLeft size={15}/> Back to app</a></header><section className="admin-metrics"><AdminMetric icon={<Users/>} label="Users Details" value={state.users.length}/><AdminMetric icon={<BriefcaseBusiness/>} label="Total Opportunities" value={state.opportunities}/><AdminMetric icon={<ClipboardList/>} label="Total Applications" value={state.applications}/></section><section className="admin-panel"><div className="admin-panel-heading"><div><span className="section-kicker">MANAGE YOUR PLATFORM</span><h2>Opportunities</h2></div><button className="admin-link" onClick={() => void load()}><RefreshCw size={15}/> Refresh</button></div><div className="admin-table"><div className="admin-table-row admin-table-head"><span>User ID</span><span>Applications</span></div>{state.users.length === 0 ? <p className="admin-empty">No application activity yet.</p> : state.users.map((user) => <div className="admin-table-row" key={user.id}><span>{user.id}</span><strong>{user.applications}</strong></div>)}</div></section></main>
}

function AdminMetric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) { return <article className="admin-metric"><span>{icon}</span><small>{label}</small><strong>{value}</strong></article> }

export default AdminDashboard
