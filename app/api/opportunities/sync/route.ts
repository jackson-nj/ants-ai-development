import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const HIMALAYAS_URL = 'https://himalayas.app/jobs/api?limit=100'
const REMOTIVE_URL = 'https://remotive.com/api/remote-jobs?limit=100'
const JOBICY_URL = 'https://jobicy.com/api/v2/remote-jobs?count=100'
const ARBEITNOW_URL = 'https://arbeitnow.com/api/job-board-api'

export const maxDuration = 30

async function fetchJson(url: string) {
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'ants-ai-opportunity-sync/1.0' }, cache: 'no-store', signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`${url} returned ${response.status}`)
  return response.json()
}

export async function POST() {
  const supabase = createClient(
    process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )

  const [himalayasResult, remotiveResult, jobicyResult, arbeitnowResult] = await Promise.allSettled([fetchJson(HIMALAYAS_URL), fetchJson(REMOTIVE_URL), fetchJson(JOBICY_URL), fetchJson(ARBEITNOW_URL)])
  const himalayas = himalayasResult.status === 'fulfilled' ? (himalayasResult.value as { jobs?: Array<Record<string, unknown>> }).jobs ?? [] : []
  const remotive = remotiveResult.status === 'fulfilled' ? (remotiveResult.value as { jobs?: Array<Record<string, unknown>> }).jobs ?? [] : []
  const jobicy = jobicyResult.status === 'fulfilled' ? (jobicyResult.value as { jobs?: Array<Record<string, unknown>> }).jobs ?? [] : []
  const arbeitnow = arbeitnowResult.status === 'fulfilled' ? (arbeitnowResult.value as { data?: Array<Record<string, unknown>> }).data ?? [] : []
  const normalize = (job: Record<string, unknown>, source: string) => ({
    source,
    source_id: String(job.id ?? job.slug ?? job.url),
    source_url: String(job.url ?? job.href ?? ''),
    company: String(job.company_name ?? job.companyName ?? job.company ?? 'Unknown company'),
    role: String(job.title ?? job.jobTitle ?? 'Untitled role'),
    location: String(job.candidate_required_location ?? job.jobGeo ?? (Array.isArray(job.locationRestrictions) ? job.locationRestrictions.join(', ') : job.location) ?? 'Remote'),
    mode: String(job.job_type ?? (Array.isArray(job.jobType) ? job.jobType.join(', ') : job.jobType) ?? job.type ?? 'Full-time'),
    salary: String(job.salary ?? (job.minSalary && job.maxSalary ? `${job.currency ?? ''} ${job.minSalary}-${job.maxSalary}/${job.salaryPeriod ?? 'year'}` : 'Not listed')),
    description: String(job.description ?? job.jobDescription ?? job.jobExcerpt ?? job.excerpt ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000),
    tags: Array.isArray(job.tags) ? job.tags.map(String).slice(0, 10) : Array.isArray(job.tags_and_skills) ? job.tags_and_skills.map(String).slice(0, 10) : [],
    match_score: 0,
    posted_at: (() => { const parsed = new Date(String(job.publication_date ?? job.created_at ?? '')); return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString() })(),
  })
  const rawJobs = [...himalayas.map((job) => normalize(job, 'himalayas')), ...remotive.map((job) => normalize(job, 'remotive')), ...jobicy.map((job) => normalize(job, 'jobicy')), ...arbeitnow.map((job) => normalize(job, 'arbeitnow'))]
  const remoteJobs = rawJobs.filter((job) => /(^|[,(\s-])remote($|[),\s-])|worldwide|work from home|distributed|anywhere/i.test(job.location) && !/on-site|onsite|in office|hybrid/i.test(`${job.location} ${job.description}`))
  const jobs = Array.from(new Map(remoteJobs.map((job) => [`${job.source}:${job.source_id}`, job])).values())
  if (jobs.length === 0) return NextResponse.json({ error: 'Job providers returned no listings' }, { status: 502 })

  const { error } = await supabase.from('opportunities').upsert(jobs, { onConflict: 'source,source_id' })
  if (error) {
    console.error('[v0] Opportunity sync database error:', error.message)
    return NextResponse.json({ error: 'Unable to save live opportunities', detail: error.message }, { status: 500 })
  }
  return NextResponse.json({ synced: jobs.length, providers: { himalayas: himalayas.length, remotive: remotive.length, jobicy: jobicy.length, arbeitnow: arbeitnow.length } })
}
