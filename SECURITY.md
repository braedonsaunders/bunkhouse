# Security policy

Bunkhouse is alpha software. Do not place production credentials or irreplaceable company data on an unreviewed deployment.

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Use GitHub's private vulnerability reporting for this repository and include the affected version or commit, reproduction steps, impact, and any suggested mitigation. You should receive an acknowledgement within three business days.

## Deployment responsibilities

Operators are responsible for TLS, network policy, secret management, database and object-storage backups, restore testing, provider-key scope, retention, and timely upgrades. Use separate PostgreSQL roles for the RLS application connection and the narrowly held `BYPASSRLS` system connection. Keep `APPKIT_SECRET`, `BETTER_AUTH_SECRET`, mailbox credentials, and provider keys out of source control.

Browser use, shell access, outbound communication, money-adjacent actions, and record writes must remain governed by the per-agent autonomy controls. Review recorded sessions and pending approvals before increasing autonomy.

Supported fixes land on `main`; no long-term security support window is promised before a stable release.


## Dependency audit exceptions

The deploy gate runs `pnpm audit --prod --audit-level high`. These advisories are ignored in `package.json` (`pnpm.auditConfig.ignoreGhsas`) because Bunkhouse's configuration does not meet their preconditions. Each one is re-checked before it is removed, and **adding any of the listed features re-opens it**.

| Advisory | Affects | Why Bunkhouse is not exposed |
| --- | --- | --- |
| [GHSA-965c-763c-88jm](https://github.com/advisories/GHSA-965c-763c-88jm) (critical) | better-auth < 1.7.7: an OAuth state is accepted as a Magic Link token | Requires Magic Link **and** a social or Generic OAuth provider. appkit-auth enables Magic Link with `storeToken: 'hashed'` (default plain `storeIdentifier`) and configures no social or OAuth providers. |
| [GHSA-r4xp-prcw-77qf](https://github.com/advisories/GHSA-r4xp-prcw-77qf) (high) | better-auth < 1.7.7 with the OAuth Proxy plugin | The OAuth Proxy plugin is not enabled. |
| [GHSA-q84f-53jg-9ppm](https://github.com/advisories/GHSA-q84f-53jg-9ppm) (high) | better-auth < 1.7.0-rc.3 with `deviceAuthorization()` | The device authorization plugin is not enabled. |

The real fix is better-auth ≥ 1.7.7. 1.7 re-keys accounts on `(issuer, accountId)` and needs the account-identity backfill from its upgrade guide, so it belongs in appkit-auth's shared identity schema rather than in a Bunkhouse-only bump. Remove these entries when that upgrade lands.
