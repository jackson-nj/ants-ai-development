import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { asQuery, embedTexts, isGeminiConfigured, toVector } from '@/lib/gemini'
import { canMatch, emptyProfile, keywordScore, profileGaps, profileToText, similarityToScore, type CandidateProfile } from '@/lib/matching'
import { fetchRecentOpportunities, opportunityCutoff } from '@/lib/opportunity-filters'

export const maxDuration = 30

// Ranks recent listings for the signed-in user. Listings are scored by Gemini embedding similarity;
// any listing the AI cannot score (quota exhausted, Gemini down, not embedded yet) gets a keyword
// score on the same scale instead, so the user always sees match scores.
export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Sign in to see AI matches' }, { status: 401 })

  const { data: row, error: profileError } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle()
  if (profileError) return NextResponse.json({ error: 'Unable to load your profile', detail: profileError.message }, { status: 500 })
  const profile: CandidateProfile = { ...emptyProfile(), ...(row ?? {}), skills: row?.skills ?? [] }
  const gaps = profileGaps(profile)
  if (!row || !canMatch(profile)) return NextResponse.json({ needsProfile: true, gaps, skills: profile.skills, matches: [] })

  const cutoff = opportunityCutoff().toISOString()
  const semantic = new Map<string, number>()
  let embedding: string | null = row.embedding ?? null
  if (!embedding && isGeminiConfigured()) {
    try {
      // Keep the wait short: a user should not sit through a rate-limit pause; the keyword fallback covers it.
      const [vector] = await embedTexts([asQuery(profileToText(profile))], { maxWaitMs: 3000 })
      embedding = toVector(vector)
      await supabase.from('profiles').update({ embedding }).eq('id', user.id)
    } catch (error) {
      console.warn('[v0] Profile embedding unavailable, using keyword matching:', error instanceof Error ? error.message : error)
    }
  }
  if (embedding) {
    const { data: ranked, error: matchError } = await supabase.rpc('match_opportunities', { query_embedding: embedding, min_posted_at: cutoff, match_count: 2000 })
    if (matchError) console.warn('[v0] Semantic ranking failed, using keyword matching:', matchError.message)
    for (const match of (ranked ?? []) as { opportunity_id: string; similarity: number }[]) semantic.set(match.opportunity_id, similarityToScore(match.similarity))
  }

  // Only read listing text when some listings still need a keyword score.
  const { count } = await supabase.from('opportunities').select('id', { count: 'exact', head: true }).gte('posted_at', cutoff)
  let matches = Array.from(semantic, ([id, score]) => ({ id, score }))
  if ((count ?? 0) > semantic.size) {
    const { rows, error } = await fetchRecentOpportunities(supabase, 'id, role, tags, description')
    if (error) return NextResponse.json({ error: 'Unable to rank opportunities', detail: error.message }, { status: 500 })
    matches = rows.map((listing) => ({ id: String(listing.id), score: semantic.get(String(listing.id)) ?? keywordScore(profile, listing) }))
  }
  return NextResponse.json({ needsProfile: false, gaps, skills: profile.skills, matches })
}
