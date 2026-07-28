import 'server-only'
import ExcelJS, { type CellValue } from 'exceljs'
import { extractText, getDocumentProxy } from 'unpdf'
import {
  docxToText,
  replaceTextInDocx,
  DOCX_MIME_TYPE,
  PDF_MIME_TYPE,
  XLSX_MIME_TYPE,
  type FodtEdit,
  type FodtEditResult,
} from '@appkit/office'
import { getFileBytes, getFileRecord, saveFile, type FileRecord } from './files'

/**
 * The reading half of the files ledger. documents.ts writes deliverables; this
 * turns a ledgered .docx / .pdf / .xlsx / text file back into prose an agent
 * can actually read, and applies exact-text revisions to a .docx.
 *
 * Files are immutable, so a revision is always a new ledger row — the original
 * stays retrievable and the audit trail keeps both.
 */

export type FileTextKind = 'docx' | 'pdf' | 'xlsx' | 'html' | 'text' | 'binary'

export type ExtractedFileText = {
  kind: FileTextKind
  text: string
  truncated?: boolean
  note?: string
}

export type LedgeredFileText = {
  found: boolean
  filename?: string
  kind?: FileTextKind
  text?: string
  truncated?: boolean
  note?: string
  reason?: string
}

export type DocxRevision = {
  revised: boolean
  fileId?: string
  filename?: string
  results?: FodtEditResult[]
  reason?: string
}

/** Context is the scarce resource: long files come back clipped, not whole. */
const MAX_TEXT_CHARS = 24_000

/**
 * Below this many characters per page a PDF has no usable text layer — it is
 * page images from a scanner or a photocopier, and the agent needs to be told
 * so rather than concluding the document is blank.
 */
const MIN_PDF_CHARS_PER_PAGE = 16

const SCANNED_PDF_NOTE = 'This PDF appears to be scanned images; no machine-readable text.'

const TEXT_EXTENSIONS = new Set(['csv', 'tsv', 'txt', 'md', 'markdown', 'json', 'xml', 'log', 'yaml', 'yml'])
const TEXT_CONTENT_TYPES = new Set(['application/json', 'application/xml', 'application/ld+json'])
const HTML_EXTENSIONS = new Set(['html', 'htm'])

/** Closing tags that end a line of reading, as opposed to inline markup. */
const HTML_BLOCK_CLOSE =
  /<\s*\/\s*(?:p|div|section|article|aside|header|footer|main|nav|li|tr|caption|h[1-6]|blockquote|pre|figure|figcaption|table|ul|ol|dl|dd|dt|form|fieldset)\s*>/gi

function extensionOf(filename: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim())
  return match ? match[1].toLowerCase() : ''
}

/** The bare media type — storage records may carry parameters like charset. */
function mediaTypeOf(contentType: string): string {
  return contentType.split(';')[0].trim().toLowerCase()
}

function clip(kind: FileTextKind, text: string, note?: string): ExtractedFileText {
  const truncated = text.length > MAX_TEXT_CHARS
  const clipped = truncated ? text.slice(0, MAX_TEXT_CHARS) : text
  return {
    kind,
    text: clipped,
    ...(truncated ? { truncated: true } : {}),
    ...(note ? { note } : {}),
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  euro: '€',
  pound: '£',
}

function decodeEntities(html: string): string {
  return html.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1]?.toLowerCase() === 'x'
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      // Lone surrogates and out-of-range code points would throw; leave them literal.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return match
      return String.fromCodePoint(code)
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/**
 * Reduce HTML to readable text. Deliberately a regex stripper rather than a
 * parser dependency: block boundaries become newlines, table cells become tabs,
 * and everything inside a tag is dropped. Tags whose attribute values contain a
 * literal `>` lose a few following characters — acceptable for reading, and the
 * reason this is never used to rewrite markup.
 */
function htmlToText(html: string): string {
  const withoutInvisible = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  const withBreaks = withoutInvisible
    .replace(/<\s*(?:br|hr)\b[^>]*>/gi, '\n')
    .replace(HTML_BLOCK_CLOSE, '\n')
    .replace(/<\s*\/\s*(?:td|th)\s*>/gi, '\t')
  const text = decodeEntities(withBreaks.replace(/<[^>]*>/g, ''))
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n\t]+/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, '').replace(/^ +/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

function formulaSource(value: { formula?: string } | { sharedFormula: string }): string {
  if ('formula' in value && value.formula) return value.formula
  if ('sharedFormula' in value) return value.sharedFormula
  return ''
}

/** Render one cell the way a reader would see it, not the way it is stored. */
function cellText(value: CellValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  if ('richText' in value) return value.richText.map((part) => part.text).join('')
  if ('error' in value) return value.error
  if ('hyperlink' in value) return value.text || value.hyperlink
  if ('formula' in value || 'sharedFormula' in value) {
    // A formula cell carries the value Excel last computed; the formula itself
    // is only useful when the workbook was saved without cached results.
    const result = value.result
    if (result === null || result === undefined) {
      const formula = formulaSource(value)
      return formula ? `=${formula}` : ''
    }
    if (result instanceof Date) return result.toISOString()
    if (typeof result === 'object') return result.error
    return String(result)
  }
  return ''
}

async function xlsxToText(bytes: Uint8Array): Promise<string> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(new Uint8Array(bytes).buffer)

  const lines: string[] = []
  let length = 0
  let full = false
  const push = (line: string): void => {
    if (full) return
    lines.push(line)
    length += line.length + 1
    if (length > MAX_TEXT_CHARS) full = true
  }

  for (const sheet of workbook.worksheets) {
    if (full) break
    if (lines.length > 0) push('')
    push(`## Sheet: ${sheet.name}`)
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: (string | undefined)[] = []
      row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
        cells[columnNumber - 1] = cellText(cell.value)
      })
      const line = Array.from(cells, (cell) => (cell ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t')
      push(line.replace(/\t+$/, ''))
    })
  }
  return lines.join('\n')
}

async function pdfToText(bytes: Uint8Array): Promise<ExtractedFileText> {
  // pdf.js detaches the buffer it is handed, so it gets its own copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes))
  const { totalPages, text } = await extractText(pdf, { mergePages: true })
  const dense = text.replace(/\s+/g, '')
  const scanned = dense.length < MIN_PDF_CHARS_PER_PAGE * Math.max(totalPages, 1)
  return clip('pdf', text.trim(), scanned ? SCANNED_PDF_NOTE : undefined)
}

function isDocx(record: Pick<FileRecord, 'filename' | 'contentType'>): boolean {
  return extensionOf(record.filename) === 'docx' || mediaTypeOf(record.contentType) === DOCX_MIME_TYPE
}

/**
 * Read a ledgered file's bytes as text, dispatching on extension first and
 * content type second (uploads and mail attachments routinely arrive as
 * `application/octet-stream`). Unsupported types come back as an empty
 * `binary` result rather than an error — the agent should be told there is
 * nothing to read, not handed an exception. A conversion tool that is present
 * but failing (LibreOffice, pdf.js) does throw: that is an operator problem.
 */
export async function extractFileText(record: FileRecord, bytes: Uint8Array): Promise<ExtractedFileText> {
  const extension = extensionOf(record.filename)
  const mediaType = mediaTypeOf(record.contentType)

  if (extension === 'docx' || mediaType === DOCX_MIME_TYPE) {
    return clip('docx', (await docxToText(Buffer.from(bytes))).trim())
  }
  if (extension === 'pdf' || mediaType === PDF_MIME_TYPE) {
    return pdfToText(bytes)
  }
  if (extension === 'xlsx' || mediaType === XLSX_MIME_TYPE) {
    return clip('xlsx', await xlsxToText(bytes))
  }
  if (HTML_EXTENSIONS.has(extension) || mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
    return clip('html', htmlToText(decodeUtf8(bytes)))
  }
  if (TEXT_EXTENSIONS.has(extension) || TEXT_CONTENT_TYPES.has(mediaType) || mediaType.startsWith('text/')) {
    return clip('text', decodeUtf8(bytes))
  }
  return { kind: 'binary', text: '', note: `No text extraction available for ${record.contentType}.` }
}

/** Fetch a file from the ledger and read it, in one step, for agent tools. */
export async function readLedgeredFile(tenantId: string, fileId: string): Promise<LedgeredFileText> {
  const record = await getFileRecord(tenantId, fileId)
  if (!record) return { found: false, reason: 'No such file.' }
  const bytes = await getFileBytes(record)
  const extracted = await extractFileText(record, bytes)
  return { found: true, filename: record.filename, ...extracted }
}

/**
 * Name the next revision of a document: `report.docx` → `report (rev).docx`,
 * and an existing `(rev)` / `(rev N)` suffix counts up instead of stacking.
 */
function nextRevisionFilename(filename: string): string {
  const base = filename.replace(/\.docx$/i, '')
  const match = /\s*\(rev(?:\s+(\d+))?\)\s*$/i.exec(base)
  if (!match) return `${base} (rev).docx`
  const current = match[1] ? Number.parseInt(match[1], 10) : 1
  return `${base.slice(0, match.index)} (rev ${current + 1}).docx`
}

/**
 * Apply exact-match text edits to a ledgered .docx and file the result as a new
 * document. Formatting survives (the conversion round-trips through Flat ODT),
 * and every edit reports its occurrence count so the agent can see which of its
 * find strings actually landed. An edit set that matches nothing is reported
 * back rather than saved — an unchanged copy is not a revision.
 */
export async function reviseDocxFile(args: {
  tenantId: string
  personId: string
  runId: string
  fileId: string
  edits: FodtEdit[]
}): Promise<DocxRevision> {
  const record = await getFileRecord(args.tenantId, args.fileId)
  if (!record) return { revised: false, reason: 'No such file.' }
  if (!isDocx(record)) {
    return { revised: false, reason: `Only .docx files can be revised; ${record.filename} is ${record.contentType}.` }
  }
  if (args.edits.length === 0) return { revised: false, reason: 'No edits were supplied.' }

  const bytes = await getFileBytes(record)
  const { docx, results } = await replaceTextInDocx(Buffer.from(bytes), args.edits)
  if (results.every((result) => result.count === 0)) {
    return { revised: false, results, reason: 'No edit matched — re-read the document and use exact text.' }
  }

  const saved = await saveFile({
    tenantId: args.tenantId,
    personId: args.personId,
    runId: args.runId,
    kind: 'document',
    filename: nextRevisionFilename(record.filename),
    contentType: DOCX_MIME_TYPE,
    bytes: docx,
  })
  return { revised: true, fileId: saved.id, filename: saved.filename, results }
}
