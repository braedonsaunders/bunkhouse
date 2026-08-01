# Security policy

Bunkhouse is alpha software. Do not place production credentials or irreplaceable company data on an unreviewed deployment.

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Use GitHub's private vulnerability reporting for this repository and include the affected version or commit, reproduction steps, impact, and any suggested mitigation. You should receive an acknowledgement within three business days.

## Deployment responsibilities

Operators are responsible for TLS, network policy, secret management, database and object-storage backups, restore testing, provider-key scope, retention, and timely upgrades. Use separate PostgreSQL roles for the RLS application connection and the narrowly held `BYPASSRLS` system connection. Keep `APPKIT_SECRET`, `BETTER_AUTH_SECRET`, mailbox credentials, and provider keys out of source control.

Browser use, shell access, outbound communication, money-adjacent actions, and record writes must remain governed by the per-agent autonomy controls. Review recorded sessions and pending approvals before increasing autonomy.

Supported fixes land on `main`; no long-term security support window is promised before a stable release.

