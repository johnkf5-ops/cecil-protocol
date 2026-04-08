# Memory

Cecil's runtime memory directory. Everything here is gitignored — it's personal data, not source code.

```
memory/
  conversations/           Session logs (markdown)
  observations/            Synthesis results (markdown)
  facts/                   Extracted fact records
  podcasts/                Ingested podcast material
  structured-memory.sqlite SQLite database (memory + world model)
  .session-counter.json    Observer session counter
```

## Inspecting Memory

```bash
npm run memory:inspect                          # Browse current memory
npm run memory:inspect -- --query="topic"       # Ranked recall
npm run memory:inspect -- --query="topic" --window  # Full recall window
npm run memory:audit                            # Health check
npm run world-model                             # World model summary
```

Or via API:
```
GET /api/memory
GET /api/memory?query=your+query&includeWindow=true
GET /api/entities
GET /api/contradictions
GET /api/open-loops
```

## Storage Architecture

Memory is stored in two systems simultaneously:
- **Qdrant** — Semantic vector search (384D vectors via AllMiniLM-L6-v2, indexed on type, sourceEpisode, and domain)
- **SQLite** — Structured state with provenance, lifecycle history, and domain tagging

Each memory record includes a `domain` field (technology, business, personal, creative, health, education, finance, entertainment, or general) auto-detected via keyword heuristics. The world model's `world_beliefs` table includes `valid_from`/`valid_to` columns for temporal validity tracking.

The markdown files are a human-readable mirror for direct inspection. SQLite is the source of truth.
