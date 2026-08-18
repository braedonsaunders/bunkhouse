# Remote computers

An agent's Desk is its Bunkhouse-owned working machine. A remote computer is an existing customer machine reached through Steward. They are deliberately separate work surfaces: the Desk remains available at all times, while Browser, Call, and each active remote computer appear as their own subtabs beside it in chat.

## Operator contract

Company Settings → Features contains the one `remoteComputers` switch. Company Settings → Remote computers contains the records themselves: Steward URL and device id, network address, protocol, sealed API token, last successful check, status, and last error. Turning the feature off preserves records and immutable history but the server refuses new sessions, control, commands, and viewer grants.

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

Viewer URLs are never stored. An authenticated chat action appends an observation lease and exchanges it for a short-lived Steward viewer URL. Provider credentials are unsealed only inside the server adapter and never enter an agent prompt, tool result, browser payload, or event record.

The reusable provider/session/service/viewer contract lives in `@braedonsaunders/appkit-remote-sessions`; Bunkhouse owns PostgreSQL persistence, tenant authorization, feature and autonomy policy, and the Steward adapter.
