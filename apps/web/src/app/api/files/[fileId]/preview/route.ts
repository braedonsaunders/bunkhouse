import { Buffer } from 'node:buffer'
import { docxToPdf, sofficeConvert } from '@braedonsaunders/appkit-office'
import { getFileBytes, getFileRecord, getFileStream } from '../../../../../lib/files'
import { resolveTenantId } from '../../../../../lib/tenant'

export const dynamic = 'force-dynamic'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const XLS = 'application/vnd.ms-excel'

function extensionOf(filename: string): string {
  return filename.split('.').at(-1)?.toLowerCase() ?? ''
}

function mediaTypeOf(contentType: string): string {
  return contentType.split(';')[0]?.trim().toLowerCase() ?? 'application/octet-stream'
}

function inlineHeaders(contentType: string, filename: string, contentLength?: number): HeadersInit {
  return {
    'Content-Type': contentType,
    'Content-Disposition': `inline; filename="${filename.replaceAll('"', '')}"`,
    ...(contentLength === undefined ? {} : { 'Content-Length': String(contentLength) }),
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  }
}

/**
 * Authenticated, tenant-scoped previews for the chat Files work surface.
 * Office files are rendered to PDF by the same AppKit/LibreOffice pipeline
 * used to produce them; text is forced to text/plain so authored HTML can
 * never execute inside the application origin.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params
  const tenantId = await resolveTenantId('work.read')
  const record = await getFileRecord(tenantId, fileId)
  if (!record) return new Response('Not found', { status: 404 })

  const extension = extensionOf(record.filename)
  const mediaType = mediaTypeOf(record.contentType)
  const isDocx = extension === 'docx' || mediaType === DOCX
  const isSpreadsheet = ['xlsx', 'xls'].includes(extension) || mediaType === XLSX || mediaType === XLS

  try {
    if (isDocx || isSpreadsheet) {
      const source = Buffer.from(await getFileBytes(record))
      const pdf = isDocx
        ? await docxToPdf(source)
        : await sofficeConvert(source, extension === 'xls' || mediaType === XLS ? 'workbook.xls' : 'workbook.xlsx', 'pdf')
      return new Response(new Uint8Array(pdf), {
        headers: inlineHeaders('application/pdf', record.filename.replace(/\.[^.]+$/, '.pdf'), pdf.byteLength),
      })
    }

    const isImage = /^image\/(?:png|jpeg|gif|webp)$/.test(mediaType)
    const isPdf = extension === 'pdf' || mediaType === 'application/pdf'
    const isText =
      mediaType.startsWith('text/') ||
      ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'log'].includes(extension) ||
      ['application/json', 'application/xml', 'application/ld+json'].includes(mediaType)
    if (!isImage && !isPdf && !isText) return new Response('This file type has no safe preview.', { status: 415 })

    const { stream, contentLength } = await getFileStream(record)
    return new Response(stream, {
      headers: inlineHeaders(isText ? 'text/plain; charset=utf-8' : record.contentType, record.filename, contentLength),
    })
  } catch (error) {
    console.error(`[files] preview ${record.id} could not be rendered`, error)
    return new Response('The preview could not be rendered. Download the original to open it locally.', { status: 422 })
  }
}
