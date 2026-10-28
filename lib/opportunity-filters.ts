import type { SupabaseClient } from '@supabase/supabase-js'

// Listings older than this are hidden in the app and purged from the database by the sync route.
export const OPPORTUNITY_MAX_AGE_MONTHS = 2
export const opportunityCutoff = () => { const date = new Date(); date.setMonth(date.getMonth() - OPPORTUNITY_MAX_AGE_MONTHS); return date }

export function isEnglishOpportunity(job: Record<string, unknown>) {
  const text = [job.title, job.company, job.location, job.description, job.jobDescription].filter(Boolean).join(' ')
  return !/[Ѐ-ӿ֐-׿؀-ۿऀ-ॿ฀-๿぀-ヿ㄰-㆏一-鿿]/u.test(text)
}

export function isRemoteOpportunity(job: Record<string, unknown>) {
  const source = String(job.source ?? '').toLowerCase()
  const location = String(job.location ?? '')
  const remoteOnlyProvider = ['himalayas', 'remotive', 'jobicy'].includes(source)
  return !/on-site|onsite|in office|hybrid/i.test(location) && (remoteOnlyProvider || /(^|[,((\s-])remote($|[),\s-])|worldwide|work from home|anywhere/i.test(location))
}

export const isVisibleOpportunity = (job: Record<string, unknown>) => isEnglishOpportunity(job) && isRemoteOpportunity(job)

// Supabase caps each response at 1000 rows, so page through every listing inside the age window.
export async function fetchRecentOpportunities(supabase: SupabaseClient, columns = '*') {
  const pageSize = 1000
  const rows: Record<string, any>[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase.from('opportunities').select(columns).gte('posted_at', opportunityCutoff().toISOString()).order('posted_at', { ascending: false }).range(from, from + pageSize - 1)
    if (error) return { rows, error }
    rows.push(...((data ?? []) as unknown as Record<string, any>[]))
    if (!data || data.length < pageSize) return { rows, error: null }
  }
}
