/**
 * Managed command-line tools an agent may install and run.
 *
 * The shell ability gives an agent whatever the image already ships. This is
 * the shelf above it: named tools, each with a pinned version, a declared risk,
 * and its own health. Adding `ripgrep` to an agent's reach is a catalogue entry
 * an operator can see and revoke, not a Dockerfile change nobody remembers.
 *
 * The tables, the install and execution gates, and the sandboxed runtime are
 * @braedonsaunders/appkit-agent-tools. Bunkhouse owns which tools it trusts and which agents
 * may reach them; the package owns the governing.
 */
export {
  agentToolApprovals,
  agentToolRuns,
  agentTools,
} from '@braedonsaunders/appkit-agent-tools/schema'

export const TOOLS_TENANT_TABLES = [
  'agent_tools',
  'agent_tool_approvals',
  'agent_tool_runs',
] as const
