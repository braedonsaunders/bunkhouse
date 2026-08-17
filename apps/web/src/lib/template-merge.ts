/**
 * The merge engine behind document templates — deliberately tiny and
 * dependency-free, so it runs unchanged in a server action, in an agent's
 * tool call, and in the operator's browser while they author.
 *
 * Two rules make it honest:
 *
 * 1. Values are escaped for the format they land in. A document body is HTML,
 *    so a customer name containing `&` or `<` can never become markup.
 * 2. A placeholder with no value is left visibly intact — `{{invoice_total}}`
 *    stays in the output and is reported back to the caller. Silently blanking
 *    it would produce a document that looks finished and is not; an agent has
 *    to be able to see what it failed to fill.
 *
 * Type-only compatibility with @braedonsaunders/appkit-office is structural: `TemplateSheet`
 * matches that package's `SheetSpec`, so a merged spec renders directly
 * without importing server-side code into the browser.
 */

/** `{{field_name}}` — letters, digits, underscore, dot and dash, spaces tolerated inside the braces. */
export const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*\}\}/g

/** Every distinct placeholder in a body, in the order it first appears. */
export function findPlaceholders(body: string): string[] {
  const seen: string[] = []
  for (const match of body.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1]
    if (name && !seen.includes(name)) seen.push(name)
  }
  return seen
}

/** A readable label for a placeholder an operator has not named yet. */
export function humanizeFieldName(name: string): string {
  const words = name
    .replace(/[._-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
  if (words.length === 0) return name
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/** Escape a merged value for HTML text and attribute content. */
export function escapeHtmlValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export type MergeOutcome<T> = {
  value: T
  /** Placeholders that received a value. */
  filled: string[]
  /** Placeholders left standing in the output because nothing was supplied. */
  unfilled: string[]
}

/** True when a supplied value counts as an answer (an explicit '' is a deliberate blank). */
function supplied(values: Record<string, string>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(values, name) && typeof values[name] === 'string'
}

/**
 * Replace placeholders in plain text or HTML. `escape` is applied to every
 * substituted value; pass `escapeHtmlValue` for HTML bodies.
 */
export function mergeText(
  body: string,
  values: Record<string, string>,
  escape: (value: string) => string = (value) => value,
): MergeOutcome<string> {
  const filled: string[] = []
  const unfilled: string[] = []
  const text = body.replace(PLACEHOLDER_PATTERN, (whole, rawName: string) => {
    const name = rawName
    if (!supplied(values, name)) {
      if (!unfilled.includes(name)) unfilled.push(name)
      return whole
    }
    if (!filled.includes(name)) filled.push(name)
    return escape(values[name] ?? '')
  })
  return { value: text, filled, unfilled }
}

/** Merge into an HTML body, escaping every value. */
export function mergeHtml(body: string, values: Record<string, string>): MergeOutcome<string> {
  return mergeText(body, values, escapeHtmlValue)
}

// --- Spreadsheet templates --------------------------------------------------

export type TemplateColumn = {
  header: string
  key: string
  width?: number
  numFmt?: string
}

export type TemplateSheet = {
  name: string
  columns: TemplateColumn[]
  rows: Record<string, string | number | boolean | null>[]
  formulas?: { cell: string; formula: string }[]
  freezeHeader?: boolean
  autoFilter?: boolean
  boldHeader?: boolean
}

export type TemplateWorkbook = { sheets: TemplateSheet[] }

/** A workable starting point when an operator creates a spreadsheet template. */
export const EXAMPLE_SHEET_SPEC = `{
  "sheets": [
    {
      "name": "Quote",
      "columns": [
        { "header": "Item", "key": "item" },
        { "header": "Qty", "key": "qty" },
        { "header": "Unit price", "key": "price", "numFmt": "$#,##0.00" }
      ],
      "rows": [
        { "item": "{{line_1_item}}", "qty": 1, "price": 0 }
      ],
      "autoFilter": true
    }
  ]
}`

function fail(message: string): never {
  throw new Error(message)
}

/**
 * Read and validate a spreadsheet template body. Rejects anything that would
 * render an empty or unusable workbook, in the operator's language — this runs
 * at save time so a broken spec never reaches an agent.
 */
export function parseSheetSpec(body: string): TemplateWorkbook {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    fail('The sheet specification is not valid JSON. Check for a missing comma or bracket.')
  }
  const source = parsed as { sheets?: unknown }
  const sheets = source?.sheets
  if (!Array.isArray(sheets) || sheets.length === 0) {
    fail('The specification needs a "sheets" list with at least one sheet.')
  }
  return {
    sheets: sheets.map((raw, index): TemplateSheet => {
      const sheet = raw as Partial<TemplateSheet>
      const position = index + 1
      if (typeof sheet?.name !== 'string' || !sheet.name.trim()) fail(`Sheet ${position} needs a name.`)
      if (!Array.isArray(sheet.columns) || sheet.columns.length === 0) {
        fail(`Sheet "${sheet.name}" needs at least one column.`)
      }
      const columns = sheet.columns.map((column, columnIndex): TemplateColumn => {
        if (typeof column?.header !== 'string' || !column.header.trim()) {
          fail(`Column ${columnIndex + 1} of "${sheet.name}" needs a header.`)
        }
        if (typeof column?.key !== 'string' || !column.key.trim()) {
          fail(`Column "${column.header}" of "${sheet.name}" needs a key.`)
        }
        return {
          header: column.header,
          key: column.key,
          ...(typeof column.width === 'number' ? { width: column.width } : {}),
          ...(typeof column.numFmt === 'string' ? { numFmt: column.numFmt } : {}),
        }
      })
      if (!Array.isArray(sheet.rows)) fail(`Sheet "${sheet.name}" needs a "rows" list (it may be empty).`)
      const formulas = Array.isArray(sheet.formulas)
        ? sheet.formulas.map((formula, formulaIndex) => {
            if (typeof formula?.cell !== 'string' || typeof formula?.formula !== 'string') {
              fail(`Formula ${formulaIndex + 1} of "${sheet.name}" needs both "cell" and "formula".`)
            }
            return { cell: formula.cell, formula: formula.formula }
          })
        : undefined
      return {
        name: sheet.name,
        columns,
        rows: sheet.rows as Record<string, string | number | boolean | null>[],
        ...(formulas ? { formulas } : {}),
        ...(typeof sheet.freezeHeader === 'boolean' ? { freezeHeader: sheet.freezeHeader } : {}),
        ...(typeof sheet.autoFilter === 'boolean' ? { autoFilter: sheet.autoFilter } : {}),
        ...(typeof sheet.boldHeader === 'boolean' ? { boldHeader: sheet.boldHeader } : {}),
      }
    }),
  }
}

/**
 * Merge into a parsed sheet specification. Values land inside the structure,
 * not inside its JSON source, so nothing has to be escaped and a value can
 * never break the spec. A cell whose whole content is one placeholder becomes
 * a real number when the value reads as one, so formats and formulas work.
 */
export function mergeSheetSpec(
  workbook: TemplateWorkbook,
  values: Record<string, string>,
): MergeOutcome<TemplateWorkbook> {
  const filled: string[] = []
  const unfilled: string[] = []

  const mergeCell = (cell: string | number | boolean | null): string | number | boolean | null => {
    if (typeof cell !== 'string') return cell
    const whole = cell.match(/^\s*\{\{\s*([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*\}\}\s*$/)
    const merged = mergeText(cell, values)
    for (const name of merged.filled) if (!filled.includes(name)) filled.push(name)
    for (const name of merged.unfilled) if (!unfilled.includes(name)) unfilled.push(name)
    if (whole && whole[1] && supplied(values, whole[1])) {
      const raw = (values[whole[1]] ?? '').trim()
      if (raw !== '' && Number.isFinite(Number(raw))) return Number(raw)
    }
    return merged.value
  }

  const mergeString = (text: string): string => {
    const merged = mergeText(text, values)
    for (const name of merged.filled) if (!filled.includes(name)) filled.push(name)
    for (const name of merged.unfilled) if (!unfilled.includes(name)) unfilled.push(name)
    return merged.value
  }

  return {
    value: {
      sheets: workbook.sheets.map((sheet) => ({
        ...sheet,
        name: mergeString(sheet.name),
        columns: sheet.columns.map((column) => ({ ...column, header: mergeString(column.header) })),
        rows: sheet.rows.map((row) =>
          Object.fromEntries(Object.entries(row).map(([key, cell]) => [key, mergeCell(cell)])),
        ),
        ...(sheet.formulas
          ? { formulas: sheet.formulas.map((formula) => ({ ...formula, formula: mergeString(formula.formula) })) }
          : {}),
      })),
    },
    filled,
    unfilled,
  }
}

/** Every placeholder in a spreadsheet template, wherever it sits in the spec. */
export function sheetSpecPlaceholders(workbook: TemplateWorkbook): string[] {
  const parts: string[] = []
  for (const sheet of workbook.sheets) {
    parts.push(sheet.name)
    for (const column of sheet.columns) parts.push(column.header)
    for (const row of sheet.rows) {
      for (const cell of Object.values(row)) if (typeof cell === 'string') parts.push(cell)
    }
    for (const formula of sheet.formulas ?? []) parts.push(formula.formula)
  }
  return findPlaceholders(parts.join('\n'))
}
