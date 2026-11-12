import { NextResponse } from 'next/server'
import { extractText, getDocumentProxy } from 'unpdf'
import mammoth from 'mammoth'
import { createClient } from '@/lib/supabase/server'

export const maxDuration = 30

const MAX_BYTES = 5 * 1024 * 1024
const CV_BUCKET = 'cvs'
const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
}

async function readText(extension: string, bytes: Uint8Array) {
  if (extension === 'pdf') return (await extractText(await getDocumentProxy(bytes), { mergePages: true })).text
  if (extension === 'docx') return (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value
  return new TextDecoder().decode(bytes)
}

// Reads the text of an uploaded CV for AI matching and, for signed-in users, stores the original
// file in their private folder of the cvs bucket (one CV per user; a new upload replaces the old).
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) return NextResponse.json({ error: 'Choose a file to upload.' }, { status: 400 })
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (!TYPES[extension]) return NextResponse.json({ error: 'Upload a PDF, Word (.docx) or text file.' }, { status: 415 })
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'That file is larger than 5 MB.' }, { status: 413 })

  const bytes = new Uint8Array(await file.arrayBuffer())
  let text = ''
  try {
    text = (await readText(extension, bytes)).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 20000)
  } catch (error) {
    console.error('[v0] CV text extraction failed:', error)
  }
  // Scanned CVs are images with no text layer, which the matcher cannot read.
  if (text.length < 50) return NextResponse.json({ error: 'We could not read text from this file. If it is a scanned image, upload a PDF saved from Word or Google Docs, or a .docx file.' }, { status: 422 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  let stored = false
  if (user) {
    const { data: existing } = await supabase.storage.from(CV_BUCKET).list(user.id)
    const stale = (existing ?? []).map((object) => `${user.id}/${object.name}`).filter((path) => path !== `${user.id}/cv.${extension}`)
    if (stale.length) await supabase.storage.from(CV_BUCKET).remove(stale)
    const { error } = await supabase.storage.from(CV_BUCKET).upload(`${user.id}/cv.${extension}`, bytes, { contentType: TYPES[extension], upsert: true })
    if (error) console.error('[v0] CV storage upload failed:', error.message)
    stored = !error
  }
  return NextResponse.json({ text, fileName: file.name, words: text.split(/\s+/).length, stored })
}

// Removes the signed-in user's stored CV.
export async function DELETE() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ removed: false })
  const { data: existing } = await supabase.storage.from(CV_BUCKET).list(user.id)
  const paths = (existing ?? []).map((object) => `${user.id}/${object.name}`)
  if (paths.length) await supabase.storage.from(CV_BUCKET).remove(paths)
  return NextResponse.json({ removed: true })
}
