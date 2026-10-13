# Testing

## Evidence and commands

| Lane                  | Command                                      | Prerequisites and evidence                                                              |
| --------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| Unit                  | `pnpm test`                                  | Vitest; public, isolated fixtures, no paid models                                       |
| Infrastructure        | `pnpm test:infra`                            | Node tests for publication, baseline integrity, coverage, runners, and packaged harness |
| UI                    | `pnpm test:e2e:ui`                           | Real Electron UI with fixture data; no provider credentials                             |
| Deterministic         | `pnpm test:e2e:deterministic`                | Electron plus controlled protocols/fixed loads; not real model evidence                 |
| Real provider         | `pnpm test:e2e:real`                         | Installed/authenticated CLIs and private configuration; paid model requests             |
| Complete E2E          | `pnpm test:e2e`                              | All three Electron lanes; private configuration admitted before the sole build          |
| Native protocol       | `pnpm test:native`                           | Actual CLI/SDK storage and protocol against isolated loopback providers; no paid models |
| Packaged smoke        | `pnpm verify:package`                        | Actual unpacked application, isolated data, seed and cold verification                  |
| Packaged visible core | `node scripts/package-smoke.mjs --real-core` | Trusted local real-provider configuration; manual actual business observations required |

Electron runners build the selected lane, use one Playwright worker, zero retries, and a two-hour
total deadline with a five-minute build budget. Forward file names and `--grep` after `--`; do not
override the project's lane with a second `--project`. UI/native changes follow the visual-first
acceptance order in [CONTRIBUTING](../CONTRIBUTING.md).

Public CI scans history and publication policy, runs quality/build and infrastructure checks, and
executes UI/deterministic Electron tests plus packaged smoke on macOS and Windows. Native protocol CI
installs pinned CLIs on macOS and uses dummy authentication/loopback endpoints. External PR jobs do
not receive private provider configuration or model credentials. Real tests remain enabled for
trusted local validation; public CI is not evidence that those model cases passed.

## Private real-provider configuration

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

## Platform process ownership

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
for ownership or kill by process name.

Standalone Windows NativeRpc helpers retain their ten-second/16 KiB compilation budget and private
nonce-directory lifecycle. A native fixture entry has a ten-minute ceiling. NativeRpc completion
waits for inherited stdio and helper cleanup; ordinary native EOF remains exit zero, while intentional
relay cancellation retains its own failure code. Job-empty settlement must preserve forced failures.

## Real business evidence

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

## Native protocol regression

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

## Immutable coverage obligations

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

## Failures, release checks, and known limits

Classify failure at catalog/setup, dispatch, native receipt, provider/tool output, persistence,
Renderer interaction, or physical cleanup. Authentication, unselected tools, assertion errors, and
product errors are different. Capture bounded redacted identities/counts/state before teardown. A
later passing run does not explain or erase an earlier failure. Use new fixture identities for
sampling; never blindly resend an uncertain native request. Keep one worker and zero retries.

Quarantine needs concrete evidence, preserved alternative coverage, a re-enable condition, and user
authorization. Required invariants without replacement evidence remain blockers. Do not fix tests by
raising budgets, changing provider/permissions, weakening assertions, or replacing the user task.

Packaged smoke validates `app.isPackaged`, `app://`, Utility, SQLite, fuses, ASAR, seed durability, and
independent cold restart with private data. `--real-core` preserves production fuses and does not
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

For resource acceptance and the representative benchmark matrix, see [performance](performance.md).
