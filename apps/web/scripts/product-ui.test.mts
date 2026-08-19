import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SUPPORTED_LOCALES } from '@braedonsaunders/appkit-i18n'
import {
  PRODUCT_CATALOGUES,
  resolveLocalePolicy,
  type ProductMessageKey,
} from '../src/lib/product-locales'

const sourceRoot = fileURLToPath(new URL('../src', import.meta.url))

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

const uiFiles = filesUnder(sourceRoot).filter((path) => /\.(?:tsx|jsx|css)$/.test(path))
const failures: string[] = []

// Native buttons are legitimate for canvas hotspots, compact chip actions,
// table rows and other semantics AppKit's Button intentionally does not own.
// The list makes every exception reviewable and prevents silent design-system
// drift into new files.
const nativeButtonExceptions = new Set([
  'app/dev-scene/departments/page.tsx',
  'app/dev-scene/floor/page.tsx',
  'components/agent-record-page.tsx',
  'components/autonomy-settings.tsx',
  'components/backdrop-studio.tsx',
  'components/chat-work-surface.tsx',
  'components/chat-workspace.tsx',
  'components/company-identity-settings.tsx',
  'components/departments-settings.tsx',
  'components/lobby.tsx',
  'components/markdown-editor.tsx',
  'components/notes-view.tsx',
  'components/person-account-form.tsx',
  'components/person-drawer.tsx',
  'components/phone-system.tsx',
  'components/procedure-editor.tsx',
  'components/procedures-view.tsx',
  'components/roles-view.tsx',
  'components/schedule-builder.tsx',
  'components/skills-view.tsx',
  'components/systems-view.tsx',
])

const rawPaletteUtility = /(?:bg|text|border|ring|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/
const arbitraryColourUtility = /(?:bg|text|border|ring|fill|stroke)-\[(?:#|rgb\(|hsl\()/

for (const path of uiFiles) {
  const rel = relative(sourceRoot, path).replaceAll('\\', '/')
  const source = readFileSync(path, 'utf8')
  if (/<textarea\b/.test(source)) failures.push(`${rel}: use the AppKit rich-text editor for prose`)
  if (/<select\b/.test(source)) failures.push(`${rel}: use AppKit Select instead of a native select`)
  if (rawPaletteUtility.test(source) || arbitraryColourUtility.test(source)) {
    failures.push(`${rel}: use semantic AppKit tokens instead of a raw colour utility`)
  }
  if (/<button\b/.test(source) && !nativeButtonExceptions.has(rel)) {
    failures.push(`${rel}: use AppKit Button or add a reviewed semantic exception`)
  }
}

assert.deepEqual(failures, [], `Product UI audit failed:\n${failures.join('\n')}`)

const englishKeys = Object.keys(PRODUCT_CATALOGUES.en).sort() as ProductMessageKey[]
for (const locale of SUPPORTED_LOCALES) {
  const catalogue = PRODUCT_CATALOGUES[locale]
  assert.deepEqual(Object.keys(catalogue).sort(), englishKeys, `${locale} catalogue must match English keys`)
  for (const key of englishKeys) {
    assert.ok(catalogue[key].trim(), `${locale}.${key} must not be empty`)
  }
}

assert.deepEqual(resolveLocalePolicy(null), { defaultLocale: 'en', enabledLocales: ['en'] })
assert.deepEqual(
  resolveLocalePolicy({ defaultLocale: 'fr', enabledLocales: ['es', 'unknown'] }),
  { defaultLocale: 'fr', enabledLocales: ['fr', 'es'] },
)

console.log(`product-ui: audited ${uiFiles.length} UI files and ${englishKeys.length} translated core messages`)
