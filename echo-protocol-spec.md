# Echo — Claude Code Build Prompt

## What We're Building

Echo is an open source memory and identity protocol for AI. Not an app. Not an assistant. Infrastructure — the foundational layer that gives any AI model persistent episodic memory and a continuous sense of identity over time.

Think of it as the hippocampus for AI.

Every AI currently forgets you the moment you close the tab. Not because the models aren't powerful enough — because there's no persistent self underneath them. Echo fixes that.

The tagline: **Give AI a self.**

---

## The Core Architecture

Echo uses a pyramid architecture — a bidirectional memory system that solves context rot.

**The problem with current approaches:**
Stuffing everything into a massive context window doesn't create memory. It creates noise. The model gets lost, reasoning degrades, hallucinations increase.

**Echo's solution:**
Instead of one model processing an entire history, Echo distributes retrieval across parallel vector searches at the base, compresses findings upward through synthesis layers, and delivers a perfectly distilled memory package to the meta agent at the top.

**The three layers:**

1. **Memory Store (Base Layer)** — Qdrant vector database running locally. Every conversation, observation, and identity update gets embedded and stored. Retrieval is semantic, not keyword-based. This layer is fast and essentially free — no LLM calls.

2. **Observer (Compression Layer)** — Runs after every conversation session. Scans memory for patterns, contradictions, and evolution over time. Synthesizes findings into compressed insight packages. This is where raw memory becomes understanding. Uses 3-5 LLM calls maximum per session.

3. **Meta Agent (Top Layer)** — The AI the user actually talks to. Receives a distilled identity window before every conversation — who the user is, who they're becoming, what patterns the observer has detected. Never gets overwhelmed. Maintains coherent identity across months and years.

**The bidirectional flow:**
- User query flows DOWN — meta agent sends query through observer to memory store
- Memory flows UP — store retrieves relevant vectors, observer compresses and synthesizes, meta agent receives clean context
- New experience flows DOWN after each session — observer encodes patterns back into memory store

---

## Key Components to Build

### 1. Identity Seed (`/identity/seed.md`)
Captured during onboarding. Simple questions:
- Name
- Age  
- Location
- What they do
- What they're working toward right now

This is immutable once set. The constitutional baseline everything else builds from. Store as markdown AND embed as vectors.

### 2. Living Narrative (`/identity/narrative.md`)
Updated automatically by the observer over time. Who the user is becoming. Patterns detected. Evolution tracked. This is NOT the same as the seed — it grows and changes.

### 3. Delta File (`/identity/delta.md`)
The gap between seed and narrative. Where the real insight lives. "You said you wanted X. You've been doing Y. Here's what the pattern looks like." Nothing like this exists in any current AI tool.

### 4. Memory Store (`/memory/`)
- `/memory/conversations/` — timestamped session logs
- `/memory/observations/` — patterns detected by observer
- `/memory/milestones/` — significant moments, decisions, turning points

All stored as:
- Human-readable markdown (inspectable, editable)
- Vector embeddings in Qdrant (fast semantic retrieval)

### 5. Observer Agent (`/echo/observer.ts`)
Runs after every conversation. Does NOT run in real time.
Jobs:
- Read new conversation log
- Query memory store for related past context
- Detect patterns, contradictions, evolution
- Update narrative.md
- Update delta.md
- Write new observations to memory store
- Re-embed anything that's changed

### 6. Meta Agent (`/echo/meta.ts`)
The conversational interface.
Before every conversation:
- Pulls identity seed
- Pulls current narrative
- Pulls delta
- Pulls any relevant recent observations
- Assembles distilled identity window (target: clean, not bloated)
- Uses this as system prompt foundation

### 7. Onboarding Flow (`/onboarding/`)
Simple, warm, non-threatening. Feels like setting up a profile not therapy.
Five questions max. Writes results to seed.md. Embeds seed into Qdrant.

### 8. Chat Interface (`/app/`)
Minimal. This is a demo to prove the protocol works, not a product UI.
Simple Next.js chat window. The interface is not the point — the engine underneath is.

---

## Tech Stack

- **Next.js** — frontend and API routes
- **TypeScript** — everything
- **Qdrant** — vector database, runs locally via Docker
- **Claude API** — meta agent and observer (claude-sonnet-4-6)
- **Markdown** — human-readable memory mirror

---

## Repo Structure

```
/echo
  CLAUDE.md                    ← YOU READ THIS FIRST. Full system brain.
  README.md                    ← The public-facing vision document
  docker-compose.yml           ← Spins up Qdrant locally
  
  /identity
    seed.md                    ← Onboarding answers. Immutable baseline.
    narrative.md               ← Living document. Who you're becoming.
    delta.md                   ← Gap between seed and narrative.
  
  /memory
    /conversations             ← Timestamped session logs
    /observations              ← Observer-detected patterns
    /milestones                ← Wins, failures, turning points
  
  /echo
    observer.ts                ← Pattern detection. Runs post-session.
    meta.ts                    ← Meta agent. Runs pre-conversation.
    embedder.ts                ← Handles vector embedding + Qdrant writes
    retriever.ts               ← Semantic search against Qdrant
  
  /onboarding
    questions.ts               ← Onboarding flow logic
    seed-builder.ts            ← Converts answers to seed.md + embeddings
  
  /app
    page.tsx                   ← Chat interface
    api/
      chat/route.ts            ← Meta agent API endpoint
      onboard/route.ts         ← Onboarding API endpoint
```

---

## CLAUDE.md Content (Write This First)

The CLAUDE.md file is the brain of this repo. It must explain:

1. What Echo is and why it exists
2. The pyramid architecture in plain language
3. The three layers and what each does
4. The difference between seed, narrative, and delta
5. The observer's job and when it runs
6. The meta agent's job and what goes into its identity window
7. How Qdrant is used (local, Docker, semantic search only)
8. The build order and what done looks like for each component
9. What NOT to build (don't over-engineer the UI, don't add features, don't bloat)

---

## Critical Rules

- **Local first.** Qdrant runs locally via Docker. No cloud dependency for the memory layer.
- **Markdown mirror.** Every memory has a human-readable markdown version. The user can always inspect, edit, or delete their own memory.
- **Observer runs post-session, not real-time.** Do not make LLM calls during conversation for memory operations.
- **The UI is a demo.** Do not spend time on the interface. Build the engine.
- **Do not over-engineer.** Echo V1 should be clean and minimal. The architecture is the innovation, not the feature count.
- **API costs matter.** The base retrieval layer uses Qdrant (free). LLM calls only happen in the observer (post-session, 3-5 calls) and meta agent (pre-conversation, 1 call). Keep it lean.
- **Bring your own model.** Architecture should support swapping Claude for any model via API key config.

### Observer Threshold Rule

The observer does NOT run full analysis after every conversation. It operates in two modes:

- **Light pass (every session):** Log the conversation to `/memory/conversations/`, embed it into Qdrant, done. No LLM calls. This is cheap and instant.
- **Full synthesis (every 3-5 sessions):** Run the complete observer pipeline — pull related past context, detect patterns, check for contradictions, update `narrative.md`, update `delta.md`, write new observations to `/memory/observations/`. This is where the 3-5 LLM calls happen.

The observer should track a simple session counter to determine when to trigger full synthesis. Don't burn API calls analyzing one conversation in isolation. Patterns need multiple data points to be meaningful.

### Identity Window Sizing

The meta agent's pre-conversation identity window should target **20-50k tokens**. Not smaller, not larger.

Echo is designed to work with any model context size, but the architecture assumes a curated window — not a stuffed one. Even with 1M tokens available from Opus, the meta agent should receive signal, not noise. The remaining context is reserved for the actual conversation to breathe.

The identity window includes:

- Identity seed (small, static)
- Current narrative (medium, evolving)
- Current delta (medium, evolving)
- Relevant recent observations (variable, selected by semantic relevance to the conversation)

If the assembled window exceeds 50k tokens, the retriever is pulling too much. Tighten the relevance threshold. The whole point of the pyramid is compression and curation — don't recreate context rot at the identity layer.

When paired with large-context models, the benefit isn't "stuff more in." It's that the observer's synthesis can preserve more nuance and the narrative/delta can include richer supporting evidence without being brutally compressed. The architecture scales up gracefully.

### Delta File Build Order

Build the delta file last. It is the hardest component and the most valuable.

The delta requires the observer to distinguish between stated goals (from the seed and early conversations) and revealed behavior (from actual conversation patterns over time). That is sophisticated reasoning — not simple summarization.

Build order for the delta:

1. Get the basic memory loop working first — onboard → chat → embed → retrieve → identity window → chat again with context
2. Get the observer producing basic narrative updates
3. THEN layer in the delta as a separate prompt engineering phase
4. Test the delta against real conversation data, not synthetic examples

The delta is where Echo goes from "cool, it remembers me" to "holy shit, it sees something about me I didn't notice." Do not rush it. Iterate on the prompts until the output genuinely surprises you.

---

## What Done Looks Like

A new user runs Echo. They answer five simple onboarding questions. They have a conversation. They close it completely.

Three days later they come back. Echo knows who they are — not just their name, but their context, their goals, what they talked about, what patterns are starting to emerge.

Three months later Echo says something like: "You've mentioned wanting more time for photography four times in the last month. Your calendar says you haven't picked up a camera in six weeks."

That's the demo. That's the moment. Build toward that.

---

## Build Order

1. Write CLAUDE.md first — full system brain before any code
2. Set up repo structure and docker-compose for Qdrant
3. Build embedder.ts and retriever.ts — core vector operations
4. Build onboarding flow — seed capture and initial embedding
5. Build observer.ts — post-session pattern detection
6. Build meta.ts — pre-conversation identity window assembly
7. Build minimal chat interface — just enough to demo it
8. Test the full loop: onboard → conversation → observer runs → new conversation shows memory

---

## The Vision (Keep This in Mind)

Echo is not an app. It's a protocol. The goal is for other developers to build on top of Echo — assistants, companions, agents, tools — all powered by a persistent identity layer underneath.

This is the infrastructure layer the entire AI ecosystem is missing. Ship it clean, ship it open, let the community take it from there.

*Built by a photographer who got tired of AI forgetting him.*
