# Memory

This directory is Cecil's human-readable memory mirror.

It exists so the protocol's runtime memory is inspectable by a human, not trapped inside a database or vector store.

Cecil stores memory in multiple forms at once:

- Qdrant for semantic retrieval
- SQLite for structured current state and memory-event history
- Markdown files in `memory/` for direct inspection of runtime artifacts

Typical runtime contents look like this:

```text
memory/
  conversations/        timestamped session logs
  observations/         synthesized observations, identity facets, and relationship summaries
  podcasts/             ingested podcast transcript material
  interviews/           ingested interview transcript material
  facts/                extracted fact records from long-form content
  milestones/           meaningful derived experience/event records
  structured-memory.sqlite
  .session-counter.json
```

Most of these files and folders are gitignored because they are personal runtime data, not source code.

If you want to inspect the active memory substrate, prefer:

- `npm run memory:inspect`
- `npm run memory:audit`
- `GET /api/memory`

The markdown mirror is useful for understanding what happened at runtime. The SQLite store is the source of truth for structured current memory and memory events.
