# Memory

This directory is the human-readable mirror of Cecil's vector database. Every memory stored in Qdrant also exists here as markdown for inspection, editing, and deletion.

```
memory/
  conversations/    ← Timestamped session logs
  observations/     ← Observer-detected patterns and synthesis results
  podcasts/         ← Podcast episode transcripts (from ingestion pipeline)
  milestones/       ← Significant moments and turning points
  .session-counter.json  ← Tracks when to trigger full synthesis
```

All subdirectories are gitignored — they contain personal data and should never be committed.
