# Echo

**Give AI a self.**

Echo is an open source memory and identity protocol for AI. Not an app — infrastructure. The foundational layer that gives any AI model persistent memory, pattern recognition, and a continuous sense of context over time.

Every AI currently forgets you the moment you close the tab. Not because the models aren't powerful enough — because there's no persistent self underneath them. Echo fixes that.

---

## What Makes This Different

Most AI memory solutions stuff everything into a context window. That creates noise, not memory. The model gets lost, reasoning degrades, hallucinations increase.

Echo distributes memory across three layers:

1. **Memory Store** — Qdrant vector database running locally. Every conversation, observation, and data point gets embedded and stored. Retrieval is semantic, not keyword-based. Fast and free — no LLM calls.

2. **Observer** — Runs after sessions. Detects patterns, contradictions, and evolution over time. Compresses raw memory into insight. Light pass every session (zero LLM calls), full synthesis every 3-5 sessions (3 LLM calls).

3. **Meta Agent** — Assembles a distilled identity window before every conversation. 20-50k tokens of signal, not noise. The AI doesn't get your entire history — it gets the compressed understanding of who you are and what matters right now.

The result: an AI that doesn't just remember what you said — it understands how you think. And it evolves.

---

## It Evolves

Echo isn't static memory. It's a feedback loop.

The observer doesn't just store data — it watches for **drift**. Every few sessions, it compares what was configured (the seed) against what it's actually seeing (the patterns). The delta between those two is where the insight lives.

This works the same way whether Echo is observing a person, an agent, or itself.

- The **seed** is the initial configuration — what the subject was set up to be.
- The **narrative** is the evolving understanding — what the patterns actually show.
- The **delta** is the drift — where reality diverges from intent.

If Echo is powering an agent, and that agent starts behaving differently than configured — responding differently, prioritizing different things, drifting from its original purpose — the observer catches it. The narrative updates. The delta surfaces the gap. The agent can then use that self-awareness to correct course or lean into the evolution.

This is what makes it alive in a meaningful sense. It's not just remembering — it's noticing its own patterns, detecting its own drift, and building an evolving model of what it's becoming. The observer doesn't care if it's watching a human or watching itself. It just looks for the gap between baseline and reality.

---

## The Real Power: Ingestion

The onboarding flow asks 5 seed questions to get started. That's the cold start. It works, but it's shallow.

The real power is feeding Echo raw content and letting the observer synthesize it:

- **Podcasts** — 44 hours of unfiltered conversation transcribed and embedded. Echo learns how you argue, what you believe, your recurring themes, your contradictions. Richer than any profile page.
- **Blog posts, journal entries, writing** — Feed it your words, it learns your voice.
- **Code repositories** — Feed it your codebase, it learns your architecture, patterns, and failure modes.
- **Chat history** — Feed it Slack, Discord, or support logs. It learns group dynamics, communication patterns, escalation triggers.
- **Research** — Feed it papers, transcripts, documentation. It synthesizes themes across sources.

The protocol is the same every time: **Ingest → Embed → Observe → Synthesize → Retrieve.** What changes is what you feed it and what you ask it to remember.

The included podcast pipeline (`scripts/transcribe-podcasts.py`) is one example. Point it at an RSS feed, it downloads, transcribes with faster-whisper on GPU, chunks the transcripts, embeds them into Qdrant, and runs synthesis. You can build the same pipeline for any content source.

---

## Use Cases

Echo is not just a "get to know you" tool. The memory + observation + synthesis loop is a general-purpose pattern:

- **Personal AI** — An AI that actually knows you. References things you said months ago. Notices when you contradict yourself. Evolves its understanding as you do.
- **Agent memory** — Give any AI agent persistent context. A Discord bot that remembers every conversation. A coding assistant that learns your codebase over time.
- **Team of agents** — Spin up multiple Echo instances with different memory pools. Each one observes different data, develops different expertise, maintains its own identity.
- **Moderation** — Feed it channel history. It learns community dynamics, detects pattern shifts, understands context that keyword filters miss.
- **Autonomous workflows** — An agent that runs recursive tasks and learns from each iteration. It doesn't just execute — it observes what worked, what failed, and adapts.

---

## Architecture

```
User query → Meta Agent → assembles identity window from memory
                ↓
         Observer layer → retrieves relevant vectors from Qdrant
                ↓
         Memory Store → semantic search across all embedded content
                ↑
         After session → Observer embeds new data, detects patterns,
                         updates narrative + delta every N sessions
```

All memory is dual-stored:
- **Vector embeddings** in Qdrant (fast semantic retrieval)
- **Human-readable markdown** in `/memory/` (inspectable, editable, deletable)

Identity lives in three files:
- `identity/seed.md` — Baseline configuration (immutable once set)
- `identity/narrative.md` — Evolving understanding based on observed patterns (updated by observer)
- `identity/delta.md` — Drift between baseline and reality (updated by observer)

---

## Quick Start

### Prerequisites

- Node.js 18+
- Docker (for Qdrant)
- Any OpenAI-compatible LLM (local or cloud)

### Setup

```bash
# Clone
git clone https://github.com/johnkf5-ops/echo-protocol.git
cd echo-protocol

# Start Qdrant
docker compose up -d

# Install dependencies
npm install

# Configure your LLM endpoint
cp .env.example .env
# Edit .env — set LLM_BASE_URL and MODEL for your provider

# Run
npm run dev
```

Open `http://localhost:3000` — complete the onboarding, then start chatting.

### Feed It Content (Optional)

The onboarding gives you a seed. To go deeper, feed Echo real content:

```bash
# Example: Podcast transcription pipeline
pip install faster-whisper requests feedparser

# Edit scripts/transcribe-podcasts.py — set your RSS feed URL
python scripts/transcribe-podcasts.py

# Ingest transcripts into Echo
curl -X POST http://localhost:3000/api/ingest-podcasts
```

Build your own ingestion pipelines for any content source. The pattern:
1. Get your content into text
2. Chunk it into meaningful segments
3. Use `embedBatch()` from `echo/embedder.ts` to store in Qdrant
4. Run synthesis via `echo/podcast-observer.ts` pattern to extract insights

### Customizing Onboarding

The default onboarding asks 5 seed questions. You can customize these in `onboarding/questions.ts` to ask whatever matters for your use case. The seed is just a starting point — the observer will build the real understanding over time from actual interactions and ingested content.

---

## Tech Stack

- **Next.js** — Frontend and API routes
- **TypeScript** — Everything
- **Qdrant** — Vector database, local via Docker
- **FastEmbed** — Local embeddings (all-MiniLM-L6-v2, 384 dims, zero API cost)
- **Any LLM** — OpenAI-compatible endpoint (LM Studio, Ollama, Claude, GPT, etc.)
- **Markdown** — Human-readable memory mirror

---

## Project Structure

```
echo/
  types.ts              — Shared types (MemoryType, SearchResult, etc.)
  embedder.ts           — FastEmbed + Qdrant writes
  retriever.ts          — Semantic search against Qdrant
  observer.ts           — Post-session pattern detection + synthesis
  meta.ts               — Identity window assembly + chat
  llm.ts                — LLM wrapper (any OpenAI-compatible endpoint)
  podcast-ingest.ts     — Podcast transcript ingestion
  podcast-observer.ts   — Podcast-specific synthesis

onboarding/
  questions.ts          — Seed questions (customizable)
  seed-builder.ts       — Converts answers → seed.md + embeddings

app/api/
  chat/route.ts         — Chat endpoint
  observe/route.ts      — Observer endpoint
  onboard/route.ts      — Onboarding endpoint
  status/route.ts       — Status check
  ingest-podcasts/route.ts — Podcast ingestion + synthesis

scripts/
  transcribe-podcasts.py — Download + transcribe podcasts (faster-whisper/CUDA)

identity/               — User identity documents (gitignored)
memory/                 — Human-readable memory mirror (gitignored)
```

---

## Design Principles

1. **Local first.** Qdrant runs locally. No cloud dependency for memory.
2. **Bring your own model.** Any OpenAI-compatible LLM works. Local or cloud.
3. **Markdown mirror.** Every memory has a human-readable version. Inspect, edit, delete.
4. **Observer is post-session.** No LLM calls during conversation. Memory ops happen after.
5. **Compression over accumulation.** The identity window is 20-50k tokens of signal, not your entire history.
6. **The protocol is the product.** Echo is infrastructure, not an app. Plug it into anything.

---

## License

MIT
