# Contributing to Cecil v1.2

Cecil is a persistent memory and identity protocol for AI systems.

This repo is not just a chat UI. It includes:

- web chat and onboarding
- identity files
- Qdrant semantic retrieval
- SQLite structured memory
- observer synthesis
- deep search
- Discord integration
- memory inspection and memory audit tooling

If you want to contribute, the most useful contributions are the ones that improve memory quality, inspectability, retrieval quality, or reliability.

## Before You Start

Make sure you can run the repo locally.

### Requirements

- Node.js 24 recommended
- Docker
- an OpenAI-compatible model endpoint

### Local Setup

```bash
npm install
docker compose up -d
npm run dev
```

Then:

1. Copy `.env.example` to `.env`
2. Configure the LLM values used by `cecil/llm.ts`
3. Open `http://localhost:3000`
4. Complete onboarding so the identity files are created

## How To Validate Your Changes

Before opening a PR, run:

```bash
npm run lint
npx tsc --noEmit
```

If you touched memory behavior, also run:

```bash
npm run memory:inspect -- --limit=10
npm run memory:audit -- --limit=200
```

If your change affects recall quality, also test:

```text
GET /api/memory?query=your+query&includeWindow=true
GET /api/memory?query=your+query&includeAudit=true
```

## What Contributions Are Most Valuable

### 1. Memory Quality

Examples:

- better observer synthesis
- better fact extraction
- better milestone derivation
- better provenance handling
- stronger idempotent writes

### 2. Retrieval Quality

Examples:

- better ranked recall
- better dedupe
- better token budgeting
- better weighting of recency, quality, and source confidence

### 3. Inspectability

Examples:

- better memory audit output
- easier memory browsing
- clearer debugging tools
- better admin or API inspection surfaces

### 4. Ingestion Pipelines

Examples:

- Slack exports
- Discord exports
- GitHub issues
- journals
- notes
- email archives

Follow the existing ingestion pattern instead of inventing a separate memory model.

### 5. Reliability And Developer Experience

Examples:

- safer write paths
- better test coverage
- better startup diagnostics
- clearer environment validation

## Contribution Guidelines

- Keep changes focused.
- Do not re-architect the whole protocol in one PR.
- Preserve existing behavior unless the change is explicitly meant to alter it.
- Do not remove Qdrant unless there is an approved design change for that.
- Prefer extending the current memory model over creating parallel systems.
- Keep documentation aligned with the actual running build.

## Code Style

- TypeScript for protocol code
- keep abstractions justified
- prefer small, inspectable functions
- add comments only when the logic is not obvious
- prefer changing the existing path over adding a second path that does the same thing

## Repo-Specific Notes

- Do not edit generated output in `.next/`
- Ignore macOS artifact files like `._*` and `.DS_Store`
- Structured memory lives in `memory/structured-memory.sqlite`
- Qdrant is still part of the active architecture
- The memory API and audit tools are part of the intended contributor workflow, not just internal debugging

## Pull Requests

Please include:

- what changed
- why it changed
- how you tested it
- whether memory behavior changed
- whether prompt/retrieval behavior changed

Small, clean PRs are much easier to review than broad speculative ones.

## Issues And Proposals

If you open an issue or proposal, include enough detail for someone else to reproduce or evaluate it.

Good issue examples:

- observer wrote duplicate memories for the same session
- ranked recall favored stale podcast chunks over recent observations
- memory audit reports empty `events` even after successful observe calls

Weak issue examples:

- memory feels weird
- bot seems off

## License

By contributing to this repo, you agree that your contributions will be licensed under the Apache License 2.0 in this repository.
