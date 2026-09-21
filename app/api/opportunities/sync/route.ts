import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const REMOTIVE_URL = 'https://remotive.com/api/remote-jobs?limit=100'
const ARBEITNOW_URL = 'https://www.arbeitnow.com/api/job-board-api'

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

  const [remotiveResult, arbeitnowResult] = await Promise.allSettled([fetchJson(REMOTIVE_URL), fetchJson(ARBEITNOW_URL)])
  const remotive = remotiveResult.status === 'fulfilled' ? (remotiveResult.value as { jobs?: Array<Record<string, unknown>> }).jobs ?? [] : []
  const arbeitnow = arbeitnowResult.status === 'fulfilled' ? (arbeitnowResult.value as { data?: Array<Record<string, unknown>> }).data ?? [] : []
  const normalize = (job: Record<string, unknown>, source: string) => ({
    source,
    source_id: String(job.id ?? job.slug ?? job.url),
    source_url: String(job.url ?? job.href ?? ''),
    company: String(job.company_name ?? job.company ?? 'Unknown company'),
    role: String(job.title ?? 'Untitled role'),
    location: String(job.candidate_required_location ?? job.location ?? 'Remote'),
    mode: String(job.job_type ?? job.type ?? 'Full-time'),
    salary: String(job.salary ?? 'Not listed'),
    description: String(job.description ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000),
    tags: Array.isArray(job.tags) ? job.tags.map(String).slice(0, 10) : Array.isArray(job.tags_and_skills) ? job.tags_and_skills.map(String).slice(0, 10) : [],
    match_score: 0,
    posted_at: (() => { const parsed = new Date(String(job.publication_date ?? job.created_at ?? '')); return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString() })(),
  })
  const jobs = [...remotive.map((job) => normalize(job, 'remotive')), ...arbeitnow.map((job) => normalize(job, 'arbeitnow'))]
  if (jobs.length === 0) return NextResponse.json({ error: 'Job providers returned no listings' }, { status: 502 })

  const { error } = await supabase.from('opportunities').upsert(jobs, { onConflict: 'source,source_id' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ synced: jobs.length })
}
