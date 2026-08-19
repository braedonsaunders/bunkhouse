# Agent Client Protocol boundary

Bunkhouse uses [Agent Client Protocol v1](https://agentclientprotocol.com/protocol/overview) as the seam between an agent experience and the employee runtime. The boundary is a real package, `@bunkhouse/acp`, rather than a diagram or a web-only callback convention.

## Ownership

| Layer | Owns | Must not own |
| --- | --- | --- |
| Client experience | session navigation, prompt input, rendering text and tool activity, stop controls | providers, tool execution, autonomy enforcement, budgets |
| ACP host | authenticated actor and tenant context, dispatch identity, transport adaptation | model-specific events, client components |
| Employee runtime | model loop, tools, procedures, memory, autonomy, approvals, metering | React, Next.js, database queries, client stream formats |

The current web host adapts ACP session notifications to the web panel's UI-message stream. That transport is authenticated and in-process on the server today; a desktop client or another transport can implement the same `AcpClient` interface without importing the runtime. Durable messages, run events, and tool evidence remain the source of truth. ACP notifications are presentation updates, not a second ledger.

## Mappings

| Runtime progress | ACP v1 session update | Client presentation |
| --- | --- | --- |
| text delta | `agent_message_chunk` | streaming answer text |
| tool call | `tool_call` with `in_progress` | governed activity card |
| tool result | `tool_call_update` with `completed` | completed activity card |

Bunkhouse-specific identity and governance types are explicit protocol extensions. The host supplies requester identity from the authenticated session; prompt text can never assert it. The autonomy categories exposed to an experience are defined in ACP while enforcement stays in the runtime.

An architecture test rejects runtime imports from every client component and keeps the ACP package free of UI, framework, provider, and server dependencies. Company Settings → Health shows the active ACP version and capabilities.
