# Remote computers

An agent's Desk is its Bunkhouse-owned working machine. A remote computer is an existing customer machine that Bunkhouse reaches directly over RDP, VNC, SSH, WinRM, PowerShell-over-SSH, or Telnet. They are deliberately separate work surfaces: Desk remains available at all times, while Browser, Call, Terminal, and the active remote computer follow the agent's current work in chat and calls.

## Operator contract

Company Settings → Features contains the one `remoteComputers` switch. Library → Computers contains the records themselves: network address, protocol, account, sealed credential, last successful check, status, and last error. Turning the feature off preserves records and immutable history but the server refuses new sessions, control, commands, and viewer grants.

Disabling a computer is non-destructive. It blocks future sessions without deleting sessions or evidence already attached to runs.

## Runtime contract

Agents receive four ability families only while the feature is enabled:

- list and open a configured computer;
- drive its RDP/VNC screen programmatically, receiving the resulting frame after each action;
- run SSH, WinRM, PowerShell-over-SSH, or Telnet commands directly even while the visual desktop remains open;
- close the session when the task or human handover is actually finished, not merely when the model becomes idle.

A manager's reasonable direct request is a valid reason to use these tools. The autonomy dial remains the hard boundary: graphical access is governed as Desktop screen and remote terminal access as Sandbox machine.

## Evidence and isolation

`remote_sessions` is run- and person-bound. Lease grants and events are append-only tables protected by immutable database triggers. Per-session counters allocate event sequence and lease fence numbers atomically. Every remote table has forced tenant RLS, and composite tenant foreign keys prevent a known id from being used to attach one tenant's child row to another tenant's computer or session.

Viewer connections are never stored. An authenticated chat action appends an observation lease and exchanges it for a short-lived, encrypted Apache Guacamole connection. Credentials are unsealed only inside the server adapter and never enter an agent prompt, tool result, browser payload, or event record.

The reusable provider/session/service/viewer contract, Guacamole bridge, and graphical terminal live in `@braedonsaunders/appkit-remote-sessions`. Bunkhouse owns PostgreSQL persistence, tenant authorization, feature and autonomy policy, and its deployment-owned gateway. The gateway and its `guacd` sidecar ship in the Bunkhouse deployment; there is no Steward service or Steward runtime dependency.

## Work surface

Chat and calls use one work-surface vocabulary. Browser screencasts and the agent Desk use their existing LiveKit path, customer RDP/VNC sessions use the Guacamole path, and both Desk shell commands and remote commands render through the same read-only terminal component from their durable event ledgers. The current surface follows the agent automatically without removing the separately selectable Desk tab.
