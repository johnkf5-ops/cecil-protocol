# Identity

This directory holds the user's identity documents. These files are generated during onboarding and updated by the observer over time.

| File | Purpose | Created by |
|------|---------|------------|
| `seed.md` | Immutable onboarding baseline — who you say you are | Onboarding |
| `narrative.md` | Living document — who you're becoming based on patterns | Observer (full synthesis) |
| `delta.md` | The gap between seed and narrative — stated vs revealed | Observer (full synthesis) |
| `profile.md` | Optional public profile | User |

All files except `seed.md` are updated automatically by the observer after every few sessions.

These files are gitignored — they contain personal data and should never be committed.
