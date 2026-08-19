# Pinned AppKit package

These are compiled packages from AppKit commit `05f281b688b5e4bef434dee2642032049ce0a963` (AGPL-3.0-or-later):

- `braedonsaunders-appkit-ai-1.1.0-05f281b688b5.tgz` — the queue/session UI contract used by Bunkhouse chat; publication is awaiting registry authentication.
- `braedonsaunders-appkit-sync-1.1.0-05f281b688b5.tgz` — the dependency declared by published Jobs 0.2.1 but absent from the public registry.

Keeping the exact compiled packages in the public source tree makes clean and offline-verifiable installs deterministic across hosts. Remove each root override and artifact after its matching version is available from the registry.

- AI SHA-256: `b6c48b7720b26fd25cb5b1ac59b2539b6cf8b734aa774f54f121f3936608056f`
- Sync SHA-256: `a382a449fca82abe3f987ccdb9e956e03ab631b25d6d03499d928c08457d8201`
