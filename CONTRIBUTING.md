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
application's normal Dev database under the OS appData directory in `Pact Dev`. Source and packaged
Dev launches share that application root across branches; Stable uses `Pact`. Existing repository
tool data is preserved and is not automatically copied into the application root.

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

| Lane                        | Command                                                                                | Prerequisites and evidence                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Unit                        | `pnpm test`                                                                            | Vitest; public, isolated fixtures, no paid models                                              |
| Infrastructure              | `pnpm test:infra`                                                                      | Node tests for publication, baseline integrity, coverage, runners, and packaged harness        |
| UI                          | `pnpm test:e2e:ui`                                                                     | Real Electron UI with fixture data; no provider credentials                                    |
| Deterministic               | `pnpm test:e2e:deterministic`                                                          | Electron plus controlled protocols/fixed loads; not real model evidence                        |
| Real provider               | `pnpm test:e2e:real`                                                                   | Installed/authenticated CLIs and private configuration; paid model requests                    |
| Complete E2E                | `pnpm test:e2e`                                                                        | All three Electron lanes; private configuration admitted before the sole build                 |
| Native protocol             | `pnpm test:native`                                                                     | Actual CLI/SDK storage and protocol against isolated loopback providers; no paid models        |
| Packaged smoke              | Manifest-based commands below                                                          | Actual installation/extraction, private data, seed and cold verification                       |
| Packaged visible core       | `node scripts/package-smoke.mjs --manifest MANIFEST --real-core`                       | Trusted local real-provider configuration; manual actual business observations required        |
| Continuous packaged fixture | `node scripts/run-soak.mjs --manifest MANIFEST --duration-ms DURATION --report REPORT` | Isolated protocol fixture; complete duration, budgets, identity and resource evidence required |

Electron runners build the selected lane, use one Playwright worker, zero retries, and a two-hour
total deadline with a five-minute build budget. Forward file names and `--grep` after `--`; do not
override the project's lane with a second `--project`. UI/native changes follow the visual-first
acceptance order in [change discipline above](#change-discipline).

CI configuration and a successful build do not establish repository enforcement or release
acceptance. Required lanes need current code identity, their actual prerequisites and successful
execution on the appropriate native architecture. External PR jobs must not receive private provider
configuration or model credentials. Credential-free UI/deterministic/native protocol evidence is
separate from explicitly authorized real-provider execution; missing authorization, credentials,
platforms or required performance observations cannot become passing evidence.

### Distribution build, smoke, and soak

Use the distribution entry point with a fresh, empty output directory and the native runner for the
target below. Replace `COMMIT_SHA` with the full checked-out commit SHA and `BUILD_NUMBER` with a
decimal build identifier. `version.json` supplies the product version. Dev metadata includes a
compatible prerelease, build number and source identity only during packaging; the command verifies
and restores the desktop package metadata without a version commit.

| Target        | Arguments                        | Installation artifacts  |
| ------------- | -------------------------------- | ----------------------- |
| macOS arm64   | `--platform darwin --arch arm64` | DMG and ZIP             |
| Windows x64   | `--platform win32 --arch x64`    | Separate NSIS installer |
| Windows arm64 | `--platform win32 --arch arm64`  | Separate NSIS installer |

For example, on macOS arm64:

```sh
node scripts/build-distribution.mjs --channel dev --platform darwin --arch arm64 --sha COMMIT_SHA --build-number BUILD_NUMBER --output .pact-data/distributions/dev
node scripts/package-smoke.mjs --manifest .pact-data/distributions/dev/distribution-manifest.json --production-paths --report .pact-data/distributions/dev/smoke.json
node scripts/run-soak.mjs --manifest .pact-data/distributions/dev/distribution-manifest.json --duration-ms 3600000 --report .pact-data/distributions/dev/soak-1h.json
```

The release candidate uses Stable metadata and its own artifacts:

```sh
node scripts/build-distribution.mjs --channel stable --platform darwin --arch arm64 --sha COMMIT_SHA --build-number BUILD_NUMBER --output .pact-data/distributions/stable
node scripts/package-smoke.mjs --manifest .pact-data/distributions/stable/distribution-manifest.json --production-paths --report .pact-data/distributions/stable/smoke.json
node scripts/run-soak.mjs --manifest .pact-data/distributions/stable/distribution-manifest.json --duration-ms 7200000 --report .pact-data/distributions/stable/soak-2h.json
```

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
process runner, installed-content verification, seed/cold identity and confirmed cleanup. Soak must
bind the same final application-content hash and the actual installation artifacts. A same-SHA
rebuild with different application bytes requires new validation. Keep credentials, private paths,
debugging receipts/nonces and raw application output out of published evidence.

The resource report retains each complete SQLite query plan once in `sqliteQueryPlanDictionary`;
sample `queryPlanIndices` resolve into that dictionary. Scalar counters remain in every sample.
The dictionary is bounded to 64 plans/32 KiB serialized bytes, without changing the production
plan budget or the report's 768 KiB limit. Missing observations still block acceptance.

The soak command is a runnable verification path, not a completed acceptance claim. Short runs only
exercise the harness; a two-hour E2E timeout is not continuous soak. The one-hour deterministic and
two-hour packaged acceptance evidence remains incomplete, including the missing observations listed
in [architecture](docs/technical-foundation.md#evidence-known-gaps-and-future-scope). Its report stays
blocked when duration, budgets, observations, recovery or physical cleanup are insufficient.
Windows x64/arm64 installed-launch validation and full Windows/macOS Dev/Stable coexistence, upgrade
and uninstall debugging remain TODO. Code integration does not establish those platform gates.

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

Windows requires PowerShell 7 (`pwsh.exe` on PATH or `PACT_E2E_POWERSHELL_EXECUTABLE`) and the installed
.NET Framework C# compiler. One native Job Object owns the test supervisor, Electron, CLI descendants,
and detached workers with a 256-process limit, no breakaway, and kill-on-close. Admission occurs before
target execution. Control messages are separate from stdout/stderr. Native fixture launchers use the
same Job/argv boundary, independent descriptors and tokens, and a test-process-owned immutable compiled
image installed as private hardlinks. This is a code cache, not a readiness guarantee: each real
first launch still obeys its protocol/deadline. Different-volume link failure must remain visible.

The Windows runner has a 10-second discovery bound, 15-second supervisor startup, five-second natural
tail, five-second closure confirmation, one-second control writes, 64 KiB admission, 4 KiB control
frames, and 256 KiB combined unfinished output. Cancellation, timeout, overflow, runner loss, or
supervisor death releases the owned Job; unconfirmed cleanup fails the job. Redact complete lines and
EOF before emission. A root exit is not enough while its owned tree or pipes survive.

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

### CI control and release recovery

Use separate `pact-control-plane` and `pact-provider-ci` environments. Both permit only the
`main` branch and disable administrator bypass. App credentials belong only to the control-plane
environment; model configuration belongs only to the Provider environment. Do not use repository
secrets for either identity. GitHub App installation tokens are short-lived; the installation and
private key remain configured until explicitly revoked or rotated.

Keep `PACT_GOVERNANCE_READY=false` until the repository can enforce the exact author/reviewer/merger
policy, shared-commit association, current mandatory evidence, and failure/cancellation boundaries.
An asynchronous App result does not prove synchronous revocation. A trusted Provider start job
invalidates the old context before admitting execution, but cancellation before that job and partial
reruns remain unverified. The executor's report trust boundary still requires completion; a mutable local
controller is not OS isolation. Missing authority, configuration, observations or platforms block
acceptance.

The approval policy requires renewed approval when the reviewable diff changes and permits reuse
when that diff is unchanged. Native CODEOWNERS and stale-review dismissal must enforce this per PR;
an App check attached to a shared SHA cannot supply atomic author exemption or review revocation.
Keep approval blocked until the native boundaries, candidate-only check selection, latest-attempt
isolation and trusted main-only workflow bootstrap are verified. GitHub may regenerate a merge candidate with the
same parents and tree but a new commit timestamp. Its new SHA invalidates the exact candidate receipt;
never silently reinterpret old evidence as a test of that new commit.

Release Please owns the single product version and `CHANGELOG.md`. Its initial `0.1.0` override is
transient. Automatic Release PR execution admits synchronized version fields and bounded changelog
text; it does not admit executable changes. The publication controller verifies the owner's actual
head review, fixed source/tag/Release identity, signed content commitment and completed publication
proof before treating a release as complete.

Recover a merged Release PR by starting a **new** Stable Release `workflow_dispatch` with its PR
number. Each successful platform is durably staged in an authenticated, unpublished draft. Recovery
uses the exact staged installer and content-bound smoke/soak reports even after Actions artifacts
expire. A complete signed upload intent can finish its interrupted completion marker. Unknown,
partial-starter or mismatched bytes stop recovery; they are not overwritten or adopted. A frozen
selection cannot be rebuilt into different bytes, and an already published release remains read-only.
The failed-jobs rerun path across producer attempts and recovery after signing-key rotation are not
verified alternatives to this entry point.

The controller bounds each API/evidence document, paginates to establish completion, retains at most
128 authenticated run records and 128 stage attempts per version, and admits at most 32 formal assets.
Exhausted bounds stop admission while preserving records. Do not remove records or raise a limit to
force a release through the gate.

### Immutable coverage obligations

`tests/e2e/baseline.json` packages the exact 21 source files from original revision
`6fade3636a7d77060ec4b35a50cdd764e3726228`. It is source evidence, not an execution report. Its checked
SHA-256 and bounded loader replace dependence on private Git history; a fresh public clone can audit
the unchanged 54 original cases and 631 assertion sites. `coverage-manifest.ts` retains original
identities, assertion mappings, explicit contract revisions, and 12 separately registered business
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
p95/soak are independent evidence categories. Signed/notarized releases, automatic updates, complete
checkpoint disaster recovery, and release performance acceptance remain separate work.

For resource acceptance and the representative benchmark matrix, see [architecture resource requirements](docs/technical-foundation.md#performance-and-resource-requirements).
