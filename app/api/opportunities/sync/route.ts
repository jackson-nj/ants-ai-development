import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const REMOTIVE_URL = 'https://remotive.com/api/remote-jobs?limit=100'

export async function POST() {
  const supabase = createClient(
    process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )

  const response = await fetch(REMOTIVE_URL, {
    headers: { Accept: 'application/json', 'User-Agent': 'ants-ai-opportunity-sync/1.0' },
    next: { revalidate: 900 },
  })
  if (!response.ok) return NextResponse.json({ error: 'Remotive request failed' }, { status: 502 })

  const payload = await response.json() as { jobs?: Array<Record<string, unknown>> }
  const jobs = (payload.jobs ?? []).map((job) => ({
    source: 'remotive',
    source_id: String(job.id),
    source_url: String(job.url ?? ''),
    company: String(job.company_name ?? 'Unknown company'),
    role: String(job.title ?? 'Untitled role'),
    location: String(job.candidate_required_location ?? 'Remote'),
    mode: String(job.job_type ?? 'Full-time'),
    salary: String(job.salary ?? 'Not listed'),
    description: String(job.description ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000),
    tags: Array.isArray(job.tags) ? job.tags.map(String).slice(0, 10) : [],
    match_score: 0,
    posted_at: job.publication_date ? new Date(String(job.publication_date)).toISOString() : new Date().toISOString(),
  }))

  const { error } = await supabase.from('opportunities').upsert(jobs, { onConflict: 'source,source_id' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ synced: jobs.length })
}
