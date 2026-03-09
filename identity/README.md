# Identity

This directory holds Cecil's identity documents.

These files are runtime data. They are generated during onboarding and updated over time as the system observes behavior and synthesizes a continuing self-model.

| File | Purpose | Created by |
|------|---------|------------|
| `seed.md` | Immutable onboarding baseline: who the user directly says they are | Onboarding |
| `narrative.md` | Living self-model shaped by observer synthesis over time | Observer |
| `delta.md` | Drift and tension between the original seed and later observed behavior | Observer |
| `profile.md` | Optional public-facing profile material | User |

Important distinctions:

- `seed.md` is the highest-confidence identity source because it is directly stated during onboarding.
- `narrative.md` and `delta.md` are interpretive layers, not immutable ground truth.
- These files are part of Cecil's identity substrate, but they are not the same thing as structured memory in SQLite.

These files are gitignored because they contain personal runtime data and should not be committed to the public repo.
