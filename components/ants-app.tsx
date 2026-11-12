'use client'

import { useEffect, useState } from 'react'
import { getSupabaseBrowserClient } from '@/lib/supabase-browser'
import { fetchRecentOpportunities, isVisibleOpportunity } from '@/lib/opportunity-filters'
import { parseJobDescription, remoteLabel, subheadingOf } from '@/lib/job-text'
import { emptyProfile, explainMatch, profileCompleteness, profileGaps, profileToText, STRONG_MATCH_SCORE, type CandidateProfile } from '@/lib/matching'
import {
  ArrowLeft, ArrowRight, Bell, BriefcaseBusiness, CalendarDays, Check, ChevronDown, ClipboardList,
  Clock3, MapPin, Wallet, Copy, FileText, GraduationCap, LayoutDashboard, Lightbulb,
  LogOut, Menu, MoreHorizontal, Plus, Search, Send, Settings, Sparkles,
  Target, Upload, UserRound, Users, X, Zap,
} from 'lucide-react'

type View = 'landing' | 'login' | 'signup' | 'demo' | 'onboarding' | 'dashboard' | 'opportunities' | 'applications' | 'assistant'

type Opportunity = {
  id: string; company: string; role: string; location: string; mode: string; salary: string; posted: string; score: number; color: string; tags: string[]; description: string; sourceUrl: string; postedAt?: string
}

const isPostedToday = (postedAt?: string) => !!postedAt && new Date(postedAt).toDateString() === new Date().toDateString()

const opportunities: Opportunity[] = []

type Application = { id: string; opportunity_id: string; status: string; updated_at: string; opportunity?: Opportunity }
type Matching = { status: 'loading' | 'ready' | 'needs-profile' | 'signed-out' | 'unavailable'; skills: string[]; gaps: string[] }
type PlatformData = { jobs: Opportunity[]; applications: Application[]; matching: Matching }
const emptyPlatform = (): PlatformData => ({ jobs: [], applications: [], matching: { status: 'signed-out', skills: [], gaps: [] } })
let platformCache: PlatformData | null = null
let platformLoad: Promise<PlatformData> | null = null
const platformListeners = new Set<(next: PlatformData) => void>()
const DEMO_APPLICATIONS_KEY = 'ants-demo-applications'
const PROFILE_DRAFT_KEY = 'ants-profile-draft'

function readDemoApplications(): Application[] {
  try { return JSON.parse(window.localStorage.getItem(DEMO_APPLICATIONS_KEY) || '[]') } catch { return [] }
}

function setPlatformCache(next: PlatformData) {
  platformCache = next
  platformListeners.forEach((listener) => listener(next))
}

function addApplicationToCache(application: Application) {
  const current = platformCache ?? emptyPlatform()
  setPlatformCache({ ...current, applications: [application, ...current.applications.filter((item) => item.opportunity_id !== application.opportunity_id)] })
}

function setMatching(matching: Matching, scores?: Map<string, number>) {
  const current = platformCache ?? emptyPlatform()
  const jobs = scores ? current.jobs.map((job) => ({ ...job, score: scores.get(job.id) ?? 0 })) : current.jobs
  const applications = current.applications.map((item) => ({ ...item, opportunity: jobs.find((job) => job.id === item.opportunity_id) ?? item.opportunity }))
  setPlatformCache({ jobs, applications, matching })
}

function readProfileDraft(): CandidateProfile | null {
  try { const raw = window.localStorage.getItem(PROFILE_DRAFT_KEY); return raw ? { ...emptyProfile(), ...JSON.parse(raw) } : null } catch { return null }
}

const PROFILE_COLUMNS = 'full_name, location, role_title, years_experience, looking_for, skills, experience, education, cv_text, cv_file_name'

// Clearing the embedding makes /api/matches re-embed the profile, which costs a Gemini request, so it
// is only cleared when the text the AI reads has actually changed.
async function writeProfile(userId: string, profile: CandidateProfile) {
  const client = getSupabaseBrowserClient()
  const next = { ...profile, years_experience: profile.years_experience ?? 0 }
  const { data: current } = await client.from('profiles').select(PROFILE_COLUMNS).eq('id', userId).maybeSingle()
  const changed = !current || profileToText({ ...emptyProfile(), ...current }) !== profileToText(next)
  const { error } = await client.from('profiles').upsert({ id: userId, ...next, ...(changed ? { embedding: null } : {}), updated_at: new Date().toISOString() })
  if (!error) try { window.localStorage.removeItem(PROFILE_DRAFT_KEY) } catch {}
  return error
}

async function saveProfile(profile: CandidateProfile): Promise<{ saved: true } | { saved: false; message: string }> {
  const { data } = await getSupabaseBrowserClient().auth.getSession()
  const userId = data.session?.user.id
  if (!userId) {
    // Visitors who have not confirmed their email yet keep a draft that is saved on their first login.
    try { window.localStorage.setItem(PROFILE_DRAFT_KEY, JSON.stringify(profile)) } catch {}
    return { saved: false, message: 'Your profile is saved on this device. Log in to store it and get AI matches.' }
  }
  const error = await writeProfile(userId, profile)
  if (error) return { saved: false, message: error.message }
  void refreshMatches()
  void refreshIdentity()
  return { saved: true }
}

async function refreshMatches() {
  const current = platformCache?.matching
  setMatching({ status: 'loading', skills: current?.skills ?? [], gaps: [] })
  const { data } = await getSupabaseBrowserClient().auth.getSession()
  const userId = data.session?.user.id
  if (!userId) { setMatching({ status: 'signed-out', skills: [], gaps: [] }); return }
  const draft = readProfileDraft()
  if (draft) await writeProfile(userId, draft)
  try {
    const response = await fetch('/api/matches', { method: 'POST' })
    const body = await response.json().catch(() => ({}))
    if (response.status === 401) { setMatching({ status: 'signed-out', skills: [], gaps: [] }); return }
    if (!response.ok) { console.error('[v0] Matching failed:', body); setMatching({ status: 'unavailable', skills: [], gaps: [] }); return }
    if (body.needsProfile) { setMatching({ status: 'needs-profile', skills: body.skills ?? [], gaps: body.gaps ?? [] }, new Map()); return }
    setMatching({ status: 'ready', skills: body.skills ?? [], gaps: body.gaps ?? [] }, new Map((body.matches as { id: string; score: number }[]).map((match) => [match.id, match.score])))
  } catch (error) {
    console.error('[v0] Matching failed:', error)
    setMatching({ status: 'unavailable', skills: [], gaps: [] })
  }
}

async function submitApplication(job: Opportunity): Promise<{ ok: true } | { ok: false; message: string }> {
  const client = getSupabaseBrowserClient()
  const { data: sessionData } = await client.auth.getSession()
  const userId = sessionData.session?.user.id
  if (!userId) {
    // Demo visitors have no Supabase session, so their applications live in this browser only.
    const application: Application = { id: `demo-${job.id}`, opportunity_id: job.id, status: 'applied', updated_at: new Date().toISOString(), opportunity: job }
    try { window.localStorage.setItem(DEMO_APPLICATIONS_KEY, JSON.stringify([application, ...readDemoApplications().filter((item) => item.opportunity_id !== job.id)])) } catch {}
    addApplicationToCache(application)
    return { ok: true }
  }
  // The table's status check constraint decides which values are valid; try the likely ones in order (23514 = check violation).
  let result = await client.from('applications').insert({ user_id: userId, opportunity_id: job.id, status: 'applied' }).select('id, opportunity_id, status, updated_at').single()
  for (const status of ['submitted', 'pending', 'sent']) {
    if (result.error?.code !== '23514') break
    result = await client.from('applications').insert({ user_id: userId, opportunity_id: job.id, status }).select('id, opportunity_id, status, updated_at').single()
  }
  const { data, error } = result
  // 23505 = unique violation: the user already applied, which is fine to treat as success.
  if (error && error.code !== '23505') {
    console.error('[v0] Application insert failed:', error)
    return { ok: false, message: error.message }
  }
  addApplicationToCache({ id: data?.id ?? `pending-${job.id}`, opportunity_id: job.id, status: data?.status ?? 'applied', updated_at: data?.updated_at ?? new Date().toISOString(), opportunity: job })
  return { ok: true }
}

type Identity = { signedIn: boolean; name: string; email: string; profile: CandidateProfile | null }
let identityCache: Identity | null = null
let identityLoad: Promise<Identity> | null = null
const identityListeners = new Set<(next: Identity) => void>()

async function loadIdentity(): Promise<Identity> {
  const client = getSupabaseBrowserClient()
  const { data } = await client.auth.getSession()
  const user = data.session?.user
  if (!user) { const draft = readProfileDraft(); return { signedIn: false, name: draft?.full_name || 'Guest', email: '', profile: draft } }
  const { data: row } = await client.from('profiles').select(PROFILE_COLUMNS).eq('id', user.id).maybeSingle()
  const profile = row ? ({ ...emptyProfile(), ...row } as CandidateProfile) : null
  return { signedIn: true, name: profile?.full_name || String(user.user_metadata?.full_name ?? '') || (user.email ?? '').split('@')[0], email: user.email ?? '', profile }
}

function refreshIdentity() {
  identityLoad = loadIdentity().then((next) => { identityCache = next; identityListeners.forEach((listener) => listener(next)); return next })
  return identityLoad
}

function useIdentity() {
  const [identity, setIdentity] = useState(identityCache)
  useEffect(() => {
    const listener = (next: Identity) => setIdentity(next)
    identityListeners.add(listener)
    if (!identityCache) void (identityLoad ?? refreshIdentity()).then(setIdentity)
    return () => { identityListeners.delete(listener) }
  }, [])
  return identity
}

const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).map((part) => part[0]).slice(0, 2).join('').toUpperCase() || '?'

// Cached data belongs to one account, so it is dropped whenever the session changes.
function resetSessionCaches() {
  platformCache = null; platformLoad = null; identityCache = null; identityLoad = null
}

async function signOut(go: (view: View) => void) {
  await getSupabaseBrowserClient().auth.signOut()
  resetSessionCaches()
  go('landing')
}

function usePlatformData() {
  const [data, setData] = useState(platformCache)
  const [loading, setLoading] = useState(!platformCache)

  useEffect(() => {
    let active = true
    const listener = (next: PlatformData) => { if (active) setData(next) }
    platformListeners.add(listener)
    async function load() {
      if (platformCache) return
      if (!platformLoad) {
        platformLoad = (async () => {
          const supabase = getSupabaseBrowserClient()
          const controller = new AbortController()
          const timeout = window.setTimeout(() => controller.abort(), 25000)
          await fetch('/api/opportunities/sync', { method: 'POST', signal: controller.signal }).catch(() => undefined)
          window.clearTimeout(timeout)
          const [{ rows: jobRows }, { data: sessionData }] = await Promise.all([
            fetchRecentOpportunities(supabase),
            supabase.auth.getSession(),
          ])
          const mapped = jobRows.filter(isVisibleOpportunity).map((job) => ({ id: job.id, company: job.company, role: job.role, location: job.location, mode: job.mode, salary: job.salary, posted: new Date(job.posted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), score: job.match_score ?? 0, color: '#426b5a', tags: Array.isArray(job.tags) ? job.tags.filter((tag): tag is string => typeof tag === 'string') : [], description: job.description ?? '', sourceUrl: String(job.source_url ?? ''), postedAt: job.posted_at }))
          const applications = !sessionData.session?.user ? readDemoApplications() : await supabase.from('applications').select('id, opportunity_id, status, updated_at, opportunities(*)').eq('user_id', sessionData.session.user.id).order('updated_at', { ascending: false }).then(({ data }) => (data ?? []).map((row: any) => ({ ...row, opportunity: mapped.find((job) => job.id === row.opportunity_id) })))
          platformCache = { jobs: mapped, applications, matching: { status: sessionData.session?.user ? 'loading' : 'signed-out', skills: [], gaps: [] } }
          // Listings show straight away; AI scores arrive when the matching route answers.
          if (sessionData.session?.user) void refreshMatches()
          return platformCache
        })().catch((error) => { console.error('[v0] Dashboard data load failed:', error); platformLoad = null; return emptyPlatform() })
      }
      const next = await platformLoad
      if (active) { setData(next); setLoading(false) }
    }
    void load()
    return () => { active = false; platformListeners.delete(listener) }
  }, [])

  return { jobs: data?.jobs ?? [], applications: data?.applications ?? [], matching: data?.matching ?? emptyPlatform().matching, loading }
}

const navItems = [
  { id: 'dashboard' as View, label: 'Dashboard', icon: LayoutDashboard },
  { id: 'opportunities' as View, label: 'Opportunities', icon: Target },
  { id: 'applications' as View, label: 'Applications', icon: ClipboardList },
]

function Brand({ onClick }: { onClick?: () => void }) {
  return <button onClick={onClick} className="brand" aria-label="Go to Ants.AI home"><span className="brand-mark"><span></span><span></span><span></span></span><span>ants<span className="brand-dot">.</span>ai</span></button>
}

function Button({ children, variant = 'primary', className = '', onClick, type = 'button', disabled = false }: { children: React.ReactNode; variant?: 'primary' | 'secondary' | 'ghost' | 'dark'; className?: string; onClick?: () => void; type?: 'button' | 'submit'; disabled?: boolean }) {
  return <button type={type} onClick={onClick} disabled={disabled} className={`btn btn-${variant} ${className}`}>{children}</button>
}

function SiteFooter() {
  return <footer className="site-footer"><div className="footer-heading">Human potential is needed<br/>more than ever.</div><div className="footer-grid"><div className="footer-brand"><Brand/><p>Better matches for better work.</p><div className="footer-socials"><a href="#">X</a><a href="#">in</a><a href="#">◎</a></div></div><div><span>Explore</span><a href="#features">Features</a><a href="#how">How it works</a><a href="#about">About</a></div><div><span>For talent</span><a href="#">Opportunities</a><a href="#">Career resources</a><a href="#">Refer &amp; earn</a></div><div><span>Contact</span><a href="mailto:support@ants.ai">support@ants.ai</a><a href="mailto:press@ants.ai">press@ants.ai</a></div></div><div className="footer-bottom"><span>© 2026 Ants.AI</span><div><a href="#">Privacy Policy</a><a href="#">Terms</a><a href="#">Cookie policy</a></div></div><div className="footer-wordmark">ants.ai</div></footer>
}

function Landing({ go }: { go: (view: View) => void }) {
  const [heroVideoDone, setHeroVideoDone] = useState(false)
  useEffect(() => { if (sessionStorage.getItem('ants-hero-video-played') === '1') setHeroVideoDone(true) }, [])
  const finishHeroVideo = () => { sessionStorage.setItem('ants-hero-video-played', '1'); setHeroVideoDone(true) }
  const [navScrolled, setNavScrolled] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [heroMessage, setHeroMessage] = useState(0)
  const heroMessages = ['Find work that', 'Discover roles that', 'Build a career that', 'Choose work that']

  useEffect(() => {
    const timer = window.setInterval(() => setHeroMessage((current) => (current + 1) % heroMessages.length), 5000)
    return () => window.clearInterval(timer)
  }, [heroMessages.length])

  useEffect(() => {
    const onScroll = () => setNavScrolled(window.scrollY > 28)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const closeMenu = () => setMenuOpen(false)

  return <main className={`landing-page ${heroVideoDone ? 'hero-ready' : ''}`}>
    <header className={`site-header ${navScrolled ? 'nav-scrolled' : ''} ${menuOpen ? 'menu-open' : ''}`}><Brand /><nav><a href="#how" onClick={closeMenu}>How it works</a><a href="#features" onClick={closeMenu}>Features</a><button className="nav-demo" onClick={() => { closeMenu(); go('demo') }}>Demo</button></nav><div className="header-actions"><Button variant="ghost" onClick={() => { closeMenu(); go('login') }}>Log in</Button><Button className="header-signup" onClick={() => { closeMenu(); go('signup') }}>Get started <ArrowRight size={16}/></Button></div><button className="mobile-menu" aria-label={menuOpen ? 'Close menu' : 'Open menu'} aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>{menuOpen ? <X size={21}/> : <Menu size={21}/>}</button></header>
    <section className="hero"><video className="hero-video" autoPlay muted playsInline preload="auto" onLoadedData={(event) => { void event.currentTarget.play() }} onEnded={finishHeroVideo} aria-hidden="true"><source src="/hero-intro.mp4" type="video/mp4" /></video><div className="hero-image" aria-hidden="true" /><div className="hero-shade" aria-hidden="true" /><div className="hero-content"><div className="eyebrow">Your next opportunity is closer than you think</div><h1 className="hero-heading"><span key={heroMessage} className="hero-heading-swap">{heroMessages[heroMessage]}</span><br/><em>fits you.</em></h1><p className="hero-copy">Ants.AI helps talented people discover remote opportunities, understand their fit, and apply with confidence.</p><div className="hero-actions"><Button onClick={() => go('signup')}>Start your journey <ArrowRight size={17}/></Button><button className="text-link" onClick={() => go('login')}>I already have an account <ArrowRight size={15}/></button></div></div></section>
    <div className="hero-proof"><div className="avatars"><span>J</span><span>N</span><span>+</span></div><p><strong>10,000+</strong> people finding better work<br/><span>Every week, everywhere.</span></p></div>
    <section className="org-marquee" aria-label="Remote work organizations"><div className="org-track">{['Remote','GitLab','Automattic','Zapier','Buffer','Doist','Toptal','Basecamp','37signals','DuckDuckGo','Dropbox','Shopify','Atlassian','Notion','Remote','GitLab','Automattic','Zapier','Buffer','Doist','Toptal','Basecamp','37signals','DuckDuckGo','Dropbox','Shopify','Atlassian','Notion'].map((organization, index) => <span className="org-logo" key={`${organization}-${index}`}>{organization}</span>)}</div></section><section className="stats-row"><div><strong>408</strong><span>opportunities analyzed</span></div><div><strong>320</strong><span>relevant matches</span></div><div><strong>58</strong><span>strong matches</span></div><div><strong>9</strong><span>applications started</span></div></section>
    <section className="how-section" id="how"><div className="section-intro"><span className="section-kicker">HOW IT WORKS</span><h2>A clearer path to<br/><em>better work.</em></h2><p>One profile, thoughtful matches, and a simpler way to move from searching to applying.</p></div><div className="how-grid"><article className="how-card how-card-tall"><img src="https://hebbkx1anhila5yf.public.blob.vercel-storage.com/image-E4MgQd77qBp9aI497yUHoJYsrkxse3.png" alt="Professional working from home with a laptop"/><div><span>01</span><h3>Build your profile</h3><p>Tell us what you can do, what matters to you, and where you want to grow.</p></div></article><article className="how-card"><div className="how-card-copy"><span>02</span><h3>Find your fit</h3><p>Explore real remote opportunities selected around your skills and goals.</p></div><img src="https://hebbkx1anhila5yf.public.blob.vercel-storage.com/image.png-q9nQQSvTBx0iROJz8v9uPIrJUCB6kF.jpeg" alt="Laptop and workspace representing a remote job search"/></article><article className="how-card how-card-dark"><div className="how-card-copy"><span>03</span><h3>Move with confidence</h3><p>Understand your match and apply with the profile you already built.</p></div><img src="https://hebbkx1anhila5yf.public.blob.vercel-storage.com/image-ZaDu9EAkEgA35ldNleEieNaS8sowno.png" alt="Remote team collaborating over video calls"/></article></div></section><section className="feature-strip" id="features"><div><span className="section-kicker">LESS SEARCH. MORE DIRECTION.</span><h2>Everything you need to<br/><em>move forward.</em></h2></div><p>From your first search to your final application, Ants.AI gives you the clarity and tools to move forward.</p><div className="feature-list"><div><span>01</span><strong>Discover your fit</strong><p>See real opportunities selected around your skills and goals.</p></div><div><span>02</span><strong>Apply with confidence</strong><p>Use one profile, saved materials, and clear job information.</p></div><div><span>03</span><strong>Stay focused</strong><p>Spend less time searching and more time on the right opportunities.</p></div></div></section>
    <SiteFooter />
  </main>
}

function Auth({ mode, go }: { mode: 'login' | 'signup' | 'demo'; go: (view: View) => void }) {
  const isLogin = mode === 'login'
  const isDemo = mode === 'demo'
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    const form = new FormData(event.currentTarget)
    const email = String(form.get('email') || '').trim()
    const password = String(form.get('password') || '')
    const name = String(form.get('fullName') || '').trim()
    if (!isLogin && password !== String(form.get('confirmPassword') || '')) { setSubmitting(false); setError('Passwords do not match.'); return }
    if (isDemo) { setSubmitting(false); go('dashboard'); return }
    const supabase = getSupabaseBrowserClient()
    const result = isLogin
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password, options: { emailRedirectTo: process.env.NEXT_PUBLIC_DEV_SUPABASE_REDIRECT_URL ?? `${window.location.origin}/auth/callback`, data: { full_name: name } } })
    setSubmitting(false)
    if (result.error) { setError(result.error.message); return }
    resetSessionCaches()
    go(isLogin ? 'dashboard' : 'onboarding')
  }
  async function resetPassword() {
    const email = window.prompt('Enter your account email')?.trim()
    if (!email) return
    const { error: resetError } = await getSupabaseBrowserClient().auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/reset-password` })
    setError(resetError ? resetError.message : 'Password reset email sent.')
  }
  return <main className="auth-page"><div className="auth-brand"><Brand onClick={() => go('landing')}/></div><div className="auth-layout"><div className="auth-aside"><div><span className="section-kicker">THE SMARTER WAY TO WORK</span><h1>Make your next<br/><em>move count.</em></h1><p>One profile. Better matches. A career that moves with you.</p></div><div className="aside-note"><Sparkles size={17}/><span>Personalized for everyone</span></div><div className="aside-bottom"><strong>Your next chapter starts here.</strong><span>Join thousands finding better remote work.</span></div></div><div className="auth-card"><div className="auth-heading"><span className="mini-orb"><Sparkles size={15}/></span><span>{isLogin ? 'Welcome back' : 'Create your profile'}</span><h2>{isLogin ? 'Pick up where you left off.' : 'Your next chapter starts here.'}</h2><p>{isLogin ? 'Sign in to see your latest matches.' : 'Join thousands finding better remote work.'}</p></div><form onSubmit={submit}><label>{!isLogin && 'Full name'}{!isLogin && <input name="fullName" defaultValue={isDemo ? 'Jackson Njovu' : undefined} placeholder="Your full name" required/>}</label><label>Email address<input name="email" type="email" defaultValue={isDemo ? 'jackson@example.com' : undefined} placeholder="" required/></label><label>Password<div className="password-field"><input name="password" type={showPassword ? 'text' : 'password'} defaultValue={isDemo ? 'password123' : undefined} placeholder="" minLength={6} required/><button type="button" onClick={() => setShowPassword(value => !value)}>{showPassword ? 'Hide' : 'Show'}</button></div></label>{!isLogin && <label>Confirm password<div className="password-field"><input name="confirmPassword" type={showPassword ? 'text' : 'password'} defaultValue={isDemo ? 'password123' : undefined} placeholder="Repeat your password" minLength={6} required/></div></label>}{isLogin && <div className="form-row"><label className="check-label"><input type="checkbox"/> <span>Remember me</span></label><button className="forgot" type="button">Forgot password?</button></div>}{error && <p className="auth-error" role="alert">{error}</p>}<Button type="submit" className="full-btn" disabled={submitting}>{submitting ? 'Please wait…' : isLogin ? 'Sign in' : 'Create account'} <ArrowRight size={16}/></Button></form><p className="auth-switch">{isLogin ? 'New to Ants.AI?' : 'Already have an account?'} <button onClick={() => go(isLogin ? 'signup' : 'login')}>{isLogin ? 'Create an account' : 'Sign in'}</button></p></div></div></main>
}

function Onboarding({ go }: { go: (view: View) => void }) {
  const [step, setStep] = useState(1)
  const [profile, setProfile] = useState<CandidateProfile>(emptyProfile)
  const [skillInput, setSkillInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [cvStatus, setCvStatus] = useState<'idle' | 'uploading' | 'dragging'>('idle')
  const [cvError, setCvError] = useState('')
  const steps = ['About you', 'Skills', 'Experience', 'Education', 'CV', 'Review profile']
  const update = (patch: Partial<CandidateProfile>) => setProfile((current) => ({ ...current, ...patch }))
  const addSkills = (raw: string) => { const added = raw.split(',').map((skill) => skill.trim()).filter(Boolean); if (added.length) update({ skills: Array.from(new Set([...profile.skills, ...added])) }); setSkillInput('') }
  const gaps = profileGaps(profile)
  const initials = profile.full_name.split(' ').filter(Boolean).map((part) => part[0]).slice(0, 2).join('').toUpperCase() || '?'

  useEffect(() => {
    // Edit an existing profile rather than starting blank.
    void (async () => {
      const client = getSupabaseBrowserClient()
      const { data } = await client.auth.getSession()
      const userId = data.session?.user.id
      const { data: row } = userId ? await client.from('profiles').select(PROFILE_COLUMNS).eq('id', userId).maybeSingle() : { data: null }
      const saved = row ? { ...emptyProfile(), ...Object.fromEntries(Object.entries(row).filter(([, value]) => value != null)) } : readProfileDraft()
      if (saved) setProfile(saved as CandidateProfile)
      else if (data.session?.user.user_metadata?.full_name) update({ full_name: String(data.session.user.user_metadata.full_name) })
    })()
  }, [])

  // The server reads the CV's text for matching and keeps the original file in private storage.
  async function uploadCv(file: File | undefined) {
    if (!file) return
    setCvStatus('uploading'); setCvError('')
    const form = new FormData()
    form.append('file', file)
    const response = await fetch('/api/cv', { method: 'POST', body: form }).catch(() => null)
    const body = await response?.json().catch(() => ({})) ?? {}
    setCvStatus('idle')
    if (!response?.ok) { setCvError(body.error ?? 'Upload failed. Check your connection and try again.'); return }
    update({ cv_text: body.text, cv_file_name: body.fileName })
  }

  async function removeCv() {
    update({ cv_text: '', cv_file_name: '' })
    await fetch('/api/cv', { method: 'DELETE' }).catch(() => undefined)
  }

  async function finish() {
    setSaving(true); setNotice('')
    const result = await saveProfile(profile)
    setSaving(false)
    if (result.saved) go('opportunities')
    else setNotice(result.message)
  }

  return <main className="onboarding-page"><header className="onboarding-header"><Brand onClick={() => go('landing')}/><span>Profile setup · {step} of 6</span><button onClick={() => go('dashboard')}>Skip for now</button></header><div className="onboarding-body"><aside className="steps"><span className="section-kicker">LET&apos;S GET TO KNOW YOU</span><h1>A profile that<br/><em>works for you.</em></h1><p>Our AI compares your profile with every live opportunity, so the more you share, the better your matches.</p><div className="step-list">{steps.map((item, index) => <div className={`step-item ${index + 1 === step ? 'active' : ''} ${index + 1 < step ? 'done' : ''}`} key={item}><span>{index + 1 < step ? <Check size={13}/> : index + 1}</span>{item}</div>)}</div></aside><section className="onboarding-card"><div className="progress"><span style={{ width: `${(step / 6) * 100}%` }}></span></div>
    {step === 1 && <><div className="onboarding-title"><span className="mini-orb"><UserRound size={15}/></span><span>Step 01 · About you</span><h2>Let&apos;s start with the basics.</h2><p>Tell us a little about who you are and what you&apos;re looking for.</p></div><div className="form-grid"><label>Full name<input value={profile.full_name} onChange={(event) => update({ full_name: event.target.value })} placeholder="Your full name"/></label><label>Location<input value={profile.location} onChange={(event) => update({ location: event.target.value })} placeholder="e.g. Lusaka, Zambia"/></label><label>Current or target role<input value={profile.role_title} onChange={(event) => update({ role_title: event.target.value })} placeholder="e.g. Frontend Developer"/></label><label>Years of experience<input type="number" min={0} max={50} value={profile.years_experience ?? ''} onChange={(event) => update({ years_experience: event.target.value === '' ? null : Number(event.target.value) })} placeholder="e.g. 3"/></label></div><label>What are you looking for?<textarea value={profile.looking_for} onChange={(event) => update({ looking_for: event.target.value })} placeholder="The kind of remote work you want, e.g. part-time React contracts with a product team."/></label></>}
    {step === 2 && <><div className="onboarding-title"><span className="mini-orb"><Zap size={15}/></span><span>Step 02 · Skills</span><h2>Show us what you do best.</h2><p>Add at least 3 skills. Press Enter or use commas between skills.</p></div><label>Add skills<div className="skill-add"><input value={skillInput} onChange={(event) => setSkillInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addSkills(skillInput) } }} placeholder="e.g. React, Copywriting, Data entry"/><button type="button" onClick={() => addSkills(skillInput)}>Add</button></div></label><div className="skill-cloud">{profile.skills.length === 0 ? <small className="skill-empty">No skills added yet.</small> : profile.skills.map((skill) => <span key={skill}>{skill}<button type="button" aria-label={`Remove ${skill}`} onClick={() => update({ skills: profile.skills.filter((item) => item !== skill) })}><X size={13}/></button></span>)}</div></>}
    {step === 3 && <><div className="onboarding-title"><span className="mini-orb"><BriefcaseBusiness size={15}/></span><span>Step 03 · Experience</span><h2>Tell us about your experience.</h2><p>Recent roles, projects and what you achieved. Plain sentences work best.</p></div><label>Work experience<textarea rows={7} value={profile.experience} onChange={(event) => update({ experience: event.target.value })} placeholder="e.g. Freelance web developer since 2023: built e-commerce sites for 6 Lusaka businesses using React and Supabase."/></label></>}
    {step === 4 && <><div className="onboarding-title"><span className="mini-orb"><GraduationCap size={15}/></span><span>Step 04 · Education</span><h2>Where did you learn your craft?</h2><p>Degrees, courses and certifications.</p></div><label>Education and certifications<textarea rows={5} value={profile.education} onChange={(event) => update({ education: event.target.value })} placeholder="e.g. BSc Computer Science, Cavendish University Zambia (2026)"/></label></>}
    {step === 5 && <><div className="onboarding-title"><span className="mini-orb"><FileText size={15}/></span><span>Step 05 · CV (optional)</span><h2>Bring your story with you.</h2><p>Upload your CV and our AI will read it to improve your matches.</p></div>{profile.cv_file_name || profile.cv_text ? <div className="cv-file"><FileText size={22}/><span><strong>{profile.cv_file_name || 'Your CV'}</strong><small>{profile.cv_text.split(/\s+/).filter(Boolean).length} words read by our AI</small></span><label className="cv-replace">Replace<input type="file" accept=".pdf,.docx,.txt" onChange={(event) => void uploadCv(event.target.files?.[0])}/></label><button type="button" onClick={() => void removeCv()} aria-label="Remove CV"><X size={16}/></button></div> : <label className={`cv-drop ${cvStatus === 'dragging' ? 'dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setCvStatus('dragging') }} onDragLeave={() => setCvStatus('idle')} onDrop={(event) => { event.preventDefault(); void uploadCv(event.dataTransfer.files[0]) }}>{cvStatus === 'uploading' ? <><span className="loading-spinner"/><strong>Reading your CV…</strong></> : <><Upload size={26}/><strong>Drop your CV here, or <u>browse</u></strong><span>PDF, Word (.docx) or text file, up to 5 MB</span></>}<input type="file" accept=".pdf,.docx,.txt" disabled={cvStatus === 'uploading'} onChange={(event) => void uploadCv(event.target.files?.[0])}/></label>}{cvError && <p className="profile-warning" role="alert">{cvError}</p>}</>}
    {step === 6 && <><div className="onboarding-title"><span className="mini-orb"><Check size={15}/></span><span>Step 06 · Review profile</span><h2>You&apos;re ready to discover.</h2><p>This is what our AI will match against live opportunities.</p></div><div className="review-profile"><div className="profile-avatar">{initials}</div><div><h3>{profile.full_name || 'Your name'}</h3><p>{profile.role_title || 'Role not set'}{profile.years_experience != null ? ` · ${profile.years_experience} years` : ''}</p><span>{profile.location || 'Location not set'} · Open to remote</span></div><button onClick={() => setStep(1)}><Settings size={16}/> Edit</button></div><div className="review-tags">{profile.skills.map((skill) => <span key={skill}>{skill}</span>)}</div>{gaps.length > 0 && <p className="profile-warning" role="status">You&apos;ll get AI matches now. Add {gaps.join(', ')} to make them more accurate.</p>}{notice && <p className="profile-warning" role="alert">{notice}</p>}</>}
    <div className="onboarding-footer"><button className="back-link" onClick={() => step > 1 ? setStep(step - 1) : go('dashboard')}>{step > 1 ? '← Back' : '← Dashboard'}</button><Button onClick={() => step < 6 ? setStep(step + 1) : void finish()}>{step < 6 ? 'Continue' : saving ? 'Saving…' : 'Save and find my matches'} <ArrowRight size={16}/></Button></div></section></div></main>
}

function AppShell({ view, go, children }: { view: View; go: (view: View) => void; children: React.ReactNode }) { const { jobs } = usePlatformData(); const identity = useIdentity(); const name = identity?.name ?? ''; const initials = identity ? initialsOf(identity.name) : ''; const [searchOpen, setSearchOpen] = useState(false); const [notificationsOpen, setNotificationsOpen] = useState(false); return <div className="app-shell"><aside className="sidebar"><Brand onClick={() => go('dashboard')}/><div className="sidebar-label">Workspace</div><nav>{navItems.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? 'active' : ''} onClick={() => go(id)}><Icon size={18}/>{label}</button>)}<button onClick={() => go('assistant')}><Sparkles size={18}/>AI assistant<span className="new-tag">New</span></button></nav><div className="sidebar-bottom"><button><Settings size={18}/>Settings</button><button className="logout-button" onClick={() => void signOut(go)}><LogOut size={18}/>Log out</button><button className="user-mini" onClick={() => go('onboarding')}><span className="avatar small">{initials}</span><span><strong>{name}</strong><small>{identity?.signedIn === false ? 'Not signed in' : 'View profile'}</small></span><ChevronDown size={15}/></button></div></aside><div className="mobile-top"><Brand onClick={() => go('dashboard')}/><button><Menu size={20}/></button></div><div className="app-content"><header className="app-header"><div className="breadcrumbs"><span>Workspace</span><span>/</span><strong>{view === 'dashboard' ? 'Dashboard' : view === 'assistant' ? 'AI application assistant' : view[0].toUpperCase() + view.slice(1)}</strong></div><div className="app-header-actions"><div className="header-control"><button className="icon-btn" aria-label="Search opportunities" aria-expanded={searchOpen} onClick={() => setSearchOpen(value => !value)}><Search size={18}/></button>{searchOpen && <input className="header-search" autoFocus placeholder="Search opportunities" onChange={event => { const query = event.target.value.toLowerCase(); if (query) { const match = jobs.find(job => `${job.company} ${job.role}`.toLowerCase().includes(query)); if (match) go('opportunities') } }} />}</div><div className="header-control"><button className="icon-btn notification" aria-label="View notifications" aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen(value => !value)}><Bell size={18}/><i></i></button>{notificationsOpen && <div className="notification-popover"><strong>You&apos;re all caught up</strong><span>New matches and application updates will appear here.</span></div>}</div><span className="avatar" title={name}>{initials}</span></div></header>{children}</div></div> }

function Dashboard({ go }: { go: (view: View, job?: Opportunity) => void }) { const { jobs, applications, loading } = usePlatformData(); const identity = useIdentity(); const firstName = identity?.signedIn ? identity.name.split(' ')[0] : ''; const completeness = profileCompleteness(identity?.profile ?? null); const catHour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'Africa/Harare' }).format(new Date())); const greeting = catHour < 12 ? 'Good morning' : catHour < 18 ? 'Good afternoon' : 'Good evening'; const message = catHour < 12 ? 'Start with one focused move and let the right opportunities come to you.' : catHour < 18 ? 'You still have time to make one meaningful move for your next opportunity.' : 'A thoughtful review tonight can make tomorrow’s search much sharper.'; return <AppShell view="dashboard" go={go}><main className="dashboard"><div className="page-heading"><div><span className="section-kicker">YOUR WORKSPACE</span><h1>{greeting}{firstName ? `, ${firstName}` : ''}<span className="heading-dot">.</span></h1><p>{message}</p></div><Button onClick={() => go('opportunities')}><Search size={16}/> Explore opportunities</Button></div><div className="dashboard-grid"><section className="panel matches-panel"><div className="panel-heading"><div><h2>Top matches for you</h2><p>Roles that line up with your profile</p></div><button onClick={() => go('opportunities')} className="view-all">View all <ArrowRight size={15}/></button></div><div className="match-list">{[...jobs].sort((a, b) => b.score - a.score).slice(0, 4).map(job => <OpportunityRow key={job.id} job={job} onClick={() => go('assistant', job)}/>)}</div></section><section className="panel activity-panel"><div className="panel-heading"><div><h2>Recent applications</h2><p>Keep your momentum going</p></div><button onClick={() => go('applications')} className="view-all">View all <ArrowRight size={15}/></button></div><div className="activity-list">{applications.length === 0 ? <p className="empty-state">No applications yet.</p> : applications.slice(0, 4).map(application => <Activity key={application.id} company={application.opportunity?.company ?? 'Opportunity'} role={application.opportunity?.role ?? 'Application'} status={application.status} tone={application.status} time={new Date(application.updated_at).toLocaleDateString()}/>)}</div><button className="progress-card" onClick={() => go('onboarding')}><div className="progress-card-top"><span>Profile completeness</span><strong>{completeness.percent}%</strong></div><div className="bar"><span style={{ width: `${completeness.percent}%` }}></span></div><p>{completeness.next ? `Add ${completeness.next} to improve your matches` : 'Your profile is complete'}</p></button></section></div></main></AppShell> }

function Metric({ icon, label, value, detail, color }: { icon: React.ReactNode; label: string; value: string; detail: string; color: string }) { return <div className="metric-card"><span className={`metric-icon ${color}`}>{icon}</span><span className="metric-label">{label}</span><strong>{value}</strong><span className="metric-detail">{detail}</span></div> }
function OpportunityRow({ job, onClick }: { job: Opportunity; onClick: () => void }) { return <button className="opportunity-row" onClick={onClick}><span className="company-icon" style={{ backgroundColor: job.color }}>{job.company[0]}</span><span className="opp-info"><strong>{job.role}</strong><span>{job.company} · {remoteLabel(job.location)}</span></span><span className="fit-score"><strong>{job.score ? `${job.score}%` : '—'}</strong><span>match</span></span><ArrowRight size={17}/></button> }
function Activity({ company, role, status, tone, time }: { company: string; role: string; status: string; tone: string; time: string }) { return <div className="activity-row"><span className="company-icon neutral">{company[0]}</span><span className="activity-info"><strong>{role}</strong><span>{company}</span></span><span className={`status ${tone}`}>{status}</span><small>{time}</small></div> }

function Opportunities({ go }: { go: (view: View, job?: Opportunity) => void }) { const [filter, setFilter] = useState('All opportunities'); const [query, setQuery] = useState(''); const [page, setPage] = useState(1); const [sort, setSort] = useState<'newest' | 'match'>('newest'); const { jobs, loading, matching } = usePlatformData(); const visibleJobs = [...jobs].filter(job => { const text = `${job.role} ${job.company} ${job.location} ${job.tags.join(' ')}`.toLowerCase(); return text.includes(query.toLowerCase()) && (filter === 'All opportunities' || (filter === 'Strong matches' ? job.score >= STRONG_MATCH_SCORE : job.mode === filter)) }).sort((a, b) => sort === 'match' && b.score !== a.score ? b.score - a.score : new Date(b.postedAt ?? 0).getTime() - new Date(a.postedAt ?? 0).getTime()) ; const pageSize = 10; const pageCount = Math.max(1, Math.ceil(visibleJobs.length / pageSize)); const currentPage = Math.min(page, pageCount); const pageStart = Math.floor((currentPage - 1) / 10) * 10 + 1; const pageEnd = Math.min(pageStart + 9, pageCount); const pageNumbers = Array.from({ length: pageEnd - pageStart + 1 }, (_, index) => pageStart + index); const pageJobs = visibleJobs.slice((currentPage - 1) * pageSize, currentPage * pageSize); const setPageAndScroll = (next: number) => { const safePage = Math.max(1, Math.min(next, pageCount)); setPage(safePage); window.scrollTo({ top: 0, behavior: 'smooth' }) }; return <AppShell view="opportunities" go={go}><main className="dashboard opportunities-page"><div className="page-heading compact"><div><span className="section-kicker">DISCOVER YOUR NEXT MOVE</span><h1>Opportunities<span className="heading-dot">.</span></h1><p>Real roles from Himalayas, Remotive, and Jobicy, refreshed as you browse.</p></div><Button variant="secondary"><Settings size={16}/> Preferences</Button></div><div className="opportunity-toolbar"><div className="search-field"><Search size={17}/><input value={query} onChange={event => { setQuery(event.target.value); setPage(1) }} placeholder="Search roles, skills, or companies" aria-label="Search opportunities"/></div><select value={filter} onChange={event => { setFilter(event.target.value); setPage(1) }}><option>All opportunities</option><option>Strong matches</option><option>Full-time</option><option>Contract</option></select><button className="filter-btn">Live <span>{visibleJobs.length}</span></button></div><MatchBanner matching={matching} go={go}/><div className="results-meta"><strong>{loading ? 'Loading listings…' : `${visibleJobs.length} `}</strong><span></span><button onClick={() => { setSort(sort === 'newest' ? 'match' : 'newest'); setPage(1) }} disabled={matching.status !== 'ready'} title={matching.status === 'ready' ? 'Switch sort order' : 'Available once your AI matches are ready'}>{sort === 'newest' ? 'Newest' : 'Best match'} <ChevronDown size={15}/></button></div><div className="opportunities-grid">{loading ? <div className="listing-state" role="status"><span className="loading-spinner"/>Loading live opportunities…</div> : visibleJobs.length === 0 ? <div className="listing-state">No opportunities are available right now. Check your connection and try again.</div> : pageJobs.map(job => <OpportunityCard key={job.id} job={job} go={go}/>)}</div><nav className="pagination" aria-label="Opportunities pages"><button disabled={currentPage === 1} onClick={() => setPageAndScroll(currentPage - 1)} aria-label="Previous page">Previous</button>{pageNumbers.map(number => <button key={number} className={currentPage === number ? 'active' : ''} onClick={() => setPageAndScroll(number)} aria-current={currentPage === number ? 'page' : undefined}>{number}</button>)}<button disabled={currentPage === pageCount} onClick={() => setPageAndScroll(currentPage + 1)}>Next</button></nav></main></AppShell> }
function OpportunityCard({ job, go }: { job: Opportunity; go: (view: View, job?: Opportunity) => void }) { const tags = job.tags.slice(0, 3); return <article className="opportunity-card" tabIndex={0} onClick={() => go('assistant', job)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); go('assistant', job) } }}><div className="card-date">{job.posted}{isPostedToday(job.postedAt) && <span className="new-badge">New</span>}{job.score > 0 && <span className={`card-score ${job.score >= STRONG_MATCH_SCORE ? 'strong' : ''}`}>{job.score}% match</span>}</div><h3>{job.role}</h3><div className="card-location"><MapPin size={13}/>{remoteLabel(job.location)}</div><div className="skills-label">Required skills</div><div className="job-tags">{tags.length === 0 && <small className="no-skills">Not listed in the posting</small>}{tags.map(tag => <span key={tag}>{tag}</span>)}{job.tags.length > 3 && <span>{job.tags.length - 3}+ </span>}</div><div className="card-bottom"><span className="salary">Pay: {job.salary || 'Not listed'}</span><button className="card-arrow" onClick={() => go('assistant')} aria-label={`View ${job.role}`}><ArrowRight size={24}/></button></div></article> }

function MatchBanner({ matching, go }: { matching: Matching; go: (view: View) => void }) {
  if (matching.status === 'ready' && matching.gaps.length) return <div className="match-banner match-tip" role="status"><Sparkles size={16}/><span>Your AI matches are ready. Add {matching.gaps.join(', ')} to make them more accurate.</span><button onClick={() => go('onboarding')}>Improve matches <ArrowRight size={14}/></button></div>
  if (matching.status === 'ready') return null
  const text = matching.status === 'loading' ? 'Calculating your AI matches…' : matching.status === 'needs-profile' ? `Add a skill or your role to your profile to get AI match scores.` : matching.status === 'signed-out' ? 'Log in to see how well each role matches your skills.' : 'AI matching is unavailable right now. Listings are still up to date.'
  return <div className="match-banner" role="status">{matching.status === 'loading' ? <span className="loading-spinner"/> : <Sparkles size={16}/>}<span>{text}</span>{matching.status === 'needs-profile' && <button onClick={() => go('onboarding')}>Complete profile <ArrowRight size={14}/></button>}</div>
}

function MatchReason({ job, matching }: { job: Opportunity; matching: Matching }) {
  if (matching.status !== 'ready' || !job.score) return null
  const { matched, missing } = explainMatch(matching.skills, job)
  return <section className="summary-section match-reason"><h2>Why this matches you</h2><p>Our AI compared your profile with the full job description and rates the fit at <strong>{job.score}%</strong>.</p>{matched.length > 0 ? <><h3>Your skills this role asks for</h3><div className="detail-tags">{matched.map(skill => <span key={skill}>{skill}</span>)}</div></> : <p>None of your listed skills appear word for word; the score comes from the overall meaning of your profile and experience.</p>}{missing.length > 0 && <><h3>Skills to highlight or learn</h3><div className="detail-tags muted-tags">{missing.map(skill => <span key={skill}>{skill}</span>)}</div></>}</section>
}

function Applications({ go }: { go: (view: View, job?: Opportunity) => void }) {
  const [tab, setTab] = useState('All')
  const { applications, loading } = usePlatformData()
  const statusLabel = (status: string) => status === 'draft' ? 'Draft' : status === 'reviewing' ? 'Reviewing' : 'Applied'
  const counts: Record<string, number> = { All: applications.length, Drafts: applications.filter((item) => statusLabel(item.status) === 'Draft').length, Applied: applications.filter((item) => statusLabel(item.status) !== 'Draft').length }
  const visible = applications.filter((item) => tab === 'All' || (tab === 'Drafts' ? statusLabel(item.status) === 'Draft' : statusLabel(item.status) !== 'Draft'))
  const updatedLabel = (value: string) => { const days = Math.floor((Date.now() - new Date(value).getTime()) / 86400000); return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days} days ago` }
  return <AppShell view="applications" go={go}><main className="dashboard applications-page"><div className="page-heading compact"><div><span className="section-kicker">KEEP MOVING FORWARD</span><h1>Applications<span className="heading-dot">.</span></h1><p>Everything you&apos;ve started, saved, and sent.</p></div><Button onClick={() => go('opportunities')}><Plus size={16}/> Find a new role</Button></div><div className="application-tabs">{['All','Drafts','Applied'].map(item => <button className={tab === item ? 'active' : ''} onClick={() => setTab(item)} key={item}>{item}<span>{counts[item]}</span></button>)}</div><div className="applications-table"><div className="table-head"><span>Opportunity</span><span>Match</span><span>Status</span><span>Last updated</span><span></span></div>{loading ? <div className="listing-state"><span className="loading-spinner"/>Loading applications…</div> : visible.length === 0 ? <div className="listing-state">{tab === 'All' ? 'No applications yet. Apply to a role and it will show up here.' : `No ${tab.toLowerCase()} applications.`}</div> : visible.map((application) => { const job = application.opportunity; const label = statusLabel(application.status); return <div className="table-row" key={application.id}><div className="table-opportunity"><span className="company-icon" style={{ backgroundColor: job?.color ?? '#426b5a' }}>{(job?.company ?? '?')[0]}</span><span><strong>{job?.role ?? 'Opportunity no longer listed'}</strong><small>{job ? `${job.company} · ${remoteLabel(job.location)}` : 'This listing has been removed'}</small></span></div><span className="table-score">{job?.score ? `${job.score}%` : '—'}</span><span className={`status ${label.toLowerCase()}`}>{label}</span><span className="updated">{updatedLabel(application.updated_at)}</span><button className="row-menu" aria-label="Open opportunity" disabled={!job} onClick={() => job && go('assistant', job)}><ArrowRight size={18}/></button></div> })}</div></main></AppShell>
}

function Assistant({ go, job }: { go: (view: View, job?: Opportunity) => void; job?: Opportunity }) {
  const [applyState, setApplyState] = useState<'idle' | 'submitting' | 'submitted' | 'error'>('idle');
  const [applyError, setApplyError] = useState('');
  const { applications, matching } = usePlatformData();
  const alreadyApplied = !!job && applications.some((application) => application.opportunity_id === job.id);
  if (!job) return <AppShell view="assistant" go={go}><main className="dashboard assistant-page"><div className="empty-state"><h1>Opportunity unavailable</h1><p>Select a live opportunity to view its details.</p><button onClick={() => go('opportunities')}>Back to opportunities</button></div></main></AppShell>;
  const selected = job;
  const { intro, sections } = parseJobDescription(selected.description);
  // Postings stored before structure was kept arrive as one long line; split those into readable paragraphs.
  const paragraphs = intro.flatMap((line) => line.length < 400 ? [line] : line.split(/(?<=[.!?])\s+(?=[A-Z])/).reduce<string[]>((groups, sentence, index) => { if (index % 3 === 0) groups.push(sentence); else groups[groups.length - 1] += ` ${sentence}`; return groups }, []));
  const location = remoteLabel(selected.location);
  return <AppShell view="assistant" go={go}><main className="dashboard assistant-page"><div className="assistant-back"><button className="back-link" onClick={() => go('opportunities')}><ArrowLeft size={15}/> Back to opportunities</button></div><div className="assistant-layout"><section className="job-summary job-detail"><header className="jd-header"><div className="jd-title"><h1>{selected.role}</h1><p className="jd-company">{selected.company}</p><ul className="jd-facts"><li><MapPin size={15}/>{location}</li><li><BriefcaseBusiness size={15}/>{selected.mode || 'Job type not stated'}</li><li><Wallet size={15}/>{selected.salary && selected.salary !== 'Not listed' ? selected.salary : 'Pay not listed'}</li><li><CalendarDays size={15}/>Posted {selected.posted}</li></ul>{selected.tags.length > 0 && <div className="jd-tags">{selected.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}</div><div className="jd-score"><strong>{selected.score ? `${selected.score}%` : '—'}</strong><small>{selected.score ? 'match' : 'no score yet'}</small></div></header><MatchReason job={selected} matching={matching}/><section className="jd-section"><h2>About the opportunity</h2>{paragraphs.length ? paragraphs.map((paragraph, index) => paragraph.split(/\s+/).length <= 4 && !/[.!?]$/.test(paragraph) ? <h3 key={index}>{paragraph}</h3> : <p key={index}>{paragraph}</p>) : <p>{sections.length ? `${selected.company} is hiring a ${selected.role}. The details are below.` : 'The employer did not include a description. See the original posting for full details.'}</p>}</section>{sections.map((section, index) => <section className="jd-section" key={`${section.title}-${index}`}><h2>{section.title}</h2><ul className={`jd-list ${section.items.length > 8 ? 'two-column' : ''}`}>{section.items.map((item, itemIndex) => { const subheading = subheadingOf(item); return subheading ? <li className="jd-subhead" key={itemIndex}>{subheading}</li> : <li key={itemIndex}><Check size={15}/><span>{item}</span></li> })}</ul></section>)}{selected.sourceUrl && <div className="jd-source"><a className="source-link" href={selected.sourceUrl} target="_blank" rel="noreferrer">Read the full posting on the employer&apos;s site <ArrowRight size={14}/></a></div>}</section><aside className="application-panel"><div className="application-panel-heading"><div><span className="application-icon"><FileText size={17}/></span><h2>Apply to this role</h2></div><span className="free-apply">Free to apply</span></div><p>Apply on the employer&apos;s site, then mark it here to track it in your Applications.</p>{selected.sourceUrl && <a className="apply-original" href={selected.sourceUrl} target="_blank" rel="noreferrer">Open the original posting <ArrowRight size={14}/></a>}<div className="application-job-summary"><strong>{selected.role}</strong><span>{selected.company} · {location}</span></div><button className="submit-application" type="button" disabled={applyState === 'submitting' || applyState === 'submitted' || alreadyApplied} onClick={async () => { setApplyState('submitting'); setApplyError(''); const result = await submitApplication(selected); if (result.ok) { setApplyState('submitted') } else { setApplyError(result.message); setApplyState('error') } }}>{applyState === 'submitted' || alreadyApplied ? <><Check size={16}/> Applied</> : applyState === 'submitting' ? 'Saving…' : 'Mark as applied'}</button>{applyState === 'submitted' && <div className="apply-feedback apply-success" role="status"><strong>Added to your applications</strong><span>Track its progress from the Applications page.</span><button type="button" onClick={() => go('applications')}>View applications <ArrowRight size={14}/></button></div>}{applyState !== 'submitted' && alreadyApplied && <p className="apply-feedback">You&apos;ve already applied to this role.</p>}{applyState === 'error' && <p className="apply-feedback apply-error" role="alert">Unable to apply right now{applyError ? `: ${applyError}` : '.'} Please try again.</p>}</aside></div></main></AppShell>
}


export default function AntsApp() { const [view, setView] = useState<View>('landing'); const [selectedJob, setSelectedJob] = useState<Opportunity>(); const go = (next: View, job?: Opportunity) => { if (job) setSelectedJob(job); setView(next) }; if (view === 'landing') return <Landing go={go}/>; if (view === 'login' || view === 'signup' || view === 'demo') return <Auth mode={view} go={go}/>; if (view === 'onboarding') return <Onboarding go={go}/>; if (view === 'dashboard') return <Dashboard go={go}/>; if (view === 'opportunities') return <Opportunities go={go}/>; if (view === 'applications') return <Applications go={go}/>; return <Assistant go={go} job={selectedJob}/> }

export { AntsApp }
