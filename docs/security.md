# Security & Privacy

## Data Storage

Cecil stores all data locally. Nothing is sent to external services except LLM API calls.

### What's stored where

| Data | Location | Gitignored |
|---|---|---|
| Conversation logs | `memory/conversations/` | Yes |
| Observations | `memory/observations/` | Yes |
| Structured memory | `memory/structured-memory.sqlite` | Yes |
| Vector embeddings | Qdrant (Docker container) | Yes (`qdrant_storage/`) |
| Identity seed | `identity/seed.md` | Yes |
| Narrative / delta | `identity/narrative.md`, `identity/delta.md` | Yes |
| Personality config | `discord/personality/SOUL.md` | Yes |
| Environment secrets | `.env` | Yes |
| Fastembed model cache | `local_cache/` | Yes |

### What's NOT stored

- No data is sent to Anthropic, OpenAI, or any cloud service (unless you point `LLM_BASE_URL` at one)
- No telemetry or analytics
- No user accounts or authentication

## LLM Calls

Cecil makes LLM calls to whatever endpoint you configure in `LLM_BASE_URL`. By default this is `http://127.0.0.1:1234/v1` (a local model server).

**What gets sent to the LLM:**
- System prompts with assembled memory context
- User messages
- World model extraction prompts (conversation text → structured data)
- Domain detection is heuristic (keyword regex) — no LLM call, no data sent anywhere
- Observer synthesis prompts (conversation summaries → patterns)
- Reflection prompts (world model data → analysis)

**If you use a cloud LLM**, all of the above will transit the network. If privacy matters, run a local model.

## Environment Variables

The `.env` file contains:

| Variable | Sensitivity |
|---|---|
| `LLM_BASE_URL` | Low (usually localhost) |
| `QDRANT_URL` | Low (usually localhost) |
| `MODEL` | Low (model name) |
| `DISCORD_TOKEN` | **High** — Discord bot credential |
| `CHANNEL_ID` / `GUILD_ID` | Medium — Discord identifiers |

Never commit `.env`. The `.gitignore` already blocks it.

## Gitignore Coverage

The `.gitignore` protects:
- All `.env` files (`.env`, `.env.local`)
- All identity files (`identity/seed.md`, `narrative.md`, `delta.md`)
- All memory data (`memory/conversations/`, `memory/*.sqlite`, etc.)
- Discord personality files (`discord/personality/*`)
- Qdrant storage and fastembed cache
- Build artifacts (`.next/`, `node_modules/`)

Only `.example` files ship in the personality directory.

## For Contributors

- Never commit files from `identity/` or `memory/` (they contain personal data)
- Never commit `.env` (it may contain API tokens)
- When adding new data directories, add them to `.gitignore`
- When adding new environment variables, add placeholder values to `.env.example`
- The `memory/README.md` and `identity/README.md` files explain the runtime data for anyone inspecting the directory

## Threat Model

Cecil is a local-first personal assistant. The main risks are:

1. **LLM data exposure** — If using a cloud LLM, conversation content transits the network. Mitigation: use a local model.
2. **Disk access** — Anyone with access to the filesystem can read all memories. Mitigation: standard OS file permissions.
3. **Discord token exposure** — If the `.env` is committed or leaked, the Discord bot token is exposed. Mitigation: `.gitignore`, don't commit secrets.
4. **No authentication on the web UI** — The Next.js app has no auth. Don't expose it to the public internet without adding your own auth layer.
