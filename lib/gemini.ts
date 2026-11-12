// Server-only client for Gemini text embeddings. gemini-embedding-2 auto-normalises truncated
// dimensions and takes its task as a text prefix rather than a task_type field.
const GEMINI_MODEL = 'gemini-embedding-2'
export const EMBEDDING_DIMENSIONS = 768
const BATCH_SIZE = 100

export const isGeminiConfigured = () => Boolean(process.env.GEMINI_API_KEY)

export const asQuery = (text: string) => `task: search result | query: ${text}`
export const asDocument = (title: string, text: string) => `title: ${title} | text: ${text}`

// Gemini counts each text in a batch as one request; the free tier allows 100 a minute and about
// 1,000 a day. Listings may use at most 700 a day, so ~300 always remain for users' profiles.
export const EMBED_REQUESTS_PER_MINUTE = 100
export const DAILY_LISTING_EMBED_BUDGET = 700

// Gemini's daily quota resets at midnight Pacific Time, so usage is counted per Pacific day.
export const quotaDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date())

export class GeminiRateLimitError extends Error {
  constructor(public retryAfterMs: number) { super(`Gemini rate limit reached; retry in ${Math.ceil(retryAfterMs / 1000)}s`) }
}

// A 429 body carries the wait in details[].retryDelay, e.g. "9s".
async function retryDelayMs(response: Response) {
  const body = await response.json().catch(() => null) as { error?: { details?: { retryDelay?: string }[] } } | null
  const delay = body?.error?.details?.find((detail) => detail.retryDelay)?.retryDelay
  return delay ? Math.ceil(parseFloat(delay) * 1000) : 60000
}

export async function embedTexts(texts: string[], { maxWaitMs = 15000 } = {}): Promise<number[][]> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set')
  const vectors: number[][] = []
  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE)
    let response: Response
    for (let waited = 0; ; ) {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:batchEmbedContents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ requests: batch.map((text) => ({ model: `models/${GEMINI_MODEL}`, content: { parts: [{ text }] }, outputDimensionality: EMBEDDING_DIMENSIONS })) }),
        signal: AbortSignal.timeout(20000),
      })
      if (response.status !== 429) break
      const delay = await retryDelayMs(response)
      if (waited + delay > maxWaitMs) throw new GeminiRateLimitError(delay)
      await new Promise((resolve) => setTimeout(resolve, delay))
      waited += delay
    }
    if (!response.ok) throw new Error(`Gemini embeddings returned ${response.status}: ${(await response.text()).slice(0, 300)}`)
    const data = (await response.json()) as { embeddings?: { values: number[] }[] }
    if (!data.embeddings || data.embeddings.length !== batch.length) throw new Error('Gemini returned an unexpected number of embeddings')
    vectors.push(...data.embeddings.map((embedding) => embedding.values))
  }
  return vectors
}

// pgvector parses its text form "[0.1,0.2,…]", which is also what JSON.stringify produces.
export const toVector = (values: number[]) => JSON.stringify(values)
