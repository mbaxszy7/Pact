# Contributing

## Setup

Use `.node-version` and the pnpm version in `package.json`.
Supported desktop targets are Windows x64, Windows arm64 and macOS arm64. Shared CI
jobs run on macOS arm64. Required platform jobs currently use Windows x64 and macOS arm64
native runners; all Windows arm64 CI is explicitly deferred, not counted as passed.
Its native launcher has exceeded the unchanged 15-second cold-start budget. Restore its
native and Provider jobs together only after that failure is resolved and native-machine
acceptance is complete. The arm64 source implementation and tests remain available.

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

## Windows installer preview

`pnpm dist:win:preview` builds the Windows x64 NSIS installer for visual review. It regenerates the
Windows brand assets, typechecks/builds the desktop app, and writes to the ignored
`apps/desktop/release/installer-preview/` directory. It does not run test suites or publish artifacts.

The preview uses a separate application ID, product name, shortcuts and package name so it does not
replace a production Pact installation. It installs for the current Windows account, allows a custom
directory, offers a desktop shortcut, and leaves Open Pact unchecked. The Start menu shortcut is
always created. Projects, provider configuration and application data are outside the installer-owned
files and are retained on uninstall.

Inspect the actual native welcome, directory, shortcut, progress and completion pages before visual
acceptance. Only then run the applicable checks in [Required verification](#required-verification),
including real installation/upgrade/uninstall checks beyond unpacked package smoke. A preview is not
a signed production release or evidence that runtime, migration, accessibility or platform gates passed.

## Local application builds

`pnpm dev` uses the shared Pact artwork and the `Pact - Development - Local` native application
identity. Its browser profile is partitioned by repository. The existing development SQLite and
historical image/Changes object root are retained; no development data is moved or deleted.

On macOS, `dev` and `start` prepare a checkout-local development `.app` under
`.pact-data/mac-development-runtime/`, with the registry's bundle name, identifier and shared ICNS.
The generated copy is ad-hoc signed without changing Electron's entitlements or Fuses; pnpm's
installed Electron remains untouched. The existing electron-vite CLI runs with that executable,
including normal hot reload. One generated runtime is reused until its source, branding or launcher
changes. Exit the running development instance before starting another from the same checkout.
A forcibly terminated launch may leave `launch.lock`; remove only that generated lock after
confirming the previous instance has exited. This development bundle is not a distribution package.

`pnpm dist:win` and `pnpm dist:mac` explicitly build `Pact - Production - Local`. Its application ID,
executable/bundle name, installation directory, shortcuts, package identity and persistent profile
are distinct from the preserved official `Pact` identity. Outputs are ignored under a fresh
`apps/desktop/release/production-local-PLATFORM-ARCH-BUILD-SHA/` directory. These commands do not
publish or certify a signed release.

From the repository root, build a local unpacked application with
`pnpm package:dir:local --output "$PWD/.pact-data/distributions/local-review"`
using a fresh output directory. After visual acceptance, run
`pnpm package:smoke:local --manifest "$PWD/.pact-data/distributions/local-review/distribution-manifest.json" --unpacked`.
`verify:package:local` is an alias for this manifest-required smoke command; it does not build.
`package:dir` builds CI Dev, while `package:smoke` and `verify:package` also require the exact
generated manifest. Smoke never guesses an executable from an old output directory.

CI development and production use distinct registry identities. Validated development packages are
delivered by Actions; formal releases use the protected-main pipeline. Packaged identity comes from embedded metadata,
not the launch environment. Project files and native provider configuration remain user-owned and
shared; application identity does not establish a cross-process Project writer lease.

The canonical logo is [resources/icon.svg](apps/desktop/resources/icon.svg).
`pnpm --filter @pact/desktop brand` regenerates PNG, Windows ICO and macOS ICNS from that source.
Windows installer bitmaps are reviewed committed inputs: regenerate them explicitly with
`pnpm --filter @pact/desktop brand:win` on Windows. Ordinary builds retain those bytes because
SVG text otherwise depends on host fonts and dirties a clean distribution checkout.
The same generator builds monochrome Windows tray artwork and macOS Template images
from their canonical SVGs. Inspect tray, packaged taskbar navigation and Pact exit confirmation on
the actual platform before running their formal tests. Windows development supports tray navigation
and Session JumpLists for the running repository-specific instance; after a full exit,
start it with `pnpm dev`. Packaged Session JumpLists also support cold launch. macOS
packaging/native appearance still requires verification on macOS.

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
[resource requirements](docs/technical-foundation.md#performance-and-resource-requirements) for the area you change. Test observable behavior through the
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

The tool default `.pact-data/dev/pact.sqlite` is an isolated repository database, separate from the
local source database and historical object roots without moving existing data. CI Dev uses the OS appData `Pact Dev` root across branches; Stable uses `Pact`. Local browser profiles and local Production data remain isolated under their existing names.

`db:migrate:dev` and `db:studio` run `packages/persistence/scripts/development-database.ts` through
tsx and `PactDatabase.open`. They hold the sibling `.pact-writer.sqlite` reservation for their actual
process lifetime; Studio imports its server in that same process, listens on `127.0.0.1:4983` and is
not packaged. `PACT_DB_FILE` selects an explicit tool database. Keep it in a controlled development
environment and close any Pact instance using that data directory. The reservation coordinates Pact
and these wrappers; raw Drizzle/SQLite commands, legacy clients and manual edits can bypass it.

Application startup owns read-only, complete ordered migration-history verification before writable
opening, WAL adjustment or migration. Only a proven complete prefix can upgrade after a consistent
non-overwriting backup; new databases use checked atomic staging. Incompatible history and failed
backup/migration stop startup and preserve recovery files. See [database ownership and limits](docs/technical-foundation.md#persistence-and-projections).
Never target user application data with routine development commands, invoke raw migration/Studio
against a live Pact root, use `drizzle-kit push`, or add a production migration shell command.

## Required verification

| Change                                              | Checks                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| Documentation/configuration                         | `pnpm docs:check`, `pnpm format:check`, relevant narrow checks   |
| TypeScript                                          | `pnpm check`                                                     |
| Renderer/Main/Preload/Utility or IPC lifecycle      | The above and applicable Electron E2E                            |
| Native dependency, fuse, protocol, or packaging     | The above and explicit native distribution/installed smoke below |
| Native history, settings, Fork, or writer lifecycle | Relevant `pnpm test:native` cases                                |
| Streaming/resources/performance                     | Same-fixture measurements and applicable performance budgets     |
| Test infrastructure                                 | Relevant `pnpm test:infra` cases                                 |

The [testing section below](#testing) identifies commands needing credentials or paid models. Run the
affected real-provider lane in a trusted local environment when its unique behavior changes; public
CI's deterministic evidence is complementary. Report commands actually run, failures, skips, warnings,
deferred checks, and unverified platforms. Missing evidence cannot establish a passing gate.

## Documentation policy

The reviewed Markdown allowlist is `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `CHANGELOG.md`, the product and
architecture specifications under `docs/`, and desktop `PRODUCT.md`/`DESIGN.md`. `scripts/check-publication.mjs` enforces exact paths, English text, local
links, and absence of private/generated material.

Publication inspection owns at most 4096 paths (1 MiB total, 1 KiB per path), reads only the eight
reviewed documents (128 KiB each, 512 KiB total), and emits at most 128 diagnostics/64 KiB. Overflow
fails visibly. Binary/source content is inspected by the secret scanner, not retained by this policy
checker. Local documentation links must stay inside the repository.

Maintain one authority per topic: product behavior and vocabulary in requirements, ownership and
numerical budgets in architecture, contribution and test operation in this guide, visual rules in
DESIGN. Other documents link to it. PRODUCT remains short design-tool context. Keep DESIGN's frontmatter,
`.impeccable/design.json`, and four approved references consistent with the implementation.

Update specifications with behavior. Distinguish implemented features, planned work, and unresolved
decisions; preserve limitations and regression obligations. Do not commit chat transcripts, temporary
plans, delivery journals, private machine paths, or verification reports. A new document requires
a maintenance purpose existing documents cannot serve and review of its allowlist change. Retain
legally required notices.

## Security and privacy

Do not commit credentials, provider homes, environment files, databases, checkpoints, logs, traces,
or raw user/agent output. Ignore rules do not protect tracked/forcibly added files. Test credentials
must be unmistakably nonfunctional; never broadly exempt test directories from scanning.

## Testing

### Evidence and commands

| Lane                  | Command                                                          | Prerequisites and evidence                                                              |
| --------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Unit                  | `pnpm test`                                                      | Vitest; public, isolated fixtures, no paid models                                       |
| Infrastructure        | `pnpm test:infra`                                                | Node tests for publication, baseline integrity, coverage, runners, and packaged harness |
| UI                    | `pnpm test:e2e:ui`                                               | Real Electron UI with fixture data; no provider credentials                             |
| Deterministic         | `pnpm test:e2e:deterministic`                                    | Electron plus controlled protocols/fixed loads; not real model evidence                 |
| Real provider         | `pnpm test:e2e:real`                                             | Installed/authenticated CLIs and private configuration; paid model requests             |
| Core real provider    | `pnpm test:e2e:real:core`                                        | The `@real-core` business cases; the same actual CLIs and isolated configuration        |
| Complete E2E          | `pnpm test:e2e`                                                  | All three Electron lanes; private configuration admitted before the sole build          |
| Native protocol       | `pnpm test:native`                                               | Actual CLI/SDK storage and protocol against isolated loopback providers; no paid models |
| Packaged smoke        | Manifest-based commands below                                    | Actual installation/extraction, private data, seed and cold verification                |
| Packaged visible core | `node scripts/package-smoke.mjs --manifest MANIFEST --real-core` | Trusted local real-provider configuration; manual actual business observations required |

Electron runners build the selected lane, use one Playwright worker, zero retries, and a two-hour
total deadline with a five-minute build budget. Forward file names and `--grep` after `--`; do not
override the project's lane with a second `--project`. UI/native changes follow the visual-first
acceptance order in [change discipline above](#change-discipline).

Native workspace journeys use the ordinary Pact Quit action and confirm pending work before waiting
for physical process exit. `tests/e2e/native-quit.ts` provides this bounded teardown; an Electron
context close alone can wait indefinitely at the application's exit confirmation. macOS Dock
navigation cases exercise the actual native menu and durable cross-Project recent order. Their
stale-response check pauses only the validated fixture Utility PID, resumes it in `finally`, and
requires the newer selection to survive without creating Messages or Runs. These UI/protocol
fixtures do not establish real-provider execution. The macOS Project-context journey disables Playwright focus emulation before checking actual window return events, and checks clipboard equality inside Main without emitting clipboard contents. The migration fixture applies the original migration prefix through 0060 before testing 0061/0062, comparing all legacy columns and the consistent pre-upgrade backup. Named shared-helper assertion revisions retain the exact helper owner and all registered replacement assertions; the immutable baseline is never regenerated.

CI configuration and a successful build do not establish repository enforcement or release
acceptance. Required lanes need current code identity, their actual prerequisites and successful
execution on the appropriate native architecture. Automatic external PR jobs must not receive private
provider configuration or model credentials. Credential-free UI/deterministic/native protocol evidence is
separate from explicitly authorized real-provider execution; missing authorization, credentials,
platforms or required performance observations cannot become passing evidence.

### Core and extended real-provider policy

Keep the full `@real` lane. Each real case also has exactly one Playwright tag:
`@real-core` or `@real-extended`. The reviewed case inventory in
`scripts/real-e2e-policy.mjs` gives each existing case its business scenario and tier.
Discovery must match that inventory and its tags; a missing, new, duplicate or retagged
case cannot silently change the merge gate. Test titles, assertions and the immutable
baseline remain unchanged.

Automatic CI requires the existing `@real-core` business case on Windows x64 and macOS arm64:
`real @all completes each Agent once and keeps ordered distinct response rows`. It launches the
actual App, creates a Project and Session, sends one `@all` message, and verifies that Codex and
Claude each finish one real Run with separate responses and a released Composer. Missing replies,
invalid configuration, failed source integrity, cancellation or uncertain cleanup block acceptance.
Extended real, UI and deterministic cases retain their assertions and remain available through the
explicit local commands above. Unexecuted cases are reported as deferred, never passed.

`ci-native.yml` runs for maintained `dev` pushes and PRs targeting `main`. Its reusable
`distributions.yml` has independent quality, per-platform native protocol, package, installed-smoke
and real-core jobs. Each job checks out the exact event commit. The unconditional `CI complete`
check rejects every missing, failed, cancelled or unexpectedly skipped mandatory dependency.
Packaging and installed smoke have no model credentials or repository write token. Only real-core
jobs use the model environment; build, test and publication never share one omnibus job.

Repository writers are trusted with test credentials and model spending before review. Model
configuration stays in `pact-provider-ci`, with native ref restrictions and no runtime approval.
External forks receive public credential-free checks only. Missing core evidence cannot claim a
complete acceptance pass. GitHub's own external-contributor workflow restrictions remain applicable;
privileged events are not used to execute fork code around those restrictions.

Safe case reports record source SHA, native Actions run and producing attempt, platform, outcomes
and fixed failure categories. They exclude raw model output, configuration and credentials. Local
reports use only a clean source identity and never claim a CI receipt. Filtered runs list unexecuted
obligations; neither discovery nor a scoped run proves full regression. Existing local UI diagnostics
retain their combined 32 MiB bound. Failed or physically uncertain fixtures retain recovery evidence.
Actions reports and candidate artifacts retain 14 days. Installed smoke downloads its exact package
artifact ID and records the consumed digest; same-run successful producers may retain an earlier
attempt. Native summaries list actual cases, including failed and unexecuted entries.

### Product version and release intent

`version.json.version` is the runtime product version. Root and desktop package versions are
synchronized by standard Release Please extra-file updates. The initial empty release manifest and
`initial-version: 0.1.0` select the first release without a permanent override or a second intent
marker. A first version PR may add its changelog and manifest while application versions already
read `0.1.0`.

Release Please uses a repository-scoped App token only for version PR maintenance and labels, so
its PRs start CI automatically. Its action uses `skip-github-release: true`; it does not publish or
merge. The App key remains in the main-only `pact-control-plane` environment and is referenced only
by that job. The separate publisher uses the native job token. Neither environment requires manual
runtime approval. Owner-authored PRs need passing CI but no Approve; other authors, including the
version bot, need the owner's effective Approve. Reviewable changes dismiss stale approval. All
merges are owner-operated squash merges; automatic merge stays disabled and CI has no bypass.

### Distribution build and smoke

Use the distribution entry point with a fresh, empty output directory and the native runner for the
target below. Replace `COMMIT_SHA` with the full checked-out commit SHA and `BUILD_NUMBER` with a
decimal build identifier. `version.json` supplies the product version. Dev metadata includes a
compatible prerelease, build number and source identity only during packaging; the command verifies
and restores the desktop package metadata without a version commit.

| Target        | Arguments                        | Installation artifacts  |
| ------------- | -------------------------------- | ----------------------- |
| macOS arm64   | `--platform darwin --arch arm64` | DMG and ZIP             |
| Windows x64   | `--platform win32 --arch x64`    | Separate NSIS installer |
| Windows arm64 | Deferred (TODO)                  | No CI/Release installer |

For example, on macOS arm64:

```sh
node scripts/build-distribution.mjs --channel dev --platform darwin --arch arm64 --sha COMMIT_SHA --build-number BUILD_NUMBER --output .pact-data/distributions/dev
node scripts/package-smoke.mjs --manifest .pact-data/distributions/dev/distribution-manifest.json --production-paths --report .pact-data/distributions/dev/smoke.json
```

The release candidate uses Stable metadata and its own artifacts:

```sh
node scripts/build-distribution.mjs --channel stable --platform darwin --arch arm64 --sha COMMIT_SHA --build-number BUILD_NUMBER --output .pact-data/distributions/stable
node scripts/package-smoke.mjs --manifest .pact-data/distributions/stable/distribution-manifest.json --production-paths --report .pact-data/distributions/stable/smoke.json
```

For pre-merge validation of either CI identity, dispatch `ci-native.yml` on the maintained branch
with channel `dev` or `stable`. This runs the same separate jobs and installed-byte checks;
dispatch never publishes a formal release. A successful preflight does not establish live
protected-main publication. Ordinary branch and PR validation needs no readiness switches.

Local production uses the same entry point with `--profile production-local --channel stable`; its name and existing data directories remain separate from both CI channels. Local `dist:mac`, `dist:win`, and `package:dir:local` select this profile. Smoke commands require the exact generated manifest.

The manifest identifies the exact executable/bundle, channel/version, source SHA, architecture,
application identity, application-content hash and installation-artifact hashes. Smoke does not guess
fixed `Pact.app` or `Pact.exe` paths. Add `--artifact ARTIFACT_PATH` to validate the other artifact
listed in that manifest, such as the macOS ZIP, with a separate report. A directory-only build adds
`--dir` and smoke adds `--unpacked`; that report cannot satisfy an installation gate. NSIS installation
smoke requires a native ephemeral GitHub-hosted Windows runner and verified uninstall cleanup.

`--production-paths` explicitly checks normal OS channel paths before Utility, a database, providers
or diagnostic Workers start, retaining the real single-instance rule. It does not open user business
data. The isolated `PACT_E2E_ROOT` phases alone do not establish those normal paths. Do not invoke the
explicit production-path probe against an occupied daily instance. Native dependencies are rebuilt
for Electron; Windows distribution signing and macOS certificate signing/notarization are disabled,
with necessary macOS ad-hoc signing retained.

Reports are written without overwriting previous evidence. Smoke success requires the genuine owned
process runner, installed-content verification, seed/cold identity and confirmed cleanup. Reports
bind the final application-content hash and the actual installation artifacts. A same-SHA
rebuild with different application bytes requires new validation. Keep credentials, private paths,
debugging receipts/nonces and raw application output out of published evidence.

Smoke admission and execution failures also write a bounded `status: blocked` report after
cleanup is attempted. It records a fixed failure phase/code, validated identity when available,
and separate application-process, installation, provider-copy and private-root cleanup facts.
Unknown process release or failed installation cleanup retains the owned recovery directory;
neither deleting a directory nor calling terminate proves physical process cleanup.
Release Actions retain these reports in `smoke-PLATFORM-CHANNEL-aATTEMPT` even after
failure, separately from the successful artifacts eligible for release publication.

Windows arm64 installer build, installation acceptance and publication are deferred (TODO).
Windows x64 installed-launch validation and full Windows/macOS Dev/Stable coexistence, upgrade
and uninstall debugging still require their actual evidence. Code integration does not establish those platform gates.

### Private real-provider configuration

Supply these native files in the ignored directory:

```text
tests/e2e/env/
  claude/settings.json
  codex/config.toml
  codex/auth.json
```

Each test copies their bytes into its private provider homes. Source files are never rewritten and
their hashes are verified after execution. Missing configuration, authentication, placeholders, or
configuration escaping isolation fails before launch. Tests do not fall back to daily CLI auth files.
Set `PACT_E2E_ENV_DIR` for another configuration directory and `PACT_E2E_CLAUDE_EXECUTABLE` /
`PACT_E2E_CODEX_EXECUTABLE` to select absolute CLI paths; otherwise discovery uses PATH. Model and
endpoint choices come from the native configuration. Do not put actual values in documentation,
issue attachments, environment dumps, traces, or committed example files.

Each fixture owns its project, Git configuration, HOME/XDG/AppData, Claude/Codex history, database,
Electron userData/sessionData, temporary directory, and diagnostics. Run only on those identities.
Close owned resources and verify source integrity before cleanup. Never delete daily native history,
locks, existing projects, or user databases. Real-provider traces/screenshots remain disabled; bounded
redacted metadata is the failure evidence. Protocol fixtures are not credentials or authentication
success substitutes.

### Platform process ownership

Windows command supervision requires the installed .NET Framework C# compiler and reuses the same
bounded compiled image as native fixture launchers; it does not compile C# inside PowerShell at each
command start. Provider scenarios that execute PowerShell still use `pwsh.exe` on PATH or
`PACT_E2E_POWERSHELL_EXECUTABLE`. One native Job Object owns Electron, CLI descendants,
and detached workers with a 256-process limit, no breakaway, and kill-on-close. Admission occurs before
target execution. Control messages are separate from stdout/stderr. Native fixture launchers use the
same Job/argv boundary, independent descriptors and tokens, and a test-process-owned immutable compiled
image installed as private hardlinks. This is a code cache, not a readiness guarantee: each real
first launch still obeys its protocol/deadline. Different-volume link failure must remain visible.

The Windows runner has a 10-second discovery bound, cold compiler preparation bounded to 30 seconds
and the remaining command deadline, 15-second supervisor startup after compilation, five-second natural
tail, five-second closure confirmation, one-second control writes, 64 KiB admission, 4 KiB control
frames, and 256 KiB combined unfinished output. Runner cancellation uses helper stdin EOF, separate
from its authenticated receipt pipe; target stdin remains NUL. Cancellation, timeout, overflow, runner loss, or
supervisor death releases the owned Job; unconfirmed cleanup fails the job. Redact complete lines and
EOF before emission. A root exit is not enough while its owned tree or pipes survive.
The command's private compiled link and descriptor are removed only after its helper has closed and
its output pumps have settled. If `go` might have been sent, the actual Job must also report empty;
otherwise the trusted helper's closed process proves that no Job was admitted. An error event alone
does not prove process closure. Unconfirmed release retains private files as recovery evidence.

macOS retains verified descendant process groups. Normal exit allows a five-second natural tail;
failure uses bounded TERM/KILL and five-second confirmation. Identity is PID plus birth and PGID,
rechecked before signalling. Limits are 256 process identities, 16 active groups, 1-second/256 KiB/
4096-row process queries, and 256 KiB output. Temporary identity uncertainty does not permit claiming
new members or prevent cleanup of other verified groups. Never enumerate command lines/environment
for ownership or kill by process name. Exceeding the 16-group admission limit still retains every
verified rejected group for cleanup under the same 256-identity bound. Unknown identities retain
their reservation until physical absence is confirmed; one group's failure cannot prevent cleanup
of independently verified groups.

The optional ownership diagnostic is synchronous and void. Its fixed PID/PPID/PGID/birth/state
snapshots are at most 64 KiB and 256 identities/groups, contain no command lines or environment,
and cannot change the execution result. An invalid return or exception disables that observer;
accidental asynchronous rejection is observed once without admitting a Promise queue. Scoped
runner regressions do not establish a complete real-provider suite or Windows acceptance.

`run()` accepts an optional `posixOwnedGroupLimit` integer from 1 through 16 to tighten admission;
its default remains 16 and it rejects this POSIX option on Windows. Production execution does not
read the infrastructure test environment. CI script tests run one file at a time and use a fixed
test-only limit of three, so their real boundary fixtures fit inside the unchanged outer supervisor.
Direct default-budget acceptance still exercises the actual 16-group success and 18-group refusal:

```sh
pnpm exec node --test --test-name-pattern='selected owned-group boundary|rejected excess groups' scripts/run-e2e.test.mjs
```

Run that command without `PACT_INFRA_POSIX_OWNED_GROUP_LIMIT`. The CI-sized fixtures do not replace
the default-budget evidence. All rejected groups must be confirmed closed before the test fixture's
independent emergency cleanup; invalid limits fail before process admission.

Standalone Windows NativeRpc helpers retain their ten-second/16 KiB compilation budget and private
nonce-directory lifecycle. A native fixture entry has a ten-minute ceiling. NativeRpc completion
waits for inherited stdio and helper cleanup; ordinary native EOF remains exit zero, while intentional
relay cancellation retains its own failure code. Job-empty settlement must preserve forced failures.

### Real business evidence

Real cases observe typed Bridge outcomes, SQLite facts, native history, and physical tool effects:
routing/continuation/peer isolation, permission scope, frozen settings, Fork/Rebuild, occupied-writer
input return, images, capacity, Stop, changes, Undo, and restart. Require exact native/run identity,
input counts, original content hashes, and actual effects where relevant. A brief acknowledgement need
not echo a random marker: check the marker was received and a complete nonempty authentic answer was
saved. Do not weaken a genuine user-content requirement into that transport check.

Controlled continuous streaming tests keep a real Electron/Bridge/Utility/Adapter/SQLite Turn alive
until `turn/interrupt` (at most 120 deltas, one timer, 60-second bound). They check draft, Comment,
continuation, and cold preservation independently of model response duration. They complement both
actual CLIs' Stop settlement and physical command cessation. Codex Stop terminates only identities
attributed to the current root command; historical/background/peer work is excluded. Five-second
control settlement, 64 identities/64 KiB, and 64-page/256 KiB native reading remain bounded. Capability
probing is two seconds/64 KiB/256 lines, generation-scoped, without persisted readiness caching.

Claude Stop/peer fixtures may choose a real catalog-supported low effort within their isolated Session;
settings tests independently prove actual effort effects. Source provider configuration remains exact.
Approvals are current native request actions only, scoped once or to the fixture Session. No retained
permission grant or automatic broad access is a valid test repair.

Fault relays may pause requests/drop one genuine ACK; they cannot fabricate answers, model text,
authentication, or native completion. Synthetic atomic state publication retries only the same rename
for transient Windows locks, bounded to 250 ms/32 attempts; it does not retry a model request or write
JSON in place. Diagnostics preserve the actual failing boundary before fixture disposal.

### Native protocol regression

`pnpm test:native` fails on absent/unrecognized actual CLIs; it never substitutes the Electron fake.
Selection uses PATH or `PACT_NATIVE_CODEX_EXECUTABLE` / `PACT_NATIVE_CLAUDE_EXECUTABLE`. The CI seam uses
Codex 0.159.2, Claude Code 2.1.272, and the pinned desktop SDK; other versions/platforms need their own
results. It builds actual production Adapters/Workers into a temporary fixture.

Claude initializes copied candidates with zero model input, tests effort precedence and null/default
inheritance, and verifies exact source bytes, candidate identity, initialization manifests, and cold
readiness. Codex creates genuine two-Turn loopback history, forks an older prefix and then the branch,
retains opaque reasoning/cutoff/lineage, tests writer exclusion and natural release, and names/renames
native children through the production interface. Both test empty-history rebuild and changed/missing
manifest rejection without inventing initialization input or paid generation.

Limits are ten seconds/RPC, 50 seconds/raw client, four pending RPCs, 128 requests/client, 512 events,
1 MiB/frame, 8 MiB/stream/file, 64 KiB stderr, 2 MiB total provider input, 16 provider requests, and
eight sockets. Claude's non-model HEAD probe is allowed; model POSTs fail. Codex initialization adds
no provider requests beyond the two fixture source Turns. These test-harness limits are not production
large-content policy. Cleanup owns every root, bundle, process, and socket, including failures.

### Native CI and release recovery

The main release workflow first resolves whether its exact push commit is the merge of a standard
version PR. Only that commit can become the release source. Ordinary main pushes maintain the next
version PR without publishing. Every Stable executor uses the resolved immutable SHA, not a later
main tip or a one-time `release_created` action output. The installed NSIS artwork is included in
the Windows unpacked payload, so its bytes participate in the same strict content manifest.

After both platforms' protocol, core and installed-package checks pass, the separate publisher
admits exact package and smoke artifact IDs, archive digests, source, version, native target and
producing attempts. It treats downloaded artifacts as bounded data, never executable publisher
code. Each actual DMG/ZIP/NSIS hash, application content hash, cold restart, default data root and
physical cleanup receipt must match. Rebuilt bytes require a new matching installation report.

The publisher creates or reconciles one Draft for the exact tag/version/source, uploads the complete
verified asset set, downloads and hashes the uploaded bytes, then publishes an immutable Release.
GitHub's native Release attestation, its tag commit and asset hashes are verified after publication;
this is release integrity evidence, not a claim of independent build attestation. Existing same-name
assets must be byte-identical; ambiguous delivery, conflicting Drafts, expiry or missing evidence
stop recovery. Published assets are never replaced. No platform staging releases or signed run
ledger provides a second recovery route.

Use GitHub's failed-jobs rerun with the original run. Successful producers may come from an earlier
attempt; package IDs and consumed digests, not the consumer's current attempt number or an artifact
name, govern reuse. Source changes or artifacts from another run cannot substitute for those bytes.
After publication and verification, the publisher idempotently marks the exact version PR
`autorelease: tagged` and removes `autorelease: pending`, including already-published recovery.
Only then does the standard version-maintenance job process the latest main changes, so a release
failure or a missing label transition cannot silently finish the cycle.

API JSON is bounded to 2 MiB per response, release evidence to 4 MiB per manifest, and each native
asset to 2 GiB. Publication admits at most 32 assets, streams binary hashes, paginates at most 100
pages of 100 items, has a 30-minute operation lifetime and at most 1024 API operations. Exhaustion
fails visibly without discarding facts or retrying an uncertain write. Live main-only acceptance
requires an actual version PR, manual owner merge, automatic publication, downloaded integrity
verification and a subsequent automatic version PR cycle. Pre-merge tests do not prove those steps.

### Immutable coverage obligations

`tests/e2e/baseline.json` packages the exact 21 source files from original revision
`6fade3636a7d77060ec4b35a50cdd764e3726228`. It is source evidence, not an execution report. Its checked
SHA-256 and bounded loader replace dependence on private Git history; a fresh public clone can audit
the unchanged 54 original cases and 631 assertion sites. `coverage-manifest.ts` retains original
identities, assertion mappings, explicit contract revisions, and 14 separately registered business
expansion obligations. Do not regenerate the baseline from current tests or reset its obligations.

```sh
node scripts/check-e2e-coverage.mjs --json
node scripts/check-e2e-coverage.mjs --results-json playwright-report/evidence/full.json --require-results --json
```

The first command checks source and discovered targets but cannot certify acceptance without results.
Missing/changed assertions, missing targets, unsupported replacements, skips, or failed cases remain
errors. Contenteditable replacement requires the same locator, string, and exact equality. Revised
Comment quota sites retain explicit eleven-draft/no-warning/editor/cold-restart obligations. The
deterministic `context_limit` negative branch is an explicit existing exception; it does not claim a
real provider rejected a small context. Real source refusal is a distinct obligation.

Combine up to eight JSON execution reports, 16 MiB total, in chronological order using repeated
`--results-json`; each report is at most 8 MiB. The last real result governs each case and earlier
failures remain in its history. Reports should live outside Playwright's disposable `test-results/`.
Do not generate success reports from source discovery or suppress real targets because public CI
cannot supply credentials.

### Failures, release checks, and known limits

Classify failure at catalog/setup, dispatch, native receipt, provider/tool output, persistence,
Renderer interaction, or physical cleanup. Authentication, unselected tools, assertion errors, and
product errors are different. Capture bounded redacted identities/counts/state before teardown. A
later passing run does not explain or erase an earlier failure. Use new fixture identities for
sampling; never blindly resend an uncertain native request. Keep one worker and zero retries.

Quarantine needs concrete evidence, preserved alternative coverage, a re-enable condition, and user
authorization. Required invariants without replacement evidence remain blockers. Do not fix tests by
raising budgets, changing provider/permissions, weakening assertions, or replacing the user task.

Packaged smoke validates manifest identity/content, `app.isPackaged`, `app://`, Utility, SQLite,
fuses, ASAR, seed durability and independent cold restart with private data. `--real-core` uses the
same explicit manifest, preserves production fuses and does not
inject a testing Bridge; observe actual provider replies/file effects and cold identity/content
preservation. A visible window or exit zero alone is not business acceptance. Select an instance by
its exact executable and fixture project; stop if native automation targets another instance.

Latest Windows work includes scoped protocol/launcher passes after full-suite timing failures, but
does not establish a common cold-launch root cause or full Windows acceptance. The first cold
executable-instance tail and settings command output discrepancy remain investigation limits. Do not
carry historical macOS success counts forward as a current Windows claim. Native protocol GUI-free
results, UI alpha, actual desktop composition, paid model runs, package smoke, signing, and performance
p95 are independent evidence categories. Signed/notarized releases, automatic updates, complete
checkpoint disaster recovery, and release performance acceptance remain separate work.

For resource acceptance and the representative benchmark matrix, see [architecture resource requirements](docs/technical-foundation.md#performance-and-resource-requirements).
