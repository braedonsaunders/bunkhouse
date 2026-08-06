import { createMCPClient } from '@ai-sdk/mcp'
import type { ToolSet } from 'ai'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Ability } from './abilities'
import { isNetsuiteMcp, shimNetsuiteTools } from './netsuite-shim'
import type { ActionCategory } from './types'

/**
 * External systems connect over MCP — OpenBooks, a POS, a CRM, anything.
 * Servers are tenant-configured; every tool a server exposes is governed
 * under one action category chosen when the connection is set up (default
 * 'record_write' — the safe assumption for an unknown integration).
 */
export type McpServerConfig = {
  /** Stable slug for the connection, used to namespace tool names. */
  slug: string
  url: string
  headers?: Record<string, string>
  category?: ActionCategory
}

export type McpConnection = {
  abilities: Ability[]
  close: () => Promise<void>
}

export async function connectMcpServers(configs: McpServerConfig[]): Promise<McpConnection> {
  const clients: { close: () => Promise<void> }[] = []
  const abilities: Ability[] = []

  for (const config of configs) {
    const client = await createMCPClient({
      transport: new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      }),
    })
    clients.push(client)
    let tools: ToolSet = await client.tools()
    // NetSuite's hosted MCP answers some failures with a generic line and
    // demands parameters with only one possible value; the shim smooths both
    // before the tools reach any model. See netsuite-shim.ts for the receipts.
    if (isNetsuiteMcp(config.url)) tools = shimNetsuiteTools(tools)
    for (const [name, tool] of Object.entries(tools)) {
      abilities.push({
        name: `${config.slug}_${name}`,
        category: config.category ?? 'record_write',
        tool,
      })
    }
  }

  return {
    abilities,
    close: async () => {
      await Promise.all(clients.map((c) => c.close()))
    },
  }
}
