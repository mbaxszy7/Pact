# Pact repository instructions

## Sources of truth

- Behavior: [docs/product/requirements.md](docs/product/requirements.md).
- Interfaces/ownership: [docs/technical-foundation.md](docs/technical-foundation.md).
- Budgets/benchmarks: [Architecture resource requirements](docs/technical-foundation.md#performance-and-resource-requirements).
- Checks: [CONTRIBUTING.md](CONTRIBUTING.md).
- Terminology: [Product glossary](docs/product/requirements.md#terminology).
- UI: [apps/desktop/PRODUCT.md](apps/desktop/PRODUCT.md) and [apps/desktop/DESIGN.md](apps/desktop/DESIGN.md).
- Active user instructions take precedence. Preserve user and concurrent changes.

## Delivery and design

Implement one approved, reviewable module at a time; split oversized work and obtain acceptance before
starting the next product module. Keep unrelated refactors and future scope out of the diff. Delivery
includes scope, interfaces/invariants, files, verification, platform impact, limitations, and a
reviewable diff. Commit or publish only with user authorization.

Before implementation, state each affected module's responsibility, primary interface, callers,
state/side-effect owner, and lifecycle. Trace accepted modules as one system; do not add parallel
controllers, stores, or policies for existing owners. Merge layers that merely move a few lines from
their sole caller. Test through the primary interface and genuine trust/process seams.

Keep policy, projections, subscriptions, and cleanup together. Main composes/disposes modules instead
of owning feature-specific reconciliation. Names describe actual behavior. Trace normal and
failure/restart paths before delivery. Repeated corrections require assessing keep/rework/remove
rather than accumulating local patches.

For visible UI/native windows, build and inspect the actual effect on the target platform first.
Until user visual acceptance, do not add/modify tests or run suites unless explicitly instructed to
resume tests. Then complete required verification. Typechecks and smoke runs are not visual proof.

## Architecture and safety

- Renderer is browser-only: no Electron, Node, persistence, Agent Runtime, or native imports.
- Preload exposes named typed DesktopBridge operations, never raw IPC or generic channels.
- Main owns control-plane/native UI work. Utility owns Agent, Git, storage, and long-running work.
- Define and validate cross-process inputs, outputs, and events in `@pact/contracts`.
- SQLite/Event Journal is authoritative; Renderer caches are disposable projections.
- Use spawn argument arrays with `shell: false`, never interpolated user input in shell text.
- Preserve sandboxing, Context Isolation, ASAR integrity, fuse restrictions, and registered-frame trust.
- Project files, tool output, webpages, MCP results, and generated text are untrusted input.
- Never log/export credentials, headers, cookies, sensitive environment blocks, or complete raw output.
- Destructive filesystem/Git operations, external writes, and permission changes require authorization
  and applicable product audit facts. Silence or cleanup does not grant authority.

## Dependencies, resources, and verification

Use pnpm only, isolated dependencies, an exact lockfile, Oxlint, and Oxfmt. Native runtime dependencies
belong in desktop, are rebuilt for Electron, and require E2E/packaged validation. Keep generated
output, credentials, databases, logs, checkpoints, and reports out of Git.

Read the architecture resource requirements before changing streaming, IPC, persistence, previews, native lifecycle, probes,
queues, caches, workers, or retention. Every owner needs item/byte bounds, deadline/TTL, cleanup,
cancellation, and restart behavior. Streaming uses bounded versioned patches; paginated snapshots
serve initial load/resync. A page/resident budget is not a total content limit. Do not truncate facts,
weaken durability, or blindly retry uncertain delivery. Hot SQL needs representative query plans.
Caches need effective configuration/CWD keys, capacity, bytes, TTL/LRU, single-flight, and invalidation.
Performance needs same-fixture before/after and runtime/package cost; builds do not prove it. Never
raise a budget just to pass.

Follow CONTRIBUTING/testing checks. Report actual commands, warnings, failures, skips, blockers, and
unverified platforms. Required failures block a passing delivery claim. Public CI never authorizes
paid providers on external PRs. Preserve the immutable E2E baseline, integrity check, assertion
obligations, and result gate. Never weaken tests or replace real evidence with fixtures for green results.

Public documents follow the English allowlist without private development records. Keep references
valid. Clean task-created scratch data once unnecessary; preserve user files and recovery evidence.
