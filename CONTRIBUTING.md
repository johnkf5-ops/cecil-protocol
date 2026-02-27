# Contributing to Cecil

Thanks for your interest in Cecil. This project is open to contributions of all kinds — bug fixes, new ingestion pipelines, documentation improvements, and feature proposals.

## Getting Started

1. Fork the repo
2. Clone your fork
3. Install dependencies: `npm install`
4. Start Qdrant: `docker compose up -d`
5. Copy `.env.example` to `.env` and configure your LLM endpoint
6. Run the dev server: `npm run dev`

## What We're Looking For

- **New ingestion pipelines** — Cecil has a podcast pipeline. Build one for Slack exports, Discord logs, GitHub issues, journal entries, or anything else. Follow the pattern in `cecil/podcast-ingest.ts`.
- **Observer improvements** — Better pattern detection, smarter synthesis, more efficient compression.
- **Frontend** — The current UI is minimal. There's room for memory visualization, identity dashboards, and observer status.
- **Integrations** — Discord bots, CLI tools, VS Code extensions, or anything that plugs into the protocol.
- **Documentation** — Better examples, guides, and explanations.

## Pull Requests

- Keep PRs focused on a single change
- Include a clear description of what changed and why
- Test your changes locally before submitting

## Issues

If you find a bug or have a feature idea, open an issue. Include enough context for someone else to understand and reproduce the problem.

## Code Style

- TypeScript for all protocol code
- Keep it simple — don't over-abstract
- Comments only where the logic isn't self-evident

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 license.
