# Contributing

Cecil is a personal assistant with persistent memory. See the [README](README.md) for what it does and the [docs/](docs/) for architecture and conventions.

## Setup

```bash
npm install
docker compose up -d
cp .env.example .env    # configure your LLM endpoint
npm run dev
```

## Before You Submit

```bash
npm run lint
npx tsc --noEmit
npx tsx scripts/test-v2.ts   # if you touched memory/recall behavior
```

## What's Most Valuable

1. **Memory quality** — Better observer synthesis, fact extraction, provenance handling
2. **Retrieval quality** — Better ranking, dedup, token budgeting, evidence tier handling
3. **New integrations** — Slack adapter, Telegram adapter, new ingestion pipelines
4. **Inspectability** — Better debugging tools, memory browsing, audit output
5. **Reliability** — Safer write paths, better startup diagnostics, error handling

## Guidelines

- Keep changes focused. Don't re-architect the whole system in one PR.
- Prefer extending existing patterns over creating parallel systems.
- Preserve existing behavior unless the change is explicitly meant to alter it.
- If adding a new capability, wire it into `cecil/client.ts`, the API routes, and the MCP server.
- See [docs/conventions.md](docs/conventions.md) for code style and naming.

## Pull Requests

Include:
- What changed and why
- How you tested it
- Whether memory or recall behavior changed

## License

By contributing, you agree your contributions are licensed under Apache 2.0.
