# Conventions

## Code Style

- TypeScript for all protocol code
- Python for transcription scripts only
- Small, inspectable functions over large abstractions
- Comments only when the logic isn't obvious
- No unnecessary type annotations on obvious locals
- Prefer extending existing paths over creating parallel systems

## Project Structure

```
cecil/           Core memory engine and AI logic
app/api/         Next.js API routes
app/             Next.js frontend
discord/         Discord bot integration
onboarding/      Optional onboarding flow
scripts/         CLI tools
docs/            Documentation
identity/        Runtime identity files (gitignored)
memory/          Runtime memory data (gitignored)
```

## Naming

- Files: `kebab-case.ts`
- Functions: `camelCase`
- Types/interfaces: `PascalCase`
- Constants: `UPPER_SNAKE_CASE` for true constants, `camelCase` for config-like values
- Memory keys: `type:source:id` (e.g., `conversation:session-123`, `fact:client:abc123`)

## Memory Types

| Type | Source | Description |
|---|---|---|
| `conversation` | Chat sessions | Full session text |
| `observation` | Observer synthesis | Pattern detection results |
| `fact` | Fact extraction | Extracted from transcripts |
| `podcast` | Podcast ingestion | Transcript chunks |
| `milestone` | Fact extraction | Meaningful events/experiences |
| `seed` | Onboarding | Original identity baseline |

## Evidence Tiers

When adding new memory sources, assign the correct evidence tier:

| Tier | When to use |
|---|---|
| `DIRECT_STATEMENT` | User told you directly |
| `OBSERVED_PATTERN` | Detected from synthesis across sessions |
| `PUBLIC_CORPUS` | Extracted from public material |
| `INFERRED` | Synthesized from multiple signals |

## Adding New Modules

1. Put core logic in `cecil/`
2. Add a CLI script in `scripts/` if it should be runnable standalone
3. Add an API route in `app/api/` if it should be callable over HTTP
4. Add the tool to `cecil/mcp-server.ts` if it should be available via MCP
5. Add the method to `cecil/client.ts` so the universal client exposes it
6. Add an npm script to `package.json`

## Adding New Memory Sources

Follow the existing pattern:
1. Embed the content to Qdrant with appropriate metadata
2. Record to SQLite via `recordMemoryWrite()`
3. Write a human-readable markdown file to `memory/`
4. Set `sourceType` and `provenance` so evidence tiers resolve correctly

## Pull Requests

Include:
- What changed
- Why it changed
- How you tested it
- Whether memory or recall behavior changed

Small, focused PRs over broad speculative ones.

## Validation Before Committing

```bash
npm run lint
npx tsc --noEmit
```

If you touched memory behavior:
```bash
npm run memory:audit
npx tsx scripts/test-v2.ts
```
