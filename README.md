# Pact

Pact is a local-first desktop workspace for working with Claude Code and Codex in one conversation.
It brings together projects, sessions, agent routing, plans and reviews, permissions, file changes,
and recovery without copying context between terminals.

## What it does

- Route messages to Claude, Codex, or both, and carry relevant history between agents.
- Run `/plan`, `/build`, and `/review` with versioned plans, review findings, and user decisions.
- Attach images and anchored comments to the same message.
- Inspect recorded file changes and undo an eligible changes card with conflict checks.
- Continue native agent histories, create dialogue forks, and explicitly recover disrupted runs.
- Choose light or dark themes and an optional translucent appearance on macOS and Windows.

Pact stores its session records locally. Agent requests still use the selected CLI's configured
provider and may send prompts, project content, attachments, and tool results to that provider.
Install and authenticate the CLIs separately; provider accounts, models, limits, and fees apply.

This is an actively developed project. Some native behavior depends on CLI and operating-system
versions. Signed distribution, automatic updates, and full checkpoint restore are not complete.
See the [product specification](docs/product/requirements.md) for current behavior and limitations.

## Run from source

- Node.js **24.18.1**, Corepack, and pnpm **12.11.2**.
- macOS arm64 or Windows x64/arm64.
- Claude Code and Codex installed and configured for agent sessions.
- On Windows, Python 3 and Visual Studio Build Tools with **Desktop development with C++** for
  Electron native dependency rebuilds.

Required CI currently covers Windows x64 and macOS arm64. Windows arm64 CI and all
automatic installer builds/publication are deferred pending native-machine acceptance.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

The app checks each CLI independently. First use requires both CLIs to be ready and initial session
defaults to be saved. Returning users can read existing content while a CLI is unavailable.

## Build and verify

```sh
pnpm check                  # Documentation, formatting, lint, migrations, types, unit tests
pnpm build                  # Production output
pnpm start                  # Production output with the development Electron executable
pnpm test:e2e:ui            # No provider credentials
pnpm test:e2e:deterministic # Protocol and fixed-load fixtures
pnpm verify:package         # Build and test an isolated unpacked application
pnpm dist:mac               # Build macOS installers on macOS
pnpm dist:win               # Build the Windows installer on Windows
```

Windows E2E also needs PowerShell 7 (`pwsh.exe`) and the Windows .NET Framework C# compiler.
Real-provider tests require private configuration and can incur model fees. Read the
[testing guide](CONTRIBUTING.md#testing) before running them. Current signing and notarization settings
produce development artifacts, not signed public releases.

## Development documentation

- [Contributing](CONTRIBUTING.md): setup, migrations, testing, and change discipline.
- [Product specification](docs/product/requirements.md): vocabulary, behavior, and open decisions.
- [Architecture](docs/technical-foundation.md): interfaces, ownership, recovery, and resource budgets.
- [Desktop product context](apps/desktop/PRODUCT.md) and [design system](apps/desktop/DESIGN.md).
- [Agent instructions](AGENTS.md).

## License

Pact is released under the [MIT License](LICENSE). Bundled dependencies retain their own licenses.
