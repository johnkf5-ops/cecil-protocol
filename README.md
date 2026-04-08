# Cecil v2.1

A personal assistant that remembers.

Cecil is a memory layer for AI assistants. You talk to it, it remembers — not just what you said, but what you care about, what you committed to doing, and where you contradicted yourself. Over time it builds a structured model of your world: the people you mention, the projects you're working on, the beliefs you hold, and the things you said you'd do but haven't yet.

It uses all of that to give better answers, surface things you forgot about, and catch when you're saying one thing now but said something different last week.

Cecil runs as a standalone chat app, a Discord bot, a REST API, or an MCP server for Claude Code. One codebase, any platform.

## What it looks like

```
You:    I'm thinking about shutting down the photography business
        and going all-in on the AI project.

Cecil:  That's a big shift. Three weeks ago you said the photography
        business was your "non-negotiable foundation" — your words.
        You also told me last month you wanted to hire a second
        shooter by June. Is that still on the table, or has
        something changed?
```

Cecil remembers what you said, when you said it, and whether it lines up with what you're saying now. It doesn't just retrieve — it reflects.

## Quick Start

```bash
npm install
docker compose up -d    # starts Qdrant
cp .env.example .env    # set your LLM endpoint
npm run dev             # web UI at http://localhost:3000
```

Start talking. Cecil starts remembering.

## Who this is for

**Building a bot or agent?** Use Cecil as the memory backend. One import gives your Discord bot, Slack bot, Telegram bot, or custom agent persistent memory with world model tracking.

**Using Claude Code or Claude Desktop?** Run `npm run mcp` and Cecil becomes a tool server. Ask it to recall, store, reflect, or list your open loops from inside Claude.

**Want a personal assistant with memory?** Run the web UI or Discord bot. Talk to it over days and weeks. It learns who you are without any setup.

**Building something custom?** Hit the REST API from any language. 11 endpoints cover chat, memory, world model, reflection, and maintenance.

## Get started

### I'm building a bot or agent

```ts
import { cecil } from "./cecil/client";

await cecil.init();

// One call: chat + memory update
const result = await cecil.turn([
  { role: "user", content: "Hey, remind me what I said about the project?" }
]);
console.log(result.response);
```

The full client API:

```ts
cecil.chat(messages)              // Chat with memory context
cecil.turn(messages)              // Chat + observe in one call
cecil.observe(messages, sessionId) // Run observer pipeline
cecil.recall(query)               // Search memory
cecil.store(content, options)     // Store a memory directly
cecil.reflect(sections?)          // Run reflection agent
cecil.maintenance(options?)       // Run memory hygiene
cecil.worldModel.entities(kind?)  // List tracked entities
cecil.worldModel.beliefs(status?) // List beliefs
cecil.worldModel.beliefsAsOf(date) // Beliefs valid at a point in time
cecil.worldModel.openLoops()      // List open loops
cecil.worldModel.contradictions() // List contradictions
```

### I use Claude Code or Claude Desktop

```bash
npm run mcp
```

Add Cecil to your MCP config. This exposes `recall`, `store`, `reflect`, `entities`, `contradictions`, `openLoops`, and `observe` as tools.

### I want the chat UI

```bash
npm run dev
```

Open `http://localhost:3000` and start talking.

### I want the Discord bot

```bash
npm run discord
```

Copy `discord/personality/SOUL.md.example` to `discord/personality/SOUL.md` and customize the personality.

### I want to call the REST API

Run `npm run dev` and hit the endpoints:

| Endpoint | Method | Description |
|---|---|---|
| `/api/chat` | POST | Send messages, get response |
| `/api/observe` | POST | Run observer on conversation |
| `/api/reflect` | POST | Run reflection agent |
| `/api/memory` | GET | Query/inspect memories |
| `/api/entities` | GET | List world model entities |
| `/api/contradictions` | GET | List contradictions |
| `/api/open-loops` | GET | List open loops |
| `/api/maintenance` | POST | Run maintenance pipeline |
| `/api/onboard` | POST | Optional onboarding (creates seed identity) |
| `/api/ingest-podcasts` | POST | Ingest podcast transcripts |
| `/api/status` | GET | Health check |

## How it works

Cecil has four core systems:

1. **Storage** — Qdrant vector database (local) for semantic search + SQLite for structured state, provenance, and lifecycle history. Every memory is auto-tagged with a **domain** (technology, business, personal, creative, health, education, finance, entertainment, or general).
2. **Observe** — After each session, the observer embeds conversations at three granularities (full session, individual messages, Q+A exchange pairs), extracts entities, beliefs, open loops, and contradictions into a structured world model. Every few sessions, a deeper synthesis pass detects patterns, updates the narrative, and computes drift.
3. **Recall** — Ranked retrieval combining TF-IDF lexical scoring, semantic search, domain matching, evidence tiers, quality weighting, and recency boosting. Domain-matched results surface higher. Every recalled memory is tagged with its source and confidence level.
4. **Maintain** — Deduplicates memory (exact + semantic), retires low-quality entries, detects stale commitments, refreshes the world model. Corrections are immediate — old fact retired, new fact embedded at highest priority.

## What Cecil tracks

Cecil builds a **world model** from every conversation:

- **Entities** — people, projects, organizations, places, topics
- **Beliefs** — opinions, values, preferences you express (with temporal validity — Cecil knows when a belief was active and when it was revised)
- **Open loops** — things you said you'd do but haven't followed up on
- **Contradictions** — conflicting statements across conversations
- **Patterns** — recurring themes detected by the observer

Cecil uses this to surface relevant context, catch inconsistencies, and remind you about things you forgot.

## CLI tools

```bash
npm run dev                        # Web UI
npm run discord                    # Discord bot
npm run reflect                    # Reflection report
npm run reflect -- --contradictions # Just contradictions
npm run maintenance -- --dry-run   # Memory hygiene preview
npm run maintenance                # Run dedup, quality sweep, stale detection
npm run maintenance -- --semantic-dedup  # Run only semantic dedup
npm run mcp                        # MCP tool server
npm run world-model                # World model summary
npm run world-model -- --rebuild   # Rebuild world model from memories
npm run memory:inspect             # Browse memory
npm run memory:audit               # Memory health check
```

## Requirements

- Node.js 22+
- Docker (for Qdrant)
- Any OpenAI-compatible LLM endpoint (local or remote)

## Documentation

- [Architecture](docs/architecture.md) — System design, data flow, storage layers
- [Features](docs/features.md) — Detailed feature breakdown
- [Security](docs/security.md) — Data handling, what's stored where, privacy
- [Testing](docs/testing.md) — How to verify Cecil works
- [Conventions](docs/conventions.md) — Code style and contribution guidelines

## License

Apache 2.0 — see [LICENSE](LICENSE).
