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
    description:
      'X11 compatibility for a Wayland session (§3.9). Inert in the shipped desk: XFCE 4.18 '
      + 'is X11-native, so the session is Xvfb + XFCE and X11 software runs natively — '
      + 'XWayland exists for the reverse direction. Kept installed so a future Wayland '
      + 'session needs no image change.',
    sourceKind: 'apt-package',
    risk: 'low',
    aptPackage: 'xwayland',
    aptVersion: '2:22.1.9-1',
    capabilities: ['desktop'],
    bins: [{ name: 'Xwayland', bin: 'Xwayland', healthCheckArgs: ['-version'] }],
  }),
  // --- the desktop tier's own drivers (§3.10, §3.13, §3.14) -----------------
  // Everything the in-guest agent shells out to when a screen is open. Each is
  // here because one handler cannot work without it; see
  // deploy/desk-image/agent/desk-guest-agent.mjs.
  defineAgentTool({
    id: 'xvfb',
    name: 'Xvfb',
    description:
      'The headless X server the desk session runs on. screenStart brings it up on :99 at '
      + 'exactly the requested size, which is what makes the coordinate contract identity: '
      + 'the framebuffer, the screenshot and the input space are all the same pixels (§5.1).',
    sourceKind: 'apt-package',
    risk: 'low',
    aptPackage: 'xvfb',
    aptVersion: '2:21.1.7-3+deb12u7',
    capabilities: ['desktop'],
    bins: [{ name: 'Xvfb', bin: 'Xvfb', healthCheckArgs: ['-help'] }],
  }),
  defineAgentTool({
    id: 'x11-utils',
    name: 'X11 utilities',
    description:
      'xdpyinfo and xprop. screenStart polls xdpyinfo to know the display is genuinely up '
      + 'before it starts the session, and xprop tells it whether a window manager took the '
      + 'root — without those probes a failed start looks like a hang.',
    sourceKind: 'apt-package',
    risk: 'low',
    aptPackage: 'x11-utils',
    aptVersion: '7.7+5',
    capabilities: ['desktop'],
    bins: [{ name: 'xdpyinfo', bin: 'xdpyinfo', healthCheckArgs: ['-version'] }],
  }),
  defineAgentTool({
    id: 'xdotool',
    name: 'xdotool',
    description:
      'Input injection: move, click, type, key, scroll and drag all become xdotool calls '
      + 'against :99, in observe()\'s pixel space one to one. Also reports the focused window.',
    sourceKind: 'apt-package',
    risk: 'low',
    aptPackage: 'xdotool',
    aptVersion: '1:3.20211022.1-2',
    capabilities: ['desktop'],
    bins: [{ name: 'xdotool', bin: 'xdotool', healthCheckArgs: ['--version'] }],
  }),
  defineAgentTool({
    id: 'wmctrl',
    name: 'wmctrl',
    description:
      'The EWMH window list behind observe().windows — window ids, titles and the pid each '
      + 'belongs to. Failing to list windows never fails an observation: perception is '
      + 'pixels-primary (§3.10).',
    sourceKind: 'apt-package',
    risk: 'low',
    aptPackage: 'wmctrl',
    aptVersion: '1.07-7',
    capabilities: ['desktop'],
    bins: [{ name: 'wmctrl', bin: 'wmctrl', healthCheckArgs: ['-m'] }],
  }),
  defineAgentTool({
    id: 'imagemagick',
    name: 'ImageMagick',
    description:
      'Provides `import`, which captures the root window of :99 as an UNSCALED PNG. Both '
      + 'observe() and the frame loop go through it; the PNG\'s own IHDR is what the '
      + 'observation reports as its dimensions.',
    sourceKind: 'apt-package',
    risk: 'low',
    aptPackage: 'imagemagick',
    aptVersion: '8:6.9.11.60+dfsg-1.6+deb12u1',
    capabilities: ['desktop'],
    bins: [{ name: 'import', bin: 'import', healthCheckArgs: ['-version'] }],
  }),
  defineAgentTool({
    id: 'xclip',
    name: 'xclip',
    description: 'The guest side of clipboardRead/clipboardWrite on the CLIPBOARD selection.',
    sourceKind: 'apt-package',
    risk: 'low',
    aptPackage: 'xclip',
    aptVersion: '0.13-2',
    capabilities: ['desktop'],
    bins: [{ name: 'xclip', bin: 'xclip', healthCheckArgs: ['-version'] }],
  }),
  defineAgentTool({
    id: 'x11vnc',
    name: 'x11vnc',
    description:
      'The handover server (§3.14). Bound to 127.0.0.1 inside the guest only — the runner '
      + 'owns exposing it outward — with a guest-side TTL that revokes it even if the host '
      + 'never calls handoverEnd, and -viewonly when the scope is view.',
    sourceKind: 'apt-package',
    risk: 'medium',
    aptPackage: 'x11vnc',
    aptVersion: '0.9.16-8',
    capabilities: ['desktop'],
    bins: [{ name: 'x11vnc', bin: 'x11vnc', healthCheckArgs: ['-version'] }],
  }),
  defineAgentTool({
    id: 'at-spi2-core',
    name: 'AT-SPI',
    description:
      'The accessibility bus. Its bus launcher is started with the session so GTK and Qt '
      + 'applications expose their trees; when it is absent observe() simply returns '
      + 'a11y: null and the pixels are unaffected (§3.10).',
    sourceKind: 'apt-package',
    risk: 'low',
    aptPackage: 'at-spi2-core',
    aptVersion: '2.46.0-5',
    capabilities: ['desktop', 'accessibility'],
    bins: [{ name: 'at-spi-bus-launcher', bin: '/usr/libexec/at-spi-bus-launcher' }],
  }),
  defineAgentTool({
    id: 'python3-pyatspi',
    name: 'pyatspi',
    description:
      'The AT-SPI client binding used by /opt/desk-agent/atspi-dump.py, which reads the '
      + 'focused window\'s tree as JSON under bounded depth, node count and time. The guest '
      + 'agent itself stays node-built-ins-only; this is its one subprocess helper.',
    sourceKind: 'apt-package',
    risk: 'low',
    aptPackage: 'python3-pyatspi',
    aptVersion: '2.46.0-1',
    capabilities: ['desktop', 'accessibility'],
    bins: [{ name: 'python3', bin: 'python3', healthCheckArgs: ['--version'] }],
  }),
  defineAgentTool({
    id: 'dbus-x11',
    name: 'dbus-launch',
    description:
      'Starts the per-session D-Bus that XFCE and AT-SPI both need. Without a session bus '
      + 'xfce4-session does not come up and no application exposes an accessibility tree.',
    sourceKind: 'apt-package',
    risk: 'low',
    aptPackage: 'dbus-x11',
    aptVersion: '1.14.10-1~deb12u1',
    capabilities: ['desktop'],
    bins: [{ name: 'dbus-launch', bin: 'dbus-launch', healthCheckArgs: ['--version'] }],
  }),
  defineAgentTool({
    id: 'xfce4-settings',
    name: 'XFCE settings daemon',
    description:
      'xfsettingsd — theming, fonts and input settings for the session. The agent starts it '
      + 'directly if xfce4-session did not, so a desk is never left without one.',
    sourceKind: 'apt-package',
    risk: 'low',
    aptPackage: 'xfce4-settings',
    aptVersion: '4.18.2-1',
    capabilities: ['desktop'],
    bins: [{ name: 'xfsettingsd', bin: 'xfsettingsd', healthCheckArgs: ['--version'] }],
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
