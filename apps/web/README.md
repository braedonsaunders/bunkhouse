# Bunkhouse web

The Next.js application, HTTP APIs, background worker, voice agent, migrations,
and deployment entrypoints for Bunkhouse. It is built on the published
[`@braedonsaunders/appkit-*`](https://github.com/braedonsaunders/appkit)
packages; the root [README](../../README.md) describes the product and the
one-command Docker quickstart.

## Development

```bash
pnpm install
pnpm --filter web db:migrate
pnpm dev
```

Run the worker separately with `pnpm --filter web worker`; the optional voice
plane uses `pnpm --filter web voice-agent`. See [Contributing](../../CONTRIBUTING.md)
for the full local stack and required validation gates.
