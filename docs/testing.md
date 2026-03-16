# Testing

## Integration Test Suite

Cecil ships with a full integration test that exercises every major subsystem:

```bash
npx tsx scripts/test-v2.ts
```

This runs 16 tests covering:

| Test | What it verifies |
|---|---|
| `init()` | SQLite + Qdrant + world model initialize |
| `getSubjectName()` | Name resolves from seed or world model |
| `setSubjectName()` | Runtime name override works |
| `worldModel.summary()` | World model query works |
| `worldModel.entities()` | Entity listing |
| `worldModel.entities('person')` | Entity filtering by kind |
| `worldModel.beliefs()` | Belief listing |
| `worldModel.openLoops()` | Open loop listing |
| `worldModel.contradictions()` | Contradiction listing |
| `recall()` | Memory search returns results |
| `store()` | Memory storage works |
| `recall stored memory` | Stored memory is immediately retrievable |
| `chat()` | LLM responds with memory context |
| `turn()` | Full cycle (chat + observe) |
| `maintenance(dryRun)` | Maintenance pipeline runs without errors |
| `reflect()` | Reflection agent generates analysis |

### Requirements

- Qdrant running (`docker compose up -d`)
- LLM endpoint running (local model server or cloud API)
- Existing memory data (optional — some tests work without it)

## Type Checking

```bash
npx tsc --noEmit
```

Must pass with zero errors before any commit.

## Linting

```bash
npm run lint
```

## Manual Verification

### Verify modules load

```bash
npx tsx --eval "import { observe } from './cecil/observer'; console.log('ok')"
```

### Verify world model tables exist

```bash
npm run world-model
```

### Verify web app starts without seed

Rename or delete `identity/seed.md`, then:

```bash
npm run dev
```

Open `http://localhost:3000` — should go straight to chat.

### Verify recall works

```bash
npm run memory:inspect -- --query="test query" --window
```

### Verify reflection

```bash
npm run reflect -- --patterns
```

### Verify maintenance

```bash
npm run maintenance -- --dry-run
```

### Verify MCP server starts

```bash
npm run mcp
```

Should start without errors and wait for stdio input.

## Memory Health Check

```bash
npm run memory:audit
```

Reports:
- Total records and events
- Memory types present
- Source pipelines writing
- Stale or low-quality records
- Duplicate detection
- Optional ranked recall preview

This is the first thing to check when Cecil's answers feel generic or blank.

## Testing Changes to Recall

If you modify recall behavior, verify with:

```
GET /api/memory?query=your+query&includeWindow=true
```

This shows the exact recall window Cecil would use for that query, including evidence tiers and source labels.
