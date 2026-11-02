# GeoAtlas — Codex Instructions

GeoAtlas is an open-source, real-time geospatial
intelligence dashboard inspired by Argos Atlas.

## Architecture

- React + TypeScript + MapLibre
- Fastify + WebSockets
- pnpm workspaces monorepo
- SQLite for initial persistence
- Modular polling and streaming data adapters

## Source of Truth

- docs/system-design.md
- docs/adapter-design.md

Read the relevant specifications before implementing
features. Do not silently change architectural decisions.

## Security

- Never commit or expose credentials.
- Keep API keys exclusively server-side.
- Validate all external input.
- Use approved endpoint registries.
- Follow zero-trust contribution practices.
- Never weaken security controls without approval.
- No production secrets in untrusted PR workflows.

## Engineering Standards

- Prefer simple, maintainable implementations.
- Use the project formatters: `pnpm format` for web/server code and configs,
  `pnpm format:python` for Python scripts. Check formatting before completing changes.
- Preserve generated provider data and the recovered document archive;
  formatter exclusions are defined in `.prettierignore`.
- Use strict TypeScript and runtime validation.
- Include meaningful unit and integration tests.
- Keep data adapters independent of the frontend.
- Follow established security best practices.
- Do not introduce unnecessary infrastructure.

## Development Workflow

Implement features incrementally.
Explain major architectural tradeoffs.
Run relevant tests before completing changes.
