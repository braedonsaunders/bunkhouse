# Operations, backup, and recovery

Treat PostgreSQL and the configured S3-compatible bucket as one backup set. Redis contains queues and coordination, not the system of record; after Redis loss the database-backed mail, duty, assignment, and approval discovery passes republish unfinished work.

## Backup

1. Put the deployment into a maintenance window or otherwise quiesce writes.
2. Record the deployed image tag and migration head.
3. Create a PostgreSQL custom-format dump with `pg_dump --format=custom --no-owner`.
4. Version or snapshot the entire object-storage bucket, including file metadata.
5. Snapshot the agent-workspace volume if retained workspace contents are required by policy.
6. Encrypt the backup, store it outside the deployment, and record its checksum and retention date.

Never place credentials in a command committed to the repository. Supply connection strings through the shell environment or a secret manager.

## Restore test

Restore into an isolated PostgreSQL database and empty bucket, point a disposable Bunkhouse deployment at both, run the migrations, and verify:

- sign-in and tenant isolation;
- directory, mail threads, run timelines, approvals, and token-spend totals;
- retrieval of representative attachments and recorded session artifacts;
- provider secrets can be unsealed with the restored `APPKIT_SECRET`; and
- the worker republishes pending work once without duplicating completed work.

Run this exercise on a schedule. A backup is not accepted until a restore has been demonstrated.

## Upgrade and rollback

Migrations are additive and checksummed. Back up first, deploy the new image, run migrations once, and verify web and worker health. Application rollback is safe only while the older image understands the migrated schema; schema rollback is performed by a tested forward corrective migration, never by editing migration history or deleting tenant data.

## Release and platform support

Tag releases publish one immutable OCI image manifest for `linux/amd64` and `linux/arm64`. Docker chooses the host architecture automatically; the quickstart does not pin an emulated platform. Each release manifest carries a software bill of materials and signed build provenance, and records the release tag and Git revision in OCI labels. Company Settings → Health shows that exact identity and the running platform.

The Node workspace is independently gated on Linux, macOS, and Windows. That matrix covers install, typechecking, lint, and unit tests. Production services run in the Linux OCI image; macOS and Windows are supported operator/developer hosts through Docker Desktop. The optional agent desk still requires Linux with KVM and remains unavailable on Docker Desktop.
