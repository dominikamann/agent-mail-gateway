# Contributing

Thanks for helping! Bug reports, ideas and pull requests are welcome.

## Setup

Requirements: Node.js 24+, and Docker for the integration tests (they start a GreenMail test
mail server via Testcontainers).

```bash
npm ci
npm run test:unit          # fast, no Docker needed
npm run test:integration   # needs Docker
npm test                   # everything
npm run lint && npm run typecheck
npm run dev                # runs src/index.ts with CONFIG_PATH pointing at your config
```

## Guidelines

- Write a failing test first, then the code that makes it pass.
- Keep units small with one responsibility (see the layout under `src/`).
- REST routes and MCP tools must call the same service functions so policy stays identical.
- Never log secrets or message content.
- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:` …).

## Pull request checklist

- [ ] Tests added or updated, `npm test` passes
- [ ] `npm run lint` and `npm run typecheck` pass
- [ ] Docs updated (`README.md`, `docs/`, `config.example.yaml`) if behaviour or options changed
- [ ] `CHANGELOG.md` entry under "Unreleased"
