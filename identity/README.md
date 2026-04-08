# Identity

This directory holds Cecil's identity documents. All files here are **runtime data** — they are gitignored and never committed.

Cecil works without any of these files. It learns from conversation and builds understanding through the world model. If a seed exists, it's used as the strongest identity baseline.

| File | Purpose | Created by |
|------|---------|------------|
| `seed.md` | Optional onboarding baseline: who the user directly says they are | Onboarding (optional) |
| `narrative.md` | Living understanding shaped by observer synthesis over time | Observer |
| `delta.md` | Drift between baseline and observed behavior | Observer |

Important distinctions:

- `seed.md` is the highest-confidence identity source because it is directly stated. But it's **optional** — Cecil learns your name, role, and preferences from conversation.
- `narrative.md` and `delta.md` are interpretive layers built by the observer's synthesis pipeline.
- Without any of these files, Cecil starts from zero and builds understanding as you talk.
