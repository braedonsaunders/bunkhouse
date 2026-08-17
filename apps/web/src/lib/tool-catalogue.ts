import { defineAgentTool, type AgentToolManifest } from '@braedonsaunders/appkit-agent-tools'

/**
 * The tools this company trusts, pinned to exact versions.
 *
 * Every entry is a pure-JavaScript CLI: installs run with lifecycle scripts
 * disabled, so a package that downloads a binary in postinstall cannot be
 * managed this way — it belongs in the image instead.
 */
export const TOOL_CATALOGUE: readonly AgentToolManifest[] = [
  defineAgentTool({
    id: 'prettier',
    name: 'Prettier',
    description:
      'Format JSON, YAML, Markdown, HTML, CSS, and JavaScript files so they are consistent and readable.',
    sourceKind: 'npm-package',
    risk: 'low',
    packageName: 'prettier',
    packageVersion: '3.9.6',
    docsUrl: 'https://prettier.io/docs/en/cli',
    capabilities: ['formatting', 'documents'],
    bins: [{ name: 'prettier', bin: 'prettier', healthCheckArgs: ['--version'] }],
    limits: { cpuSeconds: 60, addressSpaceBytes: 1_073_741_824, processes: 32 },
  }),
  defineAgentTool({
    id: 'csvtojson',
    name: 'CSV to JSON',
    description:
      'Convert a CSV or delimited file into JSON so its rows can be read, filtered, and totalled.',
    sourceKind: 'npm-package',
    risk: 'low',
    packageName: 'csvtojson',
    packageVersion: '2.0.14',
    docsUrl: 'https://github.com/Keyang/node-csvtojson',
    capabilities: ['data', 'spreadsheets'],
    bins: [{ name: 'csvtojson', bin: 'csvtojson', healthCheckArgs: ['--help'] }],
    limits: { cpuSeconds: 120, addressSpaceBytes: 2_147_483_648, processes: 32 },
  }),
  defineAgentTool({
    id: 'marked',
    name: 'Marked',
    description: 'Render a Markdown file to HTML.',
    sourceKind: 'npm-package',
    risk: 'low',
    packageName: 'marked',
    packageVersion: '18.0.7',
    docsUrl: 'https://marked.js.org/using_pro#cli',
    capabilities: ['documents', 'formatting'],
    bins: [{ name: 'marked', bin: 'marked', healthCheckArgs: ['--version'] }],
    limits: { cpuSeconds: 60, addressSpaceBytes: 1_073_741_824, processes: 16 },
  }),
  defineAgentTool({
    id: 'js-yaml',
    name: 'YAML reader',
    description: 'Parse a YAML file and print it as JSON, or check that it is valid.',
    sourceKind: 'npm-package',
    risk: 'low',
    packageName: 'js-yaml',
    packageVersion: '5.2.2',
    docsUrl: 'https://github.com/nodeca/js-yaml',
    capabilities: ['data'],
    bins: [{ name: 'js-yaml', bin: 'js-yaml', healthCheckArgs: ['--help'] }],
    limits: { cpuSeconds: 30, addressSpaceBytes: 536_870_912, processes: 16 },
  }),
  defineAgentTool({
    id: 'qrcode',
    name: 'QR code',
    description: 'Generate a QR code image or terminal rendering from text such as a URL.',
    sourceKind: 'npm-package',
    risk: 'low',
    packageName: 'qrcode',
    packageVersion: '1.5.4',
    docsUrl: 'https://github.com/soldair/node-qrcode#cli',
    capabilities: ['images', 'documents'],
    bins: [{ name: 'qrcode', bin: 'qrcode', healthCheckArgs: ['--help'] }],
    limits: { cpuSeconds: 30, addressSpaceBytes: 536_870_912, processes: 16 },
  }),
  defineAgentTool({
    id: 'svgo',
    name: 'SVG optimizer',
    description: 'Shrink an SVG file without changing how it looks.',
    sourceKind: 'npm-package',
    risk: 'low',
    packageName: 'svgo',
    packageVersion: '4.0.2',
    docsUrl: 'https://svgo.dev/docs/command-line-usage/',
    capabilities: ['images'],
    bins: [{ name: 'svgo', bin: 'svgo', healthCheckArgs: ['--version'] }],
    limits: { cpuSeconds: 60, addressSpaceBytes: 1_073_741_824, processes: 16 },
  }),
]
