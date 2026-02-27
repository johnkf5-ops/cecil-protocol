# Echo — System Brain

> Read this first. This is the architectural reference for the entire repo.

## What Echo Is

Echo is an open source memory and identity protocol for AI. Not an app — infrastructure. The foundational layer that gives any AI model persistent episodic memory and a continuous sense of identity over time.

Think of it as the hippocampus for AI.

**Tagline: Give AI a self.**

## The Pyramid Architecture

Echo uses a bidirectional pyramid to solve context rot — the problem where stuffing everything into a context window creates noise, degrades reasoning, and increases hallucinations.

Instead of one model processing entire history, Echo distributes retrieval across parallel vector searches at the base, compresses findings upward through synthesis layers, and delivers a distilled memory package to the conversational agent at the top.

### Layer 1: Memory Store (Base)

- **What**: Qdrant vector database running locally via Docker
- **How**: Every conversation, observation, and identity update gets embedded using FastEmbed (all-MiniLM-L6-v2, 384 dimensions) and stored as vectors
- **Cost**: Zero LLM calls. Retrieval is semantic, not keyword-based
- **Collection**: `echo_memory` with Cosine distance
- **Payload**: `type`, `timestamp`, `session_id`, `source_path`, `text`

### Layer 2: Observer (Compression)

- **What**: Runs after conversation sessions. Detects patterns, contradictions, evolution
- **When**: Two modes:
  - **Light pass** (every session): Log conversation, embed into Qdrant. No LLM calls.
  - **Full synthesis** (every 3-5 sessions): Pull related context, detect patterns, update narrative + delta. 3-5 LLM calls.
- **Output**: Updates to `narrative.md`, `delta.md`, and new observations in `/memory/observations/`
- **Counter**: Tracked in `/memory/.session-counter.json`

### Layer 3: Meta Agent (Top)

- **What**: The AI the user talks to. Receives a distilled identity window before every conversation.
- **Identity window contents**: seed + narrative + delta + relevant recent observations
- **Token budget**: 20-50k tokens. Signal, not noise. Remaining context reserved for actual conversation.
- **Cost**: 1 LLM call for window assembly (the conversation itself is separate)

### Bidirectional Flow

```
User query → DOWN → meta agent → observer → memory store (retrieval)
Memory     → UP   → store returns vectors → observer compresses → meta agent receives clean context
New data   → DOWN → after session, observer encodes patterns back into memory store
```

## Identity Files

| File | Purpose | Mutability |
|------|---------|------------|
| `/identity/seed.md` | Onboarding answers. Constitutional baseline. | Immutable once set |
| `/identity/narrative.md` | Who the user is becoming. Patterns detected. | Updated by observer |
| `/identity/delta.md` | Gap between seed and narrative. Stated goals vs revealed behavior. | Updated by observer (built last) |

## Memory Storage

All memory is dual-stored:
1. **Human-readable markdown** in `/memory/` (inspectable, editable, deletable)
2. **Vector embeddings** in Qdrant (fast semantic retrieval)

```
/memory/
  conversations/    ← Timestamped session logs
  observations/     ← Observer-detected patterns
  milestones/       ← Significant moments, decisions, turning points
  .session-counter.json  ← Tracks when to trigger full synthesis
```

## Tech Stack

- **Next.js** — Frontend and API routes
- **TypeScript** — Everything
- **Qdrant** — Vector database, local via Docker
- **FastEmbed** — Local embeddings (all-MiniLM-L6-v2, 384 dims). No API cost.
- **Claude API** — Meta agent and observer (claude-sonnet-4-6 via @anthropic-ai/sdk)
- **Markdown** — Human-readable memory mirror

## Key Source Files

| File | Role |
|------|------|
| `echo/types.ts` | Shared TypeScript types |
| `echo/embedder.ts` | FastEmbed initialization + Qdrant writes |
| `echo/retriever.ts` | Semantic search against Qdrant |
| `echo/observer.ts` | Post-session pattern detection (light pass + full synthesis) |
| `echo/meta.ts` | Pre-conversation identity window assembly + Claude chat |
| `onboarding/questions.ts` | The 5 onboarding questions |
| `onboarding/seed-builder.ts` | Converts answers → seed.md + embeddings |
| `app/api/chat/route.ts` | Chat API endpoint |
| `app/api/onboard/route.ts` | Onboarding API endpoint |

## Critical Rules

1. **Local first.** Qdrant runs locally via Docker. No cloud dependency for memory.
2. **Markdown mirror.** Every memory has a human-readable version. Users can inspect, edit, delete.
3. **Observer is post-session, not real-time.** No LLM calls during conversation for memory ops.
4. **Light pass every session, full synthesis every 3-5.** Don't burn API calls on isolated conversations.
5. **Identity window: 20-50k tokens.** Curated, not stuffed. Compression is the point.
6. **The UI is a demo.** Don't spend time on the interface. Build the engine.
7. **Don't over-engineer.** V1 is clean and minimal. Architecture is the innovation.
8. **API costs matter.** Base layer is free (Qdrant). LLM calls only in observer + meta agent.
9. **Build delta last.** It requires distinguishing stated goals vs revealed behavior. Hardest component.
10. **Bring your own model.** Architecture supports swapping Claude for any model via config.

## What NOT to Build

- Fancy UI (it's a demo)
- Real-time memory operations during chat
- Cloud-dependent memory storage
- Complex auth or user management (single user, local)
- Feature bloat beyond the core loop
