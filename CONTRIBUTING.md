# Contributing

## Setup

Use `.node-version` and the pnpm version in `package.json`.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Keep pnpm's isolated dependency layout and exact lockfile. Do not switch to hoisted dependencies,
hand-edit links, or introduce another package manager. Native runtime dependencies belong in
`apps/desktop/package.json` and must be rebuilt for Electron. Use Oxlint and Oxfmt only.

Install [Gitleaks 8.30.1](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1) before committing.
Keep it on PATH or set `PACT_GITLEAKS_EXECUTABLE` to its absolute executable path. The pre-commit hook
runs formatting/lint, checks the complete staged publication file set, and scans staged changes.
A missing scanner, wrong version, error, timeout, or detected secret blocks the commit. Inline allow
comments and local ignore files do not bypass scanning. Refresh changed hook configuration with
`pnpm exec simple-git-hooks`.

```sh
pnpm docs:check
pnpm secrets:check    # Staged content
pnpm secrets:history  # All reachable commits
```

## Change discipline

Keep a change focused on one reviewable feature or infrastructure concern. Before extending a module,
trace its interface, callers, state owner, lifecycle, and failure/restart path. Keep feature policy,
projections, subscriptions, and cleanup with their owner; entry points compose modules.

State the problem, resulting behavior, affected interfaces, validation, platform impact, and known
limitations in the pull request. Do not mix future work or unrelated cleanup into the diff. Visual
changes need a runnable build and inspection on the actual platform. Obtain visual acceptance before
adding or running their formal tests unless explicitly instructed to resume tests. Tests cannot
establish native composition, pointer routing, or visible design correctness.

Read [requirements](docs/product/requirements.md), [architecture](docs/technical-foundation.md), and
[performance](docs/performance.md) for the area you change. Test observable behavior through the
primary interface and retain genuine process/trust seam coverage. Avoid wrappers only for test fakes.

## Database changes

`packages/persistence/src/schema/index.ts` is the schema source. Generate and review forward SQL
migrations and Drizzle snapshots; retain all existing migrations.

```sh
pnpm db:generate --name=describe_the_change
pnpm db:check
pnpm db:migrate:dev
pnpm db:studio
```

The ignored development database is `.pact-data/dev/pact.sqlite`. Studio listens on
`127.0.0.1:4983` and is not packaged. Never target a user's production database with development
commands. Packaged startup applies migrations in Utility after a consistent backup, before reporting
ready. Failure stops startup and preserves recovery information. Do not use `drizzle-kit push`
or introduce a production migration shell command.

## Required verification

| Change                                              | Checks                                                         |
| --------------------------------------------------- | -------------------------------------------------------------- |
| Documentation/configuration                         | `pnpm docs:check`, `pnpm format:check`, relevant narrow checks |
| TypeScript                                          | `pnpm check`                                                   |
| Renderer/Main/Preload/Utility or IPC lifecycle      | The above and applicable Electron E2E                          |
| Native dependency, fuse, protocol, or packaging     | The above and `pnpm verify:package`                            |
| Native history, settings, Fork, or writer lifecycle | Relevant `pnpm test:native` cases                              |
| Streaming/resources/performance                     | Same-fixture measurements and applicable performance budgets   |
| Test infrastructure                                 | Relevant `pnpm test:infra` cases                               |

The [testing guide](docs/testing.md) identifies commands needing credentials or paid models. Run the
affected real-provider lane in a trusted local environment when its unique behavior changes; public
CI's deterministic evidence is complementary. Report commands actually run, failures, skips, warnings,
deferred checks, and unverified platforms. Missing evidence cannot establish a passing gate.

## Documentation policy

The reviewed Markdown allowlist is `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `CONTEXT.md`,
`SECURITY.md`, the product/architecture/performance/testing specifications under `docs/`, and desktop
`PRODUCT.md`/`DESIGN.md`. `scripts/check-publication.mjs` enforces exact paths, English text, local
links, and absence of private/generated material.

Publication inspection owns at most 4096 paths (1 MiB total, 1 KiB per path), reads only the eleven
reviewed documents (128 KiB each, 512 KiB total), and emits at most 128 diagnostics/64 KiB. Overflow
fails visibly. Binary/source content is inspected by the secret scanner, not retained by this policy
checker. Local documentation links must stay inside the repository.

Maintain one authority per topic: product behavior in requirements, ownership in architecture,
numerical budgets in performance, test operation in testing, visual rules in DESIGN. Other documents
link to it. PRODUCT and CONTEXT remain short tool/domain context. Keep DESIGN's frontmatter,
`.impeccable/design.json`, and four approved references consistent with the implementation.

Update specifications with behavior. Distinguish implemented features, planned work, and unresolved
decisions; preserve limitations and regression obligations. Do not commit chat transcripts, temporary
plans, delivery journals, private machine paths, or verification reports. A new document requires
a maintenance purpose existing documents cannot serve and review of its allowlist change. Retain
legally required notices.

## Security and privacy

Do not commit credentials, provider homes, environment files, databases, checkpoints, logs, traces,
or raw user/agent output. Ignore rules do not protect tracked/forcibly added files. Test credentials
must be unmistakably nonfunctional; never broadly exempt test directories from scanning. Follow
the [security policy](SECURITY.md) for private reports and credential incidents.
