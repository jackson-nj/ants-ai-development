// Turns job-board HTML into structured text, splits it into the sections the detail page shows, and
// labels locations so every listing reads as remote.

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', bull: '•' }

// Keeps paragraphs, headings and bullets as lines ("• item") so the posting's structure survives storage.
export function htmlToText(html: string) {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*li[^>]*>/gi, '\n• ')
    .replace(/<\s*(br|\/p|\/div|\/h[1-6]|h[1-6][^>]*|\/ul|\/ol|\/li|p[^>]*)\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity, code: string) => code[0] === '#' ? String.fromCodePoint(parseInt(code.slice(code[1].toLowerCase() === 'x' ? 2 : 1), code[1].toLowerCase() === 'x' ? 16 : 10)) : ENTITIES[code.toLowerCase()] ?? entity)
    .split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line && line !== '•')
    .join('\n')
}

export type SectionKind = 'responsibilities' | 'requirements' | 'benefits' | 'other'
export type JobSection = { title: string; kind: SectionKind; items: string[] }

const KINDS: [SectionKind, RegExp][] = [
  ['responsibilities', /responsib|what you('|’)?ll (do|be doing|work on)|what you will (do|be doing)|duties|day[- ]to[- ]day|your (role|mission|impact)|the role|in this role|key tasks|tasks/i],
  ['requirements', /requirement|qualification|what you('|’)?ll (need|bring)|what you (need|bring)|you('|’)?ll need|you will need|who you are|about you|skills|experience|must[- ]have|nice[- ]to[- ]have|looking for|you have|ideal candidate|competenc/i],
  ['benefits', /benefit|perks|what we offer|we offer|compensation|salary|\bpay\b|why (join|work)|what('|’)?s in it|our offer/i],
]

// A short line without a full stop that names a section ("Requirements:", "What you'll do") is a heading.
const isHeading = (line: string) => !line.startsWith('•') && line.length <= 70 && !/[.!?]$/.test(line) && (line.endsWith(':') || KINDS.some(([, pattern]) => pattern.test(line)))

// Postings stored before structure was kept are one long line: break it at common section headings
// and split the text between them into sentences.
const FLAT_HEADING = /\b(Key Responsibilities|Responsibilities|Your Responsibilities|What You('|’)ll Do|What You Will Do|The Role|About the Role|Requirements|Qualifications|Minimum Qualifications|Preferred Qualifications|What You('|’)ll Need|What We('|’)re Looking For|Who You Are|About You|Nice to Have|Bonus Points|Benefits|Perks|What We Offer|Compensation)(:|(?=\s+[A-Z•]))/g
function restoreStructure(text: string) {
  if (text.includes('\n') || text.length < 300) return text
  return text.replace(FLAT_HEADING, (heading) => `\n${heading.replace(/:$/, '')}:\n`).split('\n')
    .flatMap((chunk) => /:$/.test(chunk) ? [chunk] : chunk.split(/(?<=[.!?])\s+(?=[A-Z])/).map((sentence) => `• ${sentence}`))
    .map((line, index) => index === 0 ? line.replace(/^•\s*/, '') : line).join('\n')
}

export function parseJobDescription(text: string) {
  const intro: string[] = []
  const sections: JobSection[] = []
  for (const line of restoreStructure(text).split('\n').map((value) => value.trim()).filter(Boolean)) {
    if (isHeading(line)) {
      const title = line.replace(/:$/, '')
      sections.push({ title, kind: KINDS.find(([, pattern]) => pattern.test(title))?.[0] ?? 'other', items: [] })
    } else if (sections.length) {
      sections[sections.length - 1].items.push(line.replace(/^•\s*/, ''))
    } else {
      intro.push(line.replace(/^•\s*/, ''))
    }
  }
  return { intro, sections: sections.filter((section) => section.items.length) }
}

// Remote-only boards give the region a remote worker must live in; show it as part of a remote label.
export function remoteLabel(location: string) {
  const region = location.replace(/\b(fully )?remote( job| work| first)?\b/gi, '').replace(/^[\s,;·|/()\-–]+|[\s,;·|/()\-–]+$/g, '').replace(/\s{2,}/g, ' ')
  return region ? `Remote · ${region}` : 'Remote · Worldwide'
}
