import { defineAgentTool, type AgentToolManifest } from '@appkit/agent-tools'
import { imageManifest, renderAptInstallFragment, type ImageManifest } from '@appkit/agent-tools/image-manifest'
import { TOOL_CATALOGUE } from './tool-catalogue'

export { TOOL_CATALOGUE }

/**
 * What the golden base image contains, declared the way the tool shelf is
 * (docs/agent-desk.md §3.16): `defineAgentTool` manifests with exact pinned
 * versions, health checks, and an operator-visible listing. The install and
 * execute gates that @appkit/agent-tools also offers do not sit on the desk's
 * agent path — an agent with a root terminal walks around them in one line
 * (§3.22) — but pinning, health, and revocability never depended on the gate,
 * and the manifest is now the single declaration the image build consumes.
 *
 * Deliberately short (§6.2). Every entry is a Debian bookworm package baked in
 * at image build; the runtime never installs any of these.
 *
 * Version pins: plausible current bookworm versions. The image build verifies
 * every pin against the snapshot mirror it builds from and fails loudly on a
 * mismatch — the mechanism (exact pins, verified at build) is the contract;
 * the strings below are refreshed whenever the base image is rebuilt.
 */
export const BASE_IMAGE_TOOLS: readonly AgentToolManifest[] = [
  defineAgentTool({
    id: 'xfce4',
    name: 'XFCE desktop',
    description:
      'The desktop environment, installed but not running until open_desktop starts it. '
      + 'XFCE over LXQt for now: these models were trained on screenshots of conventional '
      + 'desktops and XFCE is the most conventional of them — §9 defers the final call to '
      + 'measured footprint when the base image is built.',
    sourceKind: 'apt-package',
    risk: 'low',
    aptPackage: 'xfce4',
    aptVersion: '4.18',
    capabilities: ['desktop'],
    bins: [{ name: 'xfce4-session', bin: 'xfce4-session', healthCheckArgs: ['--version'] }],
  }),
  defineAgentTool({
    id: 'xwayland',
    name: 'XWayland',
    description: 'X11 compatibility for the desktop session — required for X11-only software (§3.9).',
    sourceKind: 'apt-package',
    risk: 'low',
    aptPackage: 'xwayland',
    aptVersion: '2:22.1.9-1',
    capabilities: ['desktop'],
    bins: [{ name: 'Xwayland', bin: 'Xwayland', healthCheckArgs: ['-version'] }],
  }),
  defineAgentTool({
    id: 'chromium',
    name: 'Chromium',
    description:
      'The agent\'s browser, headless by default with a persistent profile in the guest home. '
      + 'browser_* connect to it over the desk-runner\'s CDP relay.',
    sourceKind: 'apt-package',
    risk: 'medium',
    aptPackage: 'chromium',
    aptVersion: '120.0.6099.224-1~deb12u1',
    requiresNetwork: true,
    capabilities: ['browser'],
    bins: [{ name: 'chromium', bin: 'chromium', healthCheckArgs: ['--version'] }],
  }),
  defineAgentTool({
    id: 'xfce4-terminal',
    name: 'Terminal',
    description: 'A terminal emulator for the desktop session; run_shell itself goes over vsock.',
    sourceKind: 'apt-package',
    risk: 'low',
    aptPackage: 'xfce4-terminal',
    aptVersion: '1.0.4-1',
    capabilities: ['desktop'],
    bins: [{ name: 'xfce4-terminal', bin: 'xfce4-terminal', healthCheckArgs: ['--version'] }],
  }),
  defineAgentTool({
    id: 'thunar',
    name: 'File manager',
    description: 'The desktop file manager — part of what makes a general-purpose desk usable (§3.9).',
    sourceKind: 'apt-package',
    risk: 'low',
    aptPackage: 'thunar',
    aptVersion: '4.18.4-1',
    capabilities: ['desktop', 'files'],
    bins: [{ name: 'thunar', bin: 'thunar', healthCheckArgs: ['--version'] }],
  }),
  defineAgentTool({
    id: 'libreoffice',
    name: 'LibreOffice',
    description:
      'Office suite for files that arrive in office formats. For CREATING documents and '
      + 'spreadsheets, the tier-0 abilities are better at the job and always will be.',
    sourceKind: 'apt-package',
    risk: 'low',
    aptPackage: 'libreoffice',
    aptVersion: '4:7.4.7-1+deb12u8',
    capabilities: ['documents', 'spreadsheets'],
    bins: [{ name: 'libreoffice', bin: 'libreoffice', healthCheckArgs: ['--version'] }],
  }),
  defineAgentTool({
    id: 'git',
    name: 'Git',
    description: 'Version control in the guest — clone, diff, commit inside the agent\'s home.',
    sourceKind: 'apt-package',
    risk: 'low',
    aptPackage: 'git',
    aptVersion: '1:2.39.5-0+deb12u2',
    requiresNetwork: true,
    capabilities: ['development'],
    bins: [{ name: 'git', bin: 'git', healthCheckArgs: ['--version'] }],
  }),
]

/**
 * Everything the golden image must contain: the desk's own apt packages plus
 * the existing npm tool catalogue, folded into deterministic build input.
 */
export function baseImageManifest(): ImageManifest {
  return imageManifest([...BASE_IMAGE_TOOLS, ...TOOL_CATALOGUE])
}

/** The exact-versioned `apt-get install` fragment for the image build. */
export function renderBaseImageAptFragment(): string {
  return renderAptInstallFragment([...BASE_IMAGE_TOOLS, ...TOOL_CATALOGUE])
}
