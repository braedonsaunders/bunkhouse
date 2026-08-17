'use client'

import * as React from 'react'
import { marked } from 'marked'
import TurndownService from 'turndown'
// @ts-expect-error turndown-plugin-gfm ships no types; it adds tables/strikethrough.
import { gfm } from 'turndown-plugin-gfm'
import { RichTextEditor } from '@braedonsaunders/appkit-editor'

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
turndown.use(gfm)
// [[wikilinks]] survive as plain text in both directions — keep them verbatim.

/**
 * Rich-text editing over markdown storage: the editor works in HTML
 * (lists, headings, tables via @braedonsaunders/appkit-editor), the form receives GFM
 * markdown — the Logbook's source of truth stays human-readable text.
 */
export function MarkdownEditor({
  name,
  defaultValue = '',
  placeholder,
  minHeight,
  onChange,
}: {
  name?: string
  defaultValue?: string
  placeholder?: string
  minHeight?: string
  onChange?: (markdown: string) => void
}) {
  const initialHtml = React.useMemo(() => marked.parse(defaultValue, { async: false }), [defaultValue])
  const [markdown, setMarkdown] = React.useState(defaultValue)

  return (
    <>
      <RichTextEditor
        defaultValue={initialHtml}
        onChange={(html) => {
          const md = turndown.turndown(html)
          setMarkdown(md)
          onChange?.(md)
        }}
        {...(placeholder ? { placeholder } : {})}
        {...(minHeight ? { minHeight } : {})}
        normalizeLink={(value) => {
          const trimmed = value.trim()
          if (!trimmed) return null
          if (/^https?:\/\//i.test(trimmed)) return trimmed
          if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(trimmed)) return `mailto:${trimmed}`
          return `https://${trimmed}`
        }}
      />
      {name ? <input type="hidden" name={name} value={markdown} readOnly /> : null}
    </>
  )
}
