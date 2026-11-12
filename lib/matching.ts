// Shared profile and listing text used for embeddings, plus the skill-overlap explanation shown with each match.

export type CandidateProfile = {
  full_name: string; location: string; role_title: string; years_experience: number | null; looking_for: string
  skills: string[]; experience: string; education: string; cv_text: string
}

export const emptyProfile = (): CandidateProfile => ({ full_name: '', location: '', role_title: '', years_experience: null, looking_for: '', skills: [], experience: '', education: '', cv_text: '' })

// FR-03: a profile with fewer than 3 skills and little written background is too sparse to embed meaningfully.
export const MIN_SKILLS = 3
export function profileGaps(profile: CandidateProfile) {
  const gaps: string[] = []
  if (!profile.role_title.trim()) gaps.push('your current or target role')
  if (profile.skills.length < MIN_SKILLS) gaps.push(`at least ${MIN_SKILLS} skills`)
  if ((profile.experience + profile.cv_text + profile.looking_for).trim().length < 40) gaps.push('a short description of your experience')
  return gaps
}

export function profileToText(profile: CandidateProfile) {
  return [
    profile.role_title && `Role: ${profile.role_title}`,
    profile.years_experience != null && `Experience: ${profile.years_experience} years`,
    profile.skills.length > 0 && `Skills: ${profile.skills.join(', ')}`,
    profile.looking_for && `Looking for: ${profile.looking_for}`,
    profile.experience && `Work history: ${profile.experience}`,
    profile.education && `Education: ${profile.education}`,
    profile.cv_text && `CV: ${profile.cv_text}`,
  ].filter(Boolean).join('\n').slice(0, 8000)
}

export function listingToText(listing: { role?: string; company?: string; tags?: unknown; description?: string }) {
  const tags = Array.isArray(listing.tags) ? listing.tags.join(', ') : ''
  return [`Company: ${listing.company ?? ''}`, tags && `Skills: ${tags}`, listing.description ?? ''].filter(Boolean).join('\n').slice(0, 6000)
}

// Profile-to-listing cosine similarity from gemini-embedding-2 runs from about 0.60 (unrelated) to
// about 0.80 (close fit) on real postings, so it is shown as a percentage of that band; the ordering
// always comes from the raw similarity. Measured on 554 live listings, 12 Nov 2026.
const SIMILARITY_FLOOR = 0.6
const SIMILARITY_CEILING = 0.78
export const similarityToScore = (similarity: number) => Math.round(Math.min(1, Math.max(0, (similarity - SIMILARITY_FLOOR) / (SIMILARITY_CEILING - SIMILARITY_FLOOR))) * 100)
export const STRONG_MATCH_SCORE = 70

// FR-07: which of the candidate's skills the listing mentions, and which listed skills they have not named.
export function explainMatch(skills: string[], listing: { role: string; description: string; tags: string[] }) {
  const text = `${listing.role} ${listing.description} ${listing.tags.join(' ')}`.toLowerCase()
  const known = skills.map((skill) => skill.toLowerCase())
  const matched = skills.filter((skill) => text.includes(skill.toLowerCase()))
  const missing = listing.tags.filter((tag) => !known.some((skill) => skill.includes(tag.toLowerCase()) || tag.toLowerCase().includes(skill))).slice(0, 5)
  return { matched, missing }
}

// Share of profile sections filled in, and the next one to add.
export function profileCompleteness(profile: CandidateProfile | null) {
  const p = profile ?? emptyProfile()
  const checks: [string, boolean][] = [
    ['your full name', Boolean(p.full_name.trim())],
    ['your location', Boolean(p.location.trim())],
    ['your current or target role', Boolean(p.role_title.trim())],
    [`at least ${MIN_SKILLS} skills`, p.skills.length >= MIN_SKILLS],
    ['your work experience', Boolean(p.experience.trim())],
    ['your education', Boolean(p.education.trim())],
    ['what you are looking for', Boolean(p.looking_for.trim())],
    ['your CV', Boolean(p.cv_text.trim())],
  ]
  const done = checks.filter(([, filled]) => filled).length
  return { percent: Math.round((done / checks.length) * 100), next: checks.find(([, filled]) => !filled)?.[0] ?? null }
}

// Fallback scorer used when Gemini is unavailable (quota exhausted or down): weighted keyword overlap
// between the profile and a listing, on the same 0–100 scale as the AI score. Skills weigh most, then
// role words, then frequent words from the written background.
const STOPWORDS = new Set('a an and are as at be by for from has have in is it its of on or our that the their this to we will with you your years year experience work working role remote team'.split(' '))
const words = (text: string) => text.toLowerCase().match(/[a-z][a-z0-9+#.]{1,}/g)?.filter((word) => !STOPWORDS.has(word)) ?? []

export function keywordScore(profile: CandidateProfile, listing: { role?: string; tags?: unknown; description?: string }) {
  const tags = Array.isArray(listing.tags) ? listing.tags.join(' ') : ''
  const text = ` ${`${listing.role ?? ''} ${tags} ${listing.description ?? ''}`.toLowerCase()} `
  const background = words(`${profile.looking_for} ${profile.experience} ${profile.cv_text}`)
  const frequent = [...new Set(background)].sort((a, b) => background.filter((w) => w === b).length - background.filter((w) => w === a).length).slice(0, 20)
  const terms: [string, number][] = [
    ...profile.skills.map((skill): [string, number] => [skill.toLowerCase(), 3]),
    ...words(profile.role_title).map((word): [string, number] => [word, 2]),
    ...frequent.map((word): [string, number] => [word, 1]),
  ]
  if (!terms.length) return 0
  const total = terms.reduce((sum, [, weight]) => sum + weight, 0)
  const matched = terms.reduce((sum, [term, weight]) => sum + (text.includes(term) ? weight : 0), 0)
  const titleBonus = profile.role_title.trim() && (listing.role ?? '').toLowerCase().includes(profile.role_title.trim().toLowerCase()) ? 20 : 0
  return Math.min(100, Math.round((matched / total) * 100) + titleBonus)
}
