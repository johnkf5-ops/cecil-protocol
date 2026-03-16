# Features

## Zero-Setup Start

Cecil works from the first message. No onboarding ceremony required. It learns your name, role, preferences, and context through natural conversation. If you want to bootstrap faster, optional onboarding creates a seed identity file.

## World Model

Every conversation is analyzed for structured knowledge:

- **Entities** — People, projects, organizations, places, recurring topics. Tracked with mention counts and first/last seen timestamps.
- **Beliefs** — Opinions, values, preferences, principles. Tracked as active, revised, or contradicted.
- **Open Loops** — Things you said you'd do. Tracked as open, resolved, or stale (>30 days).
- **Contradictions** — When you say something that conflicts with an earlier statement, both are recorded with source references.

Access via CLI (`npm run world-model`), API (`GET /api/entities`), or programmatically (`cecil.worldModel.entities()`).

## Reflection Agent

On-demand analysis that synthesizes the world model:

- **Contradiction report** — What changed, growth vs. inconsistency, which statement is current
- **Open loop report** — Grouped by age, which still matter, which were silently resolved
- **Focus analysis** — Entity mention frequency vs. stated priorities, hidden priorities, misalignment
- **Pattern summary** — Recurring themes, emotional patterns, strategic direction, blind spots

Run via CLI (`npm run reflect`), API (`POST /api/reflect`), or programmatically (`cecil.reflect()`).

## Memory Maintenance

Automated pipeline for memory hygiene:

1. **Exact dedup** — Normalize text, keep higher quality, retire duplicates
2. **Semantic dedup** — Cosine similarity >0.95 via Qdrant, merge near-duplicates
3. **Quality sweep** — Retire memories with quality score <0.4
4. **Stale loop detection** — Open loops >30 days marked stale
5. **Contradiction refresh** — Extract new contradictions from recent conversations
6. **Entity refresh** — Rebuild entity mentions from recent memories
7. **Belief refresh** — Check if active beliefs have been revised

Steps 1-4 require no LLM calls. Steps 5-7 use batched LLM extraction. Supports `--dry-run` to preview changes.

## Evidence-Aware Recall

Every recalled memory carries an evidence tier:

| Tier | Source | Confidence |
|---|---|---|
| DIRECT_STATEMENT | User said it directly | Highest |
| OBSERVED_PATTERN | Detected from repeated behavior | Good |
| PUBLIC_CORPUS | Extracted from podcasts/transcripts | Useful, not private truth |
| INFERRED | Synthesized from multiple signals | Transparent inference |

Cecil's prompts enforce this discipline — it won't upgrade inference into certainty.

## Deep Search

When Cecil doesn't have enough context to answer confidently, it triggers a `[SEARCH: ...]` marker. The system then:

1. Searches across facts, podcasts, and observations in Qdrant
2. Merges and deduplicates results
3. Re-prompts the LLM with the search results
4. Returns an evidence-backed answer

## Observer Pipeline

After every chat session:

- **Light pass** (1 LLM call): Log conversation, embed to Qdrant, record to SQLite, extract world model data
- **Full synthesis** (every N sessions, 3 LLM calls): Detect patterns, update narrative, compute drift, write observations

The synthesis interval is configurable via `SYNTHESIS_INTERVAL` in `.env`.

## Correction Handling

When you correct a fact ("Actually, I moved to Denver, not LA"), Cecil:
1. Detects the correction
2. Embeds the corrected information
3. Soft-retires the conflicting old fact

## Multiple Integration Points

- **Web UI** — Next.js app at `localhost:3000`
- **Discord bot** — Full personality system with meeting facilitation
- **REST API** — 11 endpoints covering all functionality
- **MCP server** — 7 tools for Claude Code / Claude Desktop
- **Client module** — One import for any Node.js application

## Content Ingestion

Beyond conversation, Cecil can ingest:

- Podcast transcripts (transcribe → ingest → extract facts)
- Interview transcripts
- Any long-form text content

These feed into the same memory system with appropriate evidence tiers.

## Memory Inspection

Multiple ways to inspect what Cecil knows:

```bash
npm run memory:inspect                          # Browse memory
npm run memory:inspect -- --query="AI" --window # See ranked recall
npm run memory:audit                            # Health check
npm run world-model                             # World model summary
npm run world-model -- --entities               # List all entities
```

Or via API:
```
GET /api/memory?query=what+matters&includeWindow=true
GET /api/entities?kind=person
GET /api/contradictions
GET /api/open-loops?status=open
```
