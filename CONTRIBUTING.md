# Contributing to Autobeat

## Development Setup

```bash
git clone https://github.com/dean0x/autobeat.git
cd autobeat
npm install
npm run build
```

## Running Tests

Autobeat uses [Vitest](https://vitest.dev/) with grouped test commands. The full suite is memory-intensive, so tests are split into safe groups:

```bash
# Safe to run individually
npm run test:core           # Core domain logic (~3s)
npm run test:handlers       # Service handlers (~3s)
npm run test:services       # Service layer (task-manager, recovery, etc.)
npm run test:repositories   # Data layer (~2s)
npm run test:adapters       # MCP adapter (~2s)
npm run test:implementations # Implementation layer (~2s)
npm run test:cli            # CLI tests (~2s)
npm run test:integration    # Integration tests

# Full suite - local terminal or CI only
npm run test:all
```

`npm test` is intentionally blocked with a warning. Use `npm run test:all` for the full suite in a local terminal or CI. Individual groups are always safe.

## Code Style

This project uses [Biome](https://biomejs.dev/) for linting and formatting:

```bash
npm run check       # Lint + format check
npm run check:fix   # Auto-fix lint + format issues
npm run lint        # Lint only
npm run format:fix  # Format only
```

Biome enforces `noExplicitAny` as an error in `src/` and a warning in `tests/`. Use `biome-ignore` comments with justification for genuine TypeScript limitations.

## Architecture

Autobeat uses an event-driven architecture. Key rules:

- **All state changes go through EventBus** - no direct repository access from services
- **Commands** use fire-and-forget `emit()`
- **Queries** use request-response `request()`
- **Result types everywhere** - never throw in business logic
- **Dependency injection** - all components receive dependencies via constructor

See `docs/architecture/` for detailed documentation.

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes with tests
3. Ensure all checks pass: `npm run typecheck && npm run check && npm run build && npm run test:all`
4. Open a PR against `main`

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` new features
- `fix:` bug fixes
- `test:` adding or updating tests
- `docs:` documentation changes
- `chore:` tooling, CI, dependencies
- `style:` formatting (no logic changes)
- `refactor:` code restructuring (no behavior change)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
