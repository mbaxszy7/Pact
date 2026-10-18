# Architecture

This document describes the current implementation and its boundaries. [Product requirements](product/requirements.md) define behavior, [resource requirements below](#performance-and-resource-requirements) define resource budgets, and [the contribution guide](../CONTRIBUTING.md#testing) defines verification. Read [CONTRIBUTING](../CONTRIBUTING.md) before changing these contracts.

## Processes and trust

```text
React Renderer → named DesktopBridge in Preload → Electron Main → Utility Process
                                     ↕ @pact/contracts ↕       → SQLite / native CLIs / Git
```

| Boundary              | Responsibility                                                                                           | Restrictions                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Renderer              | Disposable projections, draft editing, named actions                                                     | Browser code only: no Electron, Node, database, Agent Runtime, or native dependency imports |
| Preload               | Typed `DesktopBridge` and removable subscriptions                                                        | Never expose raw `ipcRenderer`, arbitrary channels, or generic filesystem/process methods   |
| Main                  | Windows, native dialogs/menu/theme, Renderer authorization, Utility transport, bounded Directory workers | Compose feature Modules; keep feature policy in its existing owner                          |
| Utility               | Agent/Git/recording/Undo, probes, image/document processing, persistence                                 | Keep long CPU/I/O work off the streaming event loop when necessary                          |
| `@pact/contracts`     | Strict cross-process DTOs, normalized events, pure workflow rules                                        | Validate inputs, responses, and events at each trust seam; no privileged imports            |
| `@pact/persistence`   | SQLite/Drizzle repositories, atomic facts, Journal, migrations                                           | SQLite is authoritative; no Renderer database access                                        |
| `@pact/agent-runtime` | Provider-neutral `AgentAdapter` interfaces and execution inputs                                          | Native protocols stay private to each desktop Adapter                                       |

`RendererTrust` registers a live Pact window before navigation. Only its current main frame, loaded from the configured development origin or `app://bundle`, can invoke IPC. Packaged builds ignore development URLs. Outgoing publication checks both WebContents and main-frame URLs. Navigation, crash, destruction, close, and disposal release registrations/interests. Popups are denied; approved external links go through the existing Main window owner.

Keep Renderer sandbox, Context Isolation, ASAR integrity, and packaging Fuse restrictions enabled. Treat Project content, tool output, web content, generated text, and native input as untrusted data. Never interpolate user input into shell commands. Spawn executables with argument arrays and `shell: false`. Windows npm `.cmd` compatibility uses constrained fixed `cmd.exe` commands, verbatim arguments, and executable-path metacharacter refusal; it is not a general shell interface.

## Owners and entry points

| Module / primary interface                                                                           | Callers                                                      | State, side effects, and lifecycle                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AppearanceController.refresh/update/reset`                                                          | Main startup, named appearance IPC, windows                  | Main owns effective theme/material, revision ordering, publication, and theme/window listeners; Utility owns persisted preferences; detach/dispose removes resources                 |
| `RuntimePreparation.inspectReadiness/selectExecutable`                                               | Onboarding, settings, Conversation                           | Utility owns discovery and bounded version/auth probes; SQLite owns paths/first-use marker; each probe closes its child                                                              |
| `DefaultSessionSettings.loadEditorState/saveDefaults`                                                | First use, App settings, SessionWorkspace                    | Utility owns zero-input catalogs and actual probe disposal; one transaction saves defaults and completes onboarding                                                                  |
| `ProjectCatalog`                                                                                     | Native folder picker and named catalog IPC                   | Utility validates canonical directory identity/mutations; repository owns rows; archive never edits Project files                                                                    |
| `SessionWorkspace`                                                                                   | Creation/settings/catalog IPC                                | Utility validates Project-scoped settings; repository owns Session/settings revisions; Renderer editors are disposable                                                               |
| `Conversation.send/actOnCollaboration/retry/rebuildNativeContext/forkSession/dispose`                | Named Main/Preload operations                                | Sole admission/execution/routing owner; owns preparation, Adapters, interactions, source grants, subscriptions, cancellation, and settlement                                         |
| `ConversationRepository`                                                                             | Conversation, source reads, recovery, Fork                   | Durable Message/Run/Comment/Batch/Todo/source/review facts, indexed pages, CAS gates, transactions                                                                                   |
| `AgentAdapter`                                                                                       | Conversation                                                 | Codex App Server or Claude SDK encoding, native connections/Queries, actor identity, observed work, checks/Fork; retains responsibility until actual cleanup                         |
| `codexProcessEnvironment`                                                                            | Codex startup/inspection/recovery; owned native test clients | Owns bounded child-only loopback MCP proxy exclusions. Preserves external proxy/source environment; Adapter owns connection/process lifecycle.                                       |
| `ProjectFileReader.read`                                                                             | File/Skill previews, Comment validation                      | Session-bound descriptors with path/encoding/size/stability checks; closes in `finally`                                                                                              |
| `WorkspaceChanges`                                                                                   | Native callbacks and named review/Undo                       | Passive capture, immutable versions, recording finalization, preflight, installation/recovery; repository owns metadata/intents                                                      |
| `ConversationImages`                                                                                 | Conversation and three named image operations                | UUID source/thumbnail files, segmented I/O, holds, physical codec Workers; repository owns immutable refs                                                                            |
| Renderer `useConversation` / `ConversationView`                                                      | App workspace                                                | One selected-Session projection, draft/pending/returned-input authority, source navigation, virtual Transcript; switch/unmount cancels read generations                              |
| `ApplicationMenu` / `DiagnosticLogs`                                                                 | Main composition                                             | One native root menu and bounded editor receipts; metadata logging with one file Worker and explicit close                                                                           |
| `resolveApplicationIdentity/readProductIdentity` / `configureApplicationProfile/resolveRuntimePaths` | Main startup and packaged path inspection                    | Registry owns immutable identity; runtime-paths owns profile/session/log and durable paths before readiness and single-instance locking.                                             |
| `PactDatabase.open/close`                                                                            | Utility startup and development database tools               | Sole compatibility/backup/migration owner; holds the data-directory writer reservation through business use and physical close; failed cleanup prevents another open in that process |
| Distribution builder `main`                                                                          | Explicit local and CI packaging commands                     | Owns temporary version injection, native build, hashes and manifest; retains previous outputs and restores source metadata on every settlement.                                      |
| Packaged `prepareApplication/completePackagedSmoke`                                                  | Manifest-based smoke commands                                | Owns installation/extraction, private fixtures, process admission, receipts/deadlines and cleanup; reports bind exact app/artifact contents.                                         |
| `RuntimeHealth.performance` / `PactDatabase.performanceDiagnostics`                                  | Isolated diagnostic fixtures through named health operations | Utility owns isolated opt-in event-loop/resource and database/query-plan probes; database/Utility disposal removes them. Snapshots omit SQL bindings and business contents.          |

Entry points compose and dispose these owners. Do not add a parallel Controller, Store, Gateway, scheduler, permission engine, or recovery path for an existing concern. A new seam needs real behavioral variation or a process/trust boundary. State each affected Module's responsibility, interface, callers, resource owner, and lifecycle before extending it.

Codex child exclusions cover the native environment-proxy transport. The native `RespectSystemProxy`/PAC route can ignore environment exclusions and is not established by that verification. Windows transport, HTTPS CONNECT and arbitrary external MCP compatibility require their own evidence; the helper is not a guarantee for every native proxy configuration.

## Application identities and local builds

One finite registry supplies packaging and Main identities. Source launches use local development;
local Production stays separate, CI Dev uses `Pact Dev`, and Stable uses `Pact`. Packaged identity
comes from immutable metadata, with CI channel/source/build/platform/architecture checked against
the registry, package version and native runtime. Conflicting profiles fail before Utility starts.
Launch environment cannot select another packaged identity. One startup manifest read is bounded
to 16 KiB; only validated identity scalars survive it, with no queue or retry.

The sole runtime-path owner configures profiles before readiness and the single-instance lock.
Fixtures create only private profiles. Normal local development retains repository-partitioned
browser data, `.pact-data/dev/pact.sqlite` and historical
`Pact/workspace-versions-development/<repository hash>` image/Changes objects. Local Production
retains its separate profile. CI channels use their own normal OS roots; no directory is automatically
moved, copied or deleted. Managed Project files and native provider homes/authentication remain shared
according to their existing owners.

Packaged Windows AUMIDs use the registry. Source development appends the normalized profile-path
SHA256; process, window and launch entries use that same effective ID, preserving per-repository
Shell separation. The toolkit must not replace the development executable. The window owner retains
native build titles across HTML updates. Mac development Dock PNG and packaged ICNS share canonical
SVG artwork and optical margins. Builder names, IDs, executable/shortcut/uninstall names agree.
Installer execution/publication remain gated by platform acceptance.

The development launcher prepares the Mac bundle before handing off to the existing electron-vite
CLI in the same Node process; only `dev`/`start` call it. Windows uses installed Electron. One ignored
checkout-local runtime and one staging copy permit 8192 entries/1 GiB source, one 45 s cancellation
deadline, 64 KiB command output and no retry. Plist edits/ad-hoc signing preserve entitlements/fuses.
A SHA256 receipt covers executable generation, plist, registry entry, ICNS and launcher; changed inputs
replace generated files, and failure removes staging without publication. An exclusive lock remains
through CLI exit with no queue/stale reclamation. Forced termination requires proven exit before lock
removal. No application-data migration or new resident process is introduced.

## Persistence and projections

Drizzle schema files are authoritative. Application queries/writes/CAS/transactions use Drizzle; `better-sqlite3` supplies PRAGMAs, backup, health, and close. Review committed forward migrations/snapshots. `PactDatabase.open` owns startup compatibility and applies pending migrations in Utility before ready; developer migration/Studio use the same entry point and never replace application startup migration. No schema push on application databases.

For disk databases, an exclusive SQLite transaction on the sibling `.pact-writer.sqlite` reserves the canonical data directory before inspection. The owner retains that connection across compatibility checking, backup, migration, business use and physical close. OS process termination releases its file locks; unconfirmed cleanup during opening retains handles and blocks further opens in the process. This is a cooperative reservation for Pact and the wrapped database tools. It does not exclude arbitrary SQLite clients, legacy tooling or manual filesystem edits that bypass the reservation.

Existing data first opens read-only. The ordinary rowid migration table must have the known column/key shape; views, extra or hidden columns, shadowed ordering and unproven table shapes fail closed. Compare every applied row in insertion order with the packaged migration's complete SQL-byte SHA256 and migration identity. Exact history opens normally; a complete prefix receives a uniquely reserved consistent backup before any writable opening, WAL adjustment or forward migration. Newer, divergent, absent or malformed history stops startup without clearing or rebuilding data. SemVer and the latest timestamp cannot establish compatibility.

New databases initialize in a private staging file, verify the complete migration history, then publish atomically without overwriting a concurrent file. Existing backups are never overwritten; failed backup targets, migration backups and incomplete initialization files retain their recovery value. Typed startup failure facts cross the Utility/Main seam, where one native prompt offers the trusted data-directory entry and quit. Failure does not trigger an automatic downgrade, replay or reset. Opening and migration bounds are defined in [resource requirements](#application-distribution-and-database-startup).

`PactDatabase` invokes `ConversationRepository.recoverAbandonedBodyInputs` once while it owns startup;
constructing a query projection alone performs no recovery writes. Test-only active observations use
an owned fixture's native readonly connection, without WAL changes or migrations, and explicitly close
their bounded query/lease owner. They cannot acquire or release the application's writer reservation.

### Native presence and resident lifecycle

Main composes one `NativePresence` owner for tray, close-to-hide, Windows JumpList, macOS Dock,
navigation and quit confirmation. Show, activation and second-instance events reuse the window;
the window owner recreates a destroyed window. Only the current trusted frame invokes named,
schema-validated operations. Launch arguments contain one Session UUID and cannot select profiles,
Projects, paths, URLs or provider configuration. Packaged Windows tasks use the current executable.
Development tasks use the exact Electron executable, quoted absolute app root, a 32-hex-character
identity marker and UUID. Main validates one matching marker before the profile lock and verifies
the compiled entry in the 16 KiB package manifest. The command envelope is 8192 units; Windows
relaunch properties allow 255 UTF-16 units. Overflow reports actual length and refuses launch.
Mismatched, malformed and legacy bare markers exit without contacting another profile. Markers
never reconstruct profiles. Matching ownerless development entries exit before runtime/window
startup, without starting Vite or loading stale Renderer code. Relaunch metadata is set before show.
Removed tasks must match the exact executable/canonical argument prefix. Disposal removes macOS
menus/Template resources and clears Windows categories unless pending removals require retention;
guarded stale development tasks remain inert without their live owner.

Before JumpList publication consumes Windows removal records, Main durably acknowledges all
validated removed UUIDs, including rows outside the current menu. The existing 64-ID bound remains;
overflow or failed acknowledgements retain OS records and defer publication. Idempotent out-of-view
acknowledgements do not force refresh. SessionWorkspace/repositories own opening order/receipts,
visibility and suppression. An accepted selection atomically records its UUID receipt and monotonic
ordinal; same-UUID readback cannot move MRU again. These durable facts do not cap Session history.
Native navigation reads catalog metadata without directory probes, Adapters or conversation bodies.
Presentation acknowledges only the latest successful intent; stale completion cannot replace a newer
selection. Settings, Fork and image views add no execution/cancellation owner.

Conversation projects physical Running rows from existing Adapters and exact execution/check/
Rebuild/Fork references. Preparation decorates existing Recent rows as Starting. Private interactions
supply sanitized status; attention shares the workspace's pure Session-issues predicate. Transactions
update Session flags and Project/global counts together. Initialization pages precede metadata
availability; recovery touches indexed pending scope, and archive/restore only the affected Project.
Progress/token events and native reads never recompute/write metadata; unread answers remain separate.

Quit preparation seals admission only after matching known-idle preflight; it neither flushes nor
releases resources. Active, late or unavailable results require confirmation. Cancel awaits the same
operation's response; confirmation authorizes the existing physical shutdown owner. System logout
bypasses confirmation. Unconfirmed physical exit retains tray/window. After owner cleanup, Utility
publishes bounded final MRU before database close and shutdown ACK. Main retains cold recent tasks
and honors removed entries. There is no new shutdown deadline, replacement runtime or mutation replay.

### Archive and other projections

Workspace archive coordination belongs to Conversation. Named prepare/read/cancel operations pass
through frame-validated Main and the typed Preload bridge; Renderer owns one disposable confirmation
and updates catalog/Undo only on confirmed success. The archive repositories retain Session/Project
mutation ownership. SQLite archive operation receipts bind an immutable scope and captured task
identities to a nonce. Confirmation claims the scope in a transaction before requesting supported
cancellation; admission and final archive commit honor the persisted scope barrier. Stop acknowledgement
alone is insufficient: execution/preparation, native background effects and existing Changes
finalization must settle. The Changes owner shares its actual finishing promise. Native uncertainty
retains a barrier and readable receipt; restart does not repeat Stop or complete an interrupted
archive. Reading a settled failed operation releases its barrier without archiving. Same-nonce success
readback is idempotent. Session archive metadata remains authoritative across late Run status writes.
Main claims the selected browser profile's single-instance lock before Utility starts; another launch
reveals the existing window. Different identities and repository-partitioned development profiles
retain independent locks.

`appendAgentEvent` allocates each Session Journal sequence within the same SQL insertion/transaction. Callers must not reserve `MAX(sequence)+1` before nested appends can consume it. Rollback preserves sequence/fact consistency. Journal accompanies repository transitions; it is not yet complete replay or disaster recovery.

Steady mutations produce changed-entity `conversation-patch-v1` Patches, including receipts. Paginated Snapshots serve initial load and explicit resync. Observation incarnation/sequence, body/detail revision, introduction order, and Journal sequence fence different races; they are not interchangeable clocks. Gaps/reordering/new Utility incarnation trigger bounded around/latest reads, preserving reading anchors when possible. Completed Markdown does not reparse on Composer input. Catalog SQL derives latest activity/unread through indexes rather than historical JavaScript aggregation.

Main propagates selected/visible interests through one bounded chain. Utility suppresses uninterested body progress while retaining durable facts, terminal/unread/header changes, and receipts. Renderer installs listeners before fetching, awaits interest ACK, and retains only a bounded early-Patch window. Settings keeps one hidden/inert selected Conversation, not per-Session DOM. Reading Retry only reloads pages; it is distinct from Agent Retry. Session replacement retires stale reads/details/navigation/selections.

React Query owns asynchronous Renderer cache/deduplication, pagination, mutation status, and targeted invalidation through centralized keys. It does not own persistent facts, execution state, or token streams. Local UI/drafts stay with their existing React owner; no second workflow store mirrors SQLite.

## Runtime, settings, and catalog

Discovery uses saved paths, inherited PATH and platform lookup. Version/auth commands report Missing, Authentication required, Startup failed, Cannot verify or Ready without reading credentials. Ready proves startup/auth, not quota/network/model success. Other terminal exports cannot change the App. First use needs both Agents; degraded readiness preserves history but blocks Agent work. Utility failure needs restart; absent results show `Not checked`.

Claude catalogs use the selected executable and SDK `supportedModels()` over idle input; Codex uses initialized App Server `model/list`. Neither starts a model Turn. DefaultSessionSettings owns admitted catalog operations/probes, including actual child close after SDK `close()` schedules termination. Utility awaits disposal before shutdown ACK. Concrete Model/Effort is revalidated in the target Project context with no substitution.

Canonical directory path is Project identity enforced by SQLite uniqueness. Root `.git` distinguishes Git/ordinary directories; selection does not promote nested directories/bare repositories. Native editing works under provider permissions for both classes. Archive hides metadata without deleting files/history; re-add restores ID and saved name. Rename changes only the active display name by primary key and returns a small receipt. An uncertain mutation requires successful readback before another write, with no automatic repeat.

Session creation copies current global defaults and commits Revision 1 atomically. Later saves create immutable settings revisions; started work keeps its frozen revision, new settings apply to subsequent work. App-default changes do not rewrite existing Sessions. Archive retains history/revisions; no shipped Renderer operation physically deletes Project/Session data. Project removal cannot orphan Sessions.

## Input, routing, and immutable sources

Send freezes body/images, route, Skills, Comment revision and client ID; direct execution also freezes settings. Queue acceptance freezes complete sources without a Run; dispatch freezes current settings. Same-ID retries read their receipt, changed input conflicts, and late ACK preserves newer drafts/IME. Sealing dispatches nothing. Preparation failure preserves input.

Absent explicit routing, Send freezes Primary. Explicit targets do not change Session roles. `@all` is exactly two ordered Turns, Primary then Secondary, sharing original input. Secondary's older Handoff stops before the current User: it does not receive Primary's current answer. That answer is durable and enters a later ordinary Handoff. Failure/Stop/unknown delivery prevents an unstarted stage; only an already authorized, never-created Secondary stage may continue after explicit successful recovery. No parallel calls or third synthesis Turn.

Peer proposals are validated inert structured facts, never prose detection or Adapter-to-peer calls. One user click authorizes one target Turn through the same send path, preserves drafts, and does not change Primary. Source/control/generation checks reject stale actions.

Body headers/parts preserve original bytes/order/revision/digest. Referenced Message/Run/report material is durable rather than temporary quota data. Segments/references replace whole-Session copying. Native termination, body sealing, and UI publication are distinct. Dependent Handoff/Fork/workflow actions need complete sources. Processing failure retains known terminal/original/partial material and never permits replay. Cold complete-history limits remain in [resource requirements below](#performance-and-resource-requirements); arbitrary-history expansion is not implemented.

Input Batches replace the total ten-Comment rule. Send freezes all authoritative drafts, including unloaded pages. Members/responses are indexed paginated facts, not growing header ID arrays. Ordinary, collaboration, Handoff, Rebuild, return, and Fork preserve identical frozen sources. Every reader is bound to exact Session/Run/Actor and unguessable grant. Adapter retains its one current grant until native root end/cancel/committed replacement; foreground observation ending alone cannot revoke valid reads. Old-owner cleanup cannot retire a new grant.

Current top-level user instructions retain authority; frozen copies and historical/project/tool/anchor data grant none. Ordinary source guidance reads relevant refs; collaboration requires complete frozen indexes/required inputs. Internal prompts/protocol IDs stay out of natural Message/Copy/quote display.

## Comments, editor, Skills, and files

Comments are durable Session drafts/sent records. Message anchors retain source SHA, explicit basis (`markdown-visible-v2`, retained v1, or plain fallback), UTF-16 range, and quote. File anchors retain Project-relative path, byte hash, one-based Monaco range, and LF quote. Todo/answer anchors freeze Task/Todo/question revisions. Shared parser/projection rules preserve coordinates with one Text child per projection span. Icons/transformed semantic labels cannot invent quote offsets. Navigation verifies hash/exact quote; stale sources show immutable snapshots instead of guessed nearby text. Sealed Comment sources cannot be extended by archived output.

Saves CAS expected revision and reuse draft/request identity for uncertain ACK. Definite conflict cancels obsolete reads, reloads authority, preserves editor/selection, and requires explicit Add again. One question revision has one unanswered draft; separate discussion Comments remain separate. Batch ACK publishes the transaction's actual Comment revision. Returned clones retain private operation provenance outside loaded pages; claim rechecks indexed eligibility before idempotent return.

`useConversation` owns canonical drafts/pending/return receipt. `ComposerEditor` owns browser edits, opaque atoms, UTF-16 selection, IME, list projection, and inverse history through one transform/resolver. Document/Session/receipt replacement clears obsolete history. Refused edits preserve original facts. New Send of returned input uses current syntax; outstanding pending/unknown requests retain original route/parameters.

Conversation owns Skill discovery/admission, source-qualified identity, independently resolved bindings for both `@all` targets, and cancellation. Native paths/frozen evidence remain private. Claude requests native Skill loading and reports observed outcomes; Codex sends exact structured Skill items. Neither guarantees eager preload. Native plan/build/review Skills remain distinct from Pact entries. Skill preview resolves opaque identity through current catalog and ProjectFileReader; logical cancel cannot free active physical reads. ApplicationMenu targets only focused valid Composer; failed/expired commands never silently fall through.

Relative previews enforce canonical Project containment. Explicit external absolute previews use the same Session-bound reader with `isExternal`; UI and Utility both refuse external file Comments. Read-only preview acquires no Changes/Undo ownership. Buffers/serialized replies remain bounded; growth/binary/UTF-8/path/availability errors are visible. Lazy Monaco owns models/listeners/language Workers and cleanup. Large unknown text uses plain mode; native paged fallback preserves access if Monaco fails. The last JSON model disables/invalidate shared service client; the next acquisition recreates it safely.

## Collaboration tasks and settlement

`/plan`, `/build`, `/review` share existing Contracts/Conversation/Repository/Adapter/views. They install no provider Skill and create no native Plan Mode workflow. Task freezes entry/request/duties/roles/scope/plan-or-review basis/required input. Each action authorizes one root Turn; questions/supplements imply no peer chain/summary/implementation/repair. Structured validation may involve multiple provider requests inside that Turn.

Primary owns one plan; Secondary may draft. Exact initial adoption records `plan_adoption`; revisions need peer review. Frozen implementer/reviewer own code stages. `/build` authorizes implementation; `/review` and replies stay read-only until explicit repair/continue. Adapters enforce scope through native permissions.

Only native final `pact-collaboration-envelope-v5` output updates Pact. Preserve its carrier separately from natural answer, plan and indexed operations; prose, code blocks and native TodoWrite are not submissions. Markdown fallback retains complete source/plain anchors. Processing failure preserves native ending and hides protocol JSON.

One transaction validates root/generation/duty/basis and every delta/response, saves immutable revisions/reviews, advances counts and contiguous watermark, and records once-only application. Duplicates are idempotent; stale/conflicting sources or missing/duplicate/foreign members roll back. Terminal/report order is arbitrary. Only the original completion-failure revision permits automatic reconciliation; later input/pause/resume/duplicate ending cannot renew it.

Todos have stable IDs/revisions; Open/Awaiting review remain pending. Done records reason/source/disposition. Implementers propose; responsible reviewers confirm exact revisions. Resolvers may close exact questions from real sent input, never invent peer acceptance. Revised questions reopen and invalidate old answers. Reject cross-task/self/cyclic merges; reopening needs evidence. Runtime enforces identity/revision/authority; reviewers detect semantic duplicates.

Responded is not resolved. Continuous watermarks cannot skip failed inputs. Acceptance uses the complete ledger and required members, never page/count/native ending. Durable `planReady` differs from transient `dispatchAllowed`; runtime failure preserves review. New edits/scope retire code acceptance. Review basis identifies target, source Run, recorded changes and checked evidence, without workspace snapshots or drift detection.

Report recovery preserves rejected source/feedback, frozen duty and incomplete facts; it only formats original work. Reads cannot erase action failures. Supplements retire old duty only when materialized; refusal preserves it.

Conversation owns one durable Session queue through received-input storage and typed Bridge operations. Repository CAS serializes mutations; paged, revision-fenced recovery survives read/ACK failures. Stop/failure/restart pause delivery; normal ending, sealed output and drained effects gate it, after `@all` Secondary.

Steer freezes Run/generation/duty/settings. UUID/final proof fences native incorporation, not handling; Codex uses user-message completion, never ACK alone. Frozen Skills remain Run-owned; stale carriers stay archival and resolver obligations persist. Unknown never replays. Claude keeps one Query; Codex requires its exact Turn.

Accepted Steer freezes full sources in one Run. Only canonical sources feed native history. Full body, terminal and settled effects permit collapse; reversal resyncs. Work Log joins the final answer collapsed. One live preserve UUID and one historical target share 25/page,100/window; generations fence folds. Source sequence/hash/Comment ranges stay exact. No suffix slicing or whole-Run hydration.

Context owns one current Plan/Todos view with finite pages and one detail/editor. Historical versions remain separate from current Pending/Done counts. Comment navigation waits for source/body DOM before consuming its identity; explicit repeated navigation can locate the same source anew. Plan refresh follows execution boundaries, not Deltas or typing.

## Native permissions and recovery truth

Speed uses Session/Agent revisions and starts Native. Patches share settings single-flight,30 s RPC and optional25 s readback; no polling/retry. Settings-page saves preserve Speed/permissions. Codex overrides one Turn; Claude merges its flag with Effort, checks Fast metadata and preserves Model/Effort. Neither writes native configuration. Requested/observed Speed and bounded reasons are Run facts; ACK proves no acceleration. Steer retains one pending input/Run; final proof reserves8 KiB+512 B/response. Uncached checks: Claude one Query,10 s within startup30 s; Codex200 models/256 KiB,pages25,10 s within acceptance.

Native capabilities/policy/Tools/MCP/Skills/Hooks/subagents remain native-owned. Task instructions constrain scope without rewriting global configuration. Native permissions remain independent of Pact review. Session choices are independently Native/Ask/Auto/confirmed Full for each Agent; new Sessions use Claude Ask/Codex Native. Immutable revision stores choices; every Run freezes its mode. Changes during execution apply next task, never answer current approval. Lost saves use readback, not repeated grants.

Claude Native omits override and inherits sources; Ask maps default, Auto native auto, selected Full native bypass with opt-in. Auto gates input until the same Query initializes/confirms mode; absent capability metadata is not refusal proof. Negative ACK/transport/init evidence remain distinct. Codex explicit Ask/Auto use native workspace policy, Full native full access. Fresh exact loaded-Thread readback can confirm unchanged policy; otherwise matching settings notification is required. Empty RPC success alone is insufficient. Windows implicit-native continuation resolves verified effective defaults under the existing inspection owner, never an old Thread's explicit grant. Custom profile ID cannot prove definition/config-generation equivalence.

Conversation owns operation-bound native permissions/questions/forms/URLs and once-only response. Rules/templates/schema/answers/full authorization URLs remain transient; only safe summaries/actual decisions are durable. Offer only native one-call/Turn/current-Session actions, no persistent command/network/settings-destination amendments. Claude suggestions must all be Session-scoped without coercion/splitting. Main opens a live reviewed HTTPS/loopback HTTP authorization URL only on explicit click. Consent is not login success; Pact does no token exchange or token/password collection.

Dispatch, foreground Run status, native outcome, body completeness, background work, and Pact Abandoned are separate. Deadline/silence/absent observer/file age/historical Completed/another candidate success prove no termination. Unknown delivery is durable and never blindly retried. Recovery Retry is pure checking, not initialize/resume/reexecute. There is no public reexecution or automatic startup model replay.

Endings persist before body flush. Failed output keeps incomplete durable prefixes; the sole reader observes terminal/Steer/work facts. Failed buffers cannot cross input cuts or accept reports. Empty frames use no answer identity. Claude cold checks require saved live termination and Session existence; `end_turn` is insufficient. Its bounded reader recovers partial text without proving completion. Codex requires exact Thread/Turn, legal terminal metadata, nonactive status and later-Turn evidence. Accepted complete bytes/row/revision stay immutable; recovery preserves execution connections.

Explicit Rebuild freezes original Run/source/settings/nonce and persists creation identity before I/O. Adapter creates/seeds one candidate, verifies full readback/natural completion/work settlement/witness, then one transaction switches ID/generation and retires old intent. Claude uses one canonical false-only envelope with deterministic UUID/hash; per-chunk receipts are invalid assumptions. Codex reads only metadata-identified native rollout under effective root; injected context need not appear as a Turn. Failure/unconfirmed leaves old binding. Candidate Retry inspects only that candidate; another creation needs confirmation. Abandonment changes Pact disposition without asserting old work stopped. Late old-generation facts stay archival and cannot affect current title/permissions/proposals/unread/continuation.

Successful Rebuild excludes definitely unsent input and creates one durable return receipt while retaining original rows. Restore reads exact body/image/Skill/route/Batch sources, clones drafts once, preserves newer edits. Claim/send settles atomically. Native generation fences an operation, not permanent draft identity; restart never sends restored input automatically.

SessionIssues projects one recovery row per Agent and the input gate. Complete answer is not ready binding. Live ownership controls admission; historical unknown effects remain visible without a permanent Send lock. Codex `willRetry:true` or lost foreground cannot retire a healthy observer; root/work drain settles it, gaps remain unknown.

## Native Fork, Changes, and Undo

Dialogue Fork requires both native histories at a completed answer's frozen cut. Conversation atomically copies history/settings/consent/intents/Catalog receipt and owns both candidates. Lost ACK reads the same nonce before admission. Failed committed children remain visible/read-only for inspection and explicit continuation. One ID map covers all sources; beyond-cut dependencies are unavailable. Inheritance grants no task, dispatch, write or old Undo authority.

NativeForkFiles owns one bounded Worker. Codex verifies paginated parents, opaque bytes and sealed ordinal/byte/SHA prefixes; rejects cycles, unknown formats, later cuts and unstable/append races. Source cut and initialized inheritance are separately proven. Claude verifies full prefix/UUID mapping/initialization/settlement; same-Run Steer history uses exactly consumed native inputs (at most64/8 KiB). Windows suffixes require installed schema/identity/bounds. Candidate history alone is not ready; unknown formats/compaction refuse safely. All versions/Hooks/MCP remain uncertified.

WorkspaceChanges passively records completed/applied result paths. It does not intercept writes, snapshot entire Project/HEAD, change native permissions, or fabricate old endpoints from current bytes. Immutable hashed evidence/indexed metadata survives restart. Root ending may expose recording while background capture is owned; recording-capacity failure is separate and visible. Incomplete/mixed/binary/oversized evidence disables Undo, not editing.

Undo covers all listed card files, not entire Project or unlisted effects. Reliable full endpoints use Git inverse three-way `current / round-after / round-before`; complete before plus patch can privately derive after. Partial hunks permit review, never relocatable reverse matching. Before/After are independently readable; continuous patches retain original order without pretending to be net diff.

All path/object/hash/mode/candidate preflight completes before mutation and revalidation. Conflict/incomplete/timeout/cancel means zero Project writes. Multi-file installation is not atomic: post-start drift/I/O/crash retains intent/actual backups, stops later writes, reports incomplete Undo. Startup reconciles without Project writes or forced restoration over external edits; only successful completion marks undone. Unknown historical modes allow disclosed text-only Undo preserving current regular-file mode; ownership/ACL/xattr/unsupported add/delete/rename/mode/binary restore is not invented. No Redo/model Turn/Git reset/index/branch change/context/external-effects rollback.

## Images, appearance, and diagnostics

Images are UUID originals/thumbnails outside Project, with ordered immutable refs. Bytes/Base64/paths never enter Patches/Journal/ordinary logs. Main owns selection/trusted document identity; Renderer gets refs/parts. Cancel/removal cannot resurrect draft imports; durable Message/Fork/return refs survive temporary cleanup. Claude actual image blocks and Codex localImage/multimodal history carry original group. Native conversion is not compared with Pact original SHA or downgraded to text. Native compaction never rewrites Pact history or triggers hidden recap/Rebuild. Sharp is desktop runtime dependency in Utility codec Worker, covered by packaged restart smoke. Slides own URLs/reads; close/switch waits for actual Worker settlement before freeing physical capacity.

Appearance is App-global, separate from Session revisions. One controller owns requested/effective material, windows/theme listener, revision ordering, and uncertain-write gate; OS theme cannot unlock it. macOS and supported Windows Translucent use transparent `#00000000` backing plus semantic Alpha: no macOS Vibrancy, no Windows Mica/system backdrop. Windows Solid is constructed opaque with native thick-frame styles; both Windows modes retain native Window Controls Overlay. Solid is complete accessibility/platform/error fallback preserving preferences. Never use whole-window opacity as a material preference; the Main window owner's bounded visibility fade applies only to macOS and transparent-backed Windows and restores opacity 1. Visible strength 0–100 maps stored 100–70/default 85; surfaces vary and text/code/focus stay readable. Selected API state/page Alpha is not compositor proof: validate actual rear-window pixels/native controls/package per platform. See [DESIGN](../apps/desktop/DESIGN.md).

Before constructing the first workspace, Main waits for the validated Utility `runtime.ready.event`
and then reads Appearance through its ordinary RPC. Utility publishes readiness only after its
existing request handler and required owners are initialized; it is not Agent/provider readiness.
`UtilityProcessClient.waitUntilReady` owns one shared wait and one timer per live child. The first
10 s absolute deadline starts at fork, separate from the unchanged 2 s read deadline. Timeout does
not release or restart the child; an explicit Retry can wait again, and a late ready event does not
create a workspace automatically. Ready, exit, shutdown and disposal settle the wait and clear its
timer; replacement-child events cannot settle another child's wait. This startup bound is not a
measured cold-start performance guarantee.

Only after a successful read, `getWindowAppearance` pins the Windows startup preference
and its resolved native material using the existing material policy. Every recreated workspace in
that process uses the same native material; subsequent saves update durable preferences but apply
the pinned background choice until full exit. Main projects optional `restartRequired` through the
existing validated Appearance snapshot, not a new database field or IPC operation. Theme and strength
remain live. Accessibility still paints Solid immediately; an opaque window cannot apply newly
permitted translucency without restart. Calling it before settings are loaded fails instead of
inventing a preference. NativePresence owns startup Retry/Exit and uses its existing native quit
fallback while no Renderer is available, including cancellation retry and unconfirmed physical exit.
Main only composes startup and the existing safe shutdown; late reads cannot bypass a pending quit.
The controller retains only two finite material values, adds no timers,
queues or listeners, and releases the startup pin on disposal. Existing revision and uncertain-write
reconciliation remain authoritative.

Window external-link owner accepts only credential-free bounded trusted HTTP(S), one physical launch. Timeout reports failure but retains active OS slot; no repeat. Other schemes/credentials/oversized URLs fail. This is distinct from live native authorization consent.

Diagnostics uses validated finite operation/method/code/source/executor metadata. No arbitrary console/Error/stdout/stderr interception, token Deltas, full Sessions, credentials, or replacement of durable facts. One Main Worker owns private rotating JSONL; producer credits include in-flight ACK copies, saturation is summarized, and close/debug/maintenance/watchdogs clean up. Development/production stores are separate. Renderer gets specific status/fault methods, never arbitrary log writing.

## Distribution channels and packaged verification

The shared registry owns four identities: local development/Production, CI `Pact Dev` and Stable
`Pact`. CI development branches share one channel; local data and historical object roots remain
unchanged. Profile configuration precedes the single-instance lock; fixture overrides do not prove
normal production-path correctness.

`version.json` owns the product version. Distribution verifies desktop version and checked-out SHA,
injects a compatible Dev prerelease/build/source identity or Stable version, then hash-checks metadata
restoration. Windows x64/arm64 produce NSIS; macOS arm64 produces DMG/ZIP. Each target has separate
native protocol, package, installed-smoke and core E2E jobs gating delivery and publication.
Certificate signing/notarization stay disabled; macOS retains ad-hoc signing.
Native dependency rebuilding, sandboxing, Context Isolation, ASAR integrity and fuses remain required.

The manifest binds channel/version/source/OS/architecture/identity, artifact hashes and final signed
application-content hash. Smoke validates exact installed/extracted bytes, native dependencies and
cold restart. Directory-only checks cannot satisfy installation acceptance. The normal-path probe
exits before Utility, database, providers, Renderer or diagnostic Workers and retains single-instance
rules. Explicit local profiles use the same manifest-based verification without becoming CI Releases.

These interfaces require actual platform evidence for coexistence, upgrades and uninstall cleanup.
Publication uses the exact merged version-PR source and same-run package IDs/digests with matching installed evidence. A separate main-only publisher reconciles one Draft, verifies uploaded bytes and native immutable Release integrity, then finalizes standard version labels before maintaining the next PR. Native review rules exempt only the owner-author; CI is never bypassed and Merge stays manual. Model and version-bot environments use ref restrictions without runtime approvals. Missing evidence, expired artifacts or uncertain writes stop; no signed controller, staging Release or alternate recovery path is retained.

Release uploads contain four installers: macOS arm64 DMG/ZIP and Windows x64/arm64 NSIS EXE; GitHub supplies source
archives and native attestation. Full validation remains mandatory. Package/smoke evidence and
aggregate manifests/checksums stay in Actions artifacts for 14 days; published Releases stay immutable.

## Verification and remaining scope

Trace a normal action and failure/restart through these same owners for lifecycle changes. Main closes admission and awaits Conversation/default-settings requests, owned work, durable flush, and logs before quit. Unconfirmed physical release retains reservation/evidence. POSIX OwnedProcessGroup validates PID/PGID/birth before signaling and confirms absence. Windows test Jobs prove fixture release; they are no production supervisor.

Real integrations/conversations/routing/Comments/Skills/images/collaboration/native editing/Undo/recovery/Fork/appearance are implemented. Foundation-only narratives and obsolete total-content gates no longer apply. [Contributing](../CONTRIBUTING.md#testing) records methods and unverified scope; builds/scoped repeats cannot prove full suite, packaged percentile, all-platform, or signed-release acceptance.

Remaining: complete Checkpoints/Journal replay, validated recurring backup/restore, reference-aware retention, arbitrary-history expansion, Utility supervision/readiness caching, signing/notarization, updates and release acceptance. Channel/package identity proves no release gate; migration backup is not disaster recovery. Disclose unknown delivery, legacy formats, review scope and non-atomic Undo. Preserve evidence/full sources; never hide limits with automatic model work.

## Performance and resource requirements

Performance is a correctness property for long-running local Sessions on macOS and Windows. The following numerical budgets, resource owners, cleanup rules and benchmark requirements are normative. Processing and residency bounds do not silently limit or truncate durable content.

### Required invariants

- High-frequency work scales with changed entities, never total retained history. Steady streaming performs zero complete Session reads/validation/clones/publications. Complete paginated Snapshots are initial/resync reads only.
- Every collection, cache, queue, request, stream, timer, listener, worker, child, and temporary allocation has one named owner, item/byte bounds, deadline/TTL, cancellation, cleanup, and restart behavior. A physically unresolved resource retains its reservation; logical timeout is not release.
- Preserve original bytes, accepted delivery, completed Messages, Comments, images, immutable carriers, and recovery evidence. Do not truncate, reorder, weaken acknowledged durability, skip trust validation, silently delete, or replay possibly delivered input to meet a budget.
- Keep visible cadence distinct from durable cadence. Terminal/error/shutdown flush immediately; title/formatting/view work cannot delay authoritative native ending.
- Background Sessions without visible interest publish no foreground-rate body progress. Determinate/header/unread/receipt facts remain deliverable.
- Bounded UI preserves keyboard/screen-reader access, focus, exact Comment anchors, reverse navigation, and reading position. Manual browser Selection is disposable when its Message leaves view; established Comment sources remain immutable. Jump to latest explicitly clears ordinary Selection.
- Hot SQL needs representative `EXPLAIN QUERY PLAN`, bounded result/lookup counters, and indexes. Do not load whole tables and filter/aggregate in JavaScript.
- Native I/O has abort/deadline/final settlement. Unsent, possibly sent, accepted, native-ended, body-sealed, and work-drained are distinct. Silence/timeout never proves native termination. Retry is pure checking; there is no automatic replay.
- Cache keys include effective executable/configuration/CWD generation and relevant binding/executor. Use capacity, byte budget, TTL/LRU, single-flight, explicit invalidation. Ready/auth state is not indefinitely cached.
- Separate platform evidence. A macOS result does not verify Windows, build success does not verify performance, and scoped reruns do not turn a failed broad run into a full pass.
- An in-scope acceptance failure blocks delivery. Raise no budget to obtain passing results without new product evidence and user approval. Existing documented gaps may be preserved by unrelated work but not worsened.

Project context remains a disposable Renderer projection. ProjectCatalog resolves the saved canonical directory and reads Git HEAD in Utility through the existing bounded Git owner. Branch inspection checks at most 128 ancestor directory markers under the same read deadline, stopping at the nearest `.git` file/directory or filesystem root. Nested selections retain their exact Project identity/classification; only branch metadata follows the containing repository. Exhausted discovery fails visibly rather than classifying an unchecked ancestor as absent. Main opens only that registered directory after revalidating the calling frame; Renderer copies validated text with the browser clipboard API. One Utility context read is active, same-Project requests share it, and other Projects receive a visible busy result; there is no queue, cache or polling. The read aborts after 2 s, shares Git's five-child/output/exit bounds, and uses the normal 5 s Main RPC. Context identifiers are bounded (path 32,768 units; folder/branch 4096); a complete receipt stays below 128 KiB. Shutdown aborts and drains the read before closing persistence. One native directory launch has no queue, a 5 s reporting deadline after resolution, and retains its slot until physical completion; disposal clears its timer. Renderer owns one context, one copy-feedback timer (1.6 s), and focus/visibility listeners only while visible. One active read retains at most one latest refresh intention; a generation fence rejects superseded, hidden and disposed results. Session switches dispose the view. The existing AppInfo platform selects Finder, Explorer or generic folder wording without another native query. Restart reads current facts afresh.

The Main window owner applies the Windows 8px corner region only to transparent-backed windows, on creation and native resize/maximize/full-screen changes. Each update uses at most 17 rectangles and no timer, IPC or cache; five window-state listeners are removed on close. Maximized/full-screen regions are rectangular. The native region clips content and pointer input, including when accessibility paints that window Solid. Opaque Solid Windows windows do not call `setShape` and leave corners/shadow to the system; macOS retains native rounding. Restart recreates the region from current native window configuration.

The same Main window owner selects the pointer display's work area in DIP, computes centered 80%
startup bounds with a 720 by 520 minimum capped to that work area, and owns workspace presentation.
Its typed show/hide interface is passed to NativePresence before loading; first readiness, tray,
Session navigation and close-to-tray use that one presentation owner. No Renderer IPC, persistence,
geometry cache or experimental window-state persistence is added. Reveal checks the existing title
bar's reachability and recovers inaccessible geometry without resetting ordinary warm reveals.

Per window, presentation retains one latest visibility target, one active transition record and at
most one 16 ms timer. Durations are 150 ms in and 100 ms out; reversal scales the remaining duration
from current opacity. Monotonic elapsed time skips stale frames after a delayed tick instead of
queuing frames. System animation preferences are read on each new transition, without polling;
disabled/reduced motion, native minimize/restore and fullscreen use immediate/native behavior.
Resize and window-state events cancel a fade, restore opacity 1, and complete an interrupted hide
when it remains the latest visibility intent. They never show a window over a native state change.
Destruction cancels the timer
and removes the seven presentation listeners; restart recreates transient state. Visibility changes
do not await Utility work or delay physical application shutdown, and Appearance retains sole
ownership of persistent material preferences.

Opaque Solid Windows presentation bypasses the custom fade branch entirely, including opacity resets;
show/hide and minimize/restore use native window operations. No opacity writes, shape mutations or
animation timer turn that window into a custom layered animation surface. Its native minimize,
maximize and restore effects remain subject to Windows settings and actual platform verification.

NativePresence owns one menu/snapshot of at most 15 Session rows and 32 KiB, one metadata read with
one coalesced dirty flag, one latest navigation and one quit confirmation. Native RPCs allow 5 s;
quit preparation has one 15 s logical seal timer and never changes the physical shutdown budget.
The client never sends quit preparation before runtime readiness and returns explicit not-sent
evidence without a deferred send. Only that evidence permits local cancellation; attempted delivery
requires Utility cancellation acknowledgement. Conversation installs its bounded quit owner before
querying metadata and caches the complete success or uncertain result. Failed queries remain
cancellable, duplicate preparations do not requery or extend the timer, and wrong operation IDs
remain rejected.
The current trusted primary Renderer becomes eligible for Pact quit confirmation after its existing
initial quit-state read, following listener installation. NativePresence owns nine window/content
listeners that invalidate readiness on main-document navigation, failed load or crash and track
responsiveness. It detaches them on replacement, destruction and disposal. One native fallback task
handles unavailable confirmation UI, rechecks availability before each presentation and reconciles
the current operation when its dialog settles. A recovered Pact UI retains cancellation errors;
stale dialog responses cannot decide a newer operation. No new readiness timer or shutdown owner
is introduced, and closing never recreates a destroyed workspace. Native confirmation waits for
application readiness. Presentation failure retains the quit owner without automatic retry; a
later explicit Show or Quit may retry it.
During accepted shutdown, Main retains the existing desktop IPC, Appearance and application-menu
owners until Electron's `will-quit` event, following document shutdown. Native window `closed`
alone is not an IPC-drain receipt. After confirmed physical Utility exit, Main closes diagnostics,
disposes NativePresence and requests ordinary Electron quit; one process-lifetime `will-quit`
listener then releases the remaining desktop owners. Cancellation retains the same live owners;
uncertain physical exit keeps the closing workspace available without starting another runtime.
Disposal removes subscriptions, IPC handlers, tray/menu references and its transient projections.
Restart rebuilds menus from current durable facts and existing live owners, with no navigation replay.

Native menu reads use partial MRU/attention indexes, at most 18 recent or 14 attention candidates,
at most eight live interactions and the existing five physical Adapters. Each candidate uses indexed
current metadata lookups, not history aggregation or JSON/body decoding. The App attention view
renders five rows per incarnation/revision-fenced keyset page with one active read and one latest
pending intent. Initialization and restart recovery yield after at most 25 Session IDs. Final quit
MRU merges at most ten indexed candidates and resolves five rows before the existing shutdown ACK.
Opening/suppression writes use primary keys; attention facts use current Agent/generation and
completed-visible-response indexes. Required measurements include these query plans, returned rows,
lookup counts, changed-scope write cost and zero native projection SQL during token progress while
unrelated retained history grows tenfold.

Renderer opening notifications have one in-flight request and at most 18 coalesced Session intents,
each with a 5 s pending TTL. Capacity, expiry and uncertain delivery report a visible error, preserving
the accepted selection without blindly repeating its mutation. Navigation, attention and quit
listeners are installed before their initial read; matching acknowledgment cannot clear a newer
intent. Renderer disposal drops transient intents and view state; durable receipts remain authoritative.
Windows removed-task inspection accepts at most 1024 OS entries; suppression mutations contain at
most 64 Session IDs per direction and never consume arbitrary executable arguments.

### Application, distribution, and database startup

| Owner                               | Bounds                                                                                                                                                                                                                       | Cleanup and restart                                                                                                                                                                                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PactDatabase.open`                 | 30 s opening deadline, checked during loading/backup/migration; at most 4096 migrations, 1 MiB per journal/SQL file and 16 MiB total SQL; at most 4096 statements per migration                                              | One directory reservation; read-only compatibility before writable/WAL operations; uniquely reserved backups and no-overwrite initialization; cancellation/failure closes real connections or retains an unresolved reservation until process exit               |
| Distribution builder                | Build 5 min, packaging 15 min; hash inspection 5 min with 64 KiB file chunks; at most 16,384 application entries/4 MiB manifest metadata, 64 KiB product metadata and 16 KiB builder record                                  | One build-workspace writer; empty explicit output; checked metadata restoration in `finally`; a conflicting source edit keeps the original recovery copy rather than being overwritten                                                                           |
| Packaged smoke                      | 30 s per smoke process phase; Main page loading 10 s; NSIS install/uninstall 120 s each; visible real-core inspection shares a 10 min deadline                                                                               | Own installation/profiles and seed/cold identity/content checks; one Windows EPERM/unlink temporary-file retry after 250 ms, with original root identity; require verified cleanup and final absence; failure retains recovery.                                  |
| Opt-in Utility/database measurement | One 10 ms event-loop histogram; at most 256 active-resource entries/64 characters per name; at most 64 SQL-hash/query-plan entries, 64 rows per plan, 512 B per detail and 16 KiB retained plans; observed SQL at most 8 KiB | Enabled only for the isolated nonce-bound fixture; health snapshots reset event-loop sampling; close disables sampling, restores wrapped database methods and releases retained plans; overflow/unsupported observation is disclosed rather than treated as zero |
| Codex child proxy exclusions        | Each output `NO_PROXY` spelling ≤8 KiB and ≤256 comma-separated entries                                                                                                                                                      | Fresh snapshots add only exact `127.0.0.1` and `localhost`; preserve Unix case variants independently and the effective Windows case-insensitive value; over-capacity values fail before native launch, without truncation or global proxy changes               |
| Repository source query templates   | At most 14 fixed prepared statements per connection; SQL text at most 8 KiB per template (112 KiB aggregate)                                                                                                                 | Prepare on first use; every page executes current parameters and rereads root, binding, authorization, document metadata and body parts; SQLite finalizes statements on connection close, and a new connection owns fresh templates                              |

Fixture-only logical IPC observation is owned by the existing transports for their process or
document lifetime. Nine fixed groups contain 25 direction/initialization slots with separate
business and control lanes, at most 1,000,000 messages per group, 19 sticky issues and 64 transport
epochs. Snapshot counters contain no DTO references, paths, bodies or credential values. Generic
plain DTO measurement retains its 262,144-node/64-depth/128 MiB observation ceilings; these limits
do not admit or truncate business traffic. The Monaco clone-data profile counts the native RegExp
leaf as canonical `{"$regexp":{"source":SOURCE_JSON_STRING,"flags":FLAGS_JSON_STRING}}` using
captured internal-slot getters; its unit is
`json-utf8-regexp-source-flags-null-binary-skeleton-plus-visible-binary-bytes-v1`. It does not
invoke payload accessors or `toJSON`, count discarded custom RegExp fields/`lastIndex`, or add
virtual nodes/depth to the input. Unknown prototypes remain incomplete. Older units cannot
satisfy the current gate. Native JSON and Fork Workers count large admitted replies
using their existing bounded encoder and send a scalar receipt in the same reply, including the
receipt's own bytes. Transfer senders measure before detachment and commit only after successful
delivery admission. Actual Node Worker exit settles the scalar active count; Browser `terminate()`
does not establish physical release. Monaco observation therefore retains a blocking cleanup issue
until independent physical Browser Worker evidence is available. A partial measurement cannot
establish complete IPC measurement.

### Catalog, Transcript, and streaming

| Resource / owner                                 | Numerical bound                                                                                     | Lifecycle and measurement                                                                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session Catalog / SessionRepository              | 5 Sessions per Project/page; page and mutation receipt ≤ 1 MiB                                      | Indexed keyset/revision reads; oversized entity fails visibly; no eager download of remaining history                                                        |
| Sidebar virtualizer                              | Session rows ≤ `ceil(scroll viewport height / 32px) + 12`                                           | Current Session row height is 34px; focus survives virtualization; count top/middle/end of 10,000-Session fixture                                            |
| Initial multi-Project publication / catalog hook | ≤ 20 pages or 100 ms per publish batch; 30 s initial read chain                                     | Check bytes once per batch; cancel on owner change; avoid whole-cache sort/publication per page/event                                                        |
| Project rename / ProjectCatalog                  | Name ≤ 120 UTF-16 units; one item/receipt<1 KiB; one mutation; 5 s RPC                              | Primary-key UPDATE; no Agent task/full Catalog read on success; uncertain write requires readback before next write                                          |
| ConversationRepository pages                     | 25 Messages/page; ≤ 1 MiB/page                                                                      | Revision/observation fences; visible normal/oversized descriptors; never silently shorten persisted body                                                     |
| Selected Conversation window                     | ≤ 100 resident Messages and ≤ 100 mounted Transcript rows including overscan/pins                   | One selected window; evict unrelated Run/Activity/source metadata; exact historical Comment navigation remains available                                     |
| Message presentation                             | Markdown ≤ 128 KiB; oversized preview ≤ 2048 code points                                            | Threshold selects rendering, not Send/storage admission. Normal oversized Message preview has no full inline Copy/new text Comment; original remains durable |
| Work Log / selected activity owner               | ≤ 50 projected steps; expanded detail ≤ 2 MiB                                                       | Show omitted older durable steps; one selected Run/one physical read/one latest pending intent; collapsed detail DOM unmounts                                |
| Comment source/body                              | Quote and Comment body ≤ 20,000 UTF-16 units                                                        | Exact hash/basis/quote checks; LF file quotes; capacity refusal preserves drafts                                                                             |
| Comment metadata pages                           | ≤ 24 per fast Patch; ordinary Conversation Comment read ≤ 25; ≤ 48 KiB per resident-page accounting | Total durable Batch size is not capped at ten or 24; oversized fast arrays omit the whole fast projection and resync                                         |
| Comment/Todo view policy                         | Todo metadata ≤ 3×24=72 rows/144 KiB; Comment view intended same 3-page bound                       | Current Comment reducers use25×3=75 rows/144 KiB; see documented discrepancy below. Eviction never removes durable members; remaining Comments stay pageable |
| Sent-Comment read chain                          | One sequential chain; 10 s                                                                          | Indexed sent-message/position lookup, one shared window reader, no per-row IPC/cache                                                                         |
| Repository observation LRU                       | ≤ 1024 Session entries                                                                              | Eviction creates new incarnation, never reuses ambiguous sequence                                                                                            |
| Stream Patch / Contracts                         | ≤ 64 KiB; ordinary append target ≤ 16 KiB; ≤ 16 Activity changes                                    | Validate every seam; oversized replacement uses bounded resync rather than full Session                                                                      |
| AgentStreamBuffer / Run                          | 75 ms visible cadence; 250 ms durable cadence; target ≤ 4 durable transactions/s/Run                | ≤ 64 distinct coalesced keys and ≤ 1 MiB per pending/committed batch; flush high-water/terminal/error/shutdown; reject duplicate keys atomically             |
| Main interest registry                           | ≤ 8 trusted documents; Utility interests ≤ 8 IDs/512 B                                              | One latest replacement, single-flight; 10 s monotonic chain, individual IPC ≤ 5 s; navigation/crash/close/dispose release listeners/interests                |
| Renderer initial/resume owner                    | ≤ 64 early Patches/1 MiB; 15 s ACK+read chain                                                       | Listener before fetch; await interest ACK; switch/error/overflow/installation releases buffer; no missed-Delta replay queue                                  |
| Around-source recovery                           | ≤ 3 attempts/30 s chain; one latest Comment target                                                  | Generation cancellation; retain old window/anchor/error Retry on failure; visibility restoration's ACK/around/latest fallback shares 15 s                    |
| Renderer failure boundary                        | ≤ 3 timestamps in 60 s; one recovery remount                                                        | No timer/IPC/persistent data; App-owned Composer/Sidebar survives; repeated failure disables remount rather than looping                                     |
| Historical Changes/Artifact projection           | 3 older cards/read; ≤ 1 MiB resident metadata                                                       | Indexed Agent/Session keyset; old cards remain durable and on-demand; no eager complete Changes history                                                      |

Required SQL: latest Run by Session/creation; latest completed Assistant/mark-read by Session/role/state/sequence; per-Run Message by `(run_id, role)`; sent Comments by sent-message/position; running Activities by `(run_id, status)`; Native cursor by `(session_id, agent_id, binding_generation)`; partial pending input-return/Fork/received-input indexes; adopted-title partial index; task/status/ordinal, Todo history, Batch/member/response/result/source indexes. Repeated mark-read with no newer complete answer performs zero Session UPDATEs. Grow unrelated/completed history tenfold and compare real lookup/returned rows and plans, not guessed rows-examined counts. Journal append uses one indexed in-INSERT sequence allocation and no separate sequence reservation SELECT.

### Admission, transport, and processes

Archive coordination permits at most five in-flight operations with no queue; each preview/receipt
contains at most five distinct task identities. Overflow refuses instead of hiding affected work.
One open preview per Utility expires after 120 s and stores at most 16 KiB; one receipt read is at most
32 KiB. Durable completed/unresolved receipts are not a resident cache or a total-history cap.
One stopping chain has a 15 s monotonic reporting deadline and one 100 ms wait timer; it checks the
bounded existing owners rather than repeatedly scanning a Project. Main archive RPC allows 20 s.
Timeout disables that operation's final commit, preserves unresolved native reservations and reports
unarchived outcomes. Disposal ends the reporting chain; restart reads durable facts without replay.
Scope queries use indexed metadata and primary-key receipt reads; representative SQL and physical
settlement checks remain required independently of build or visual evidence.

Rebuild candidate checks cannot enter a stopping or archived scope; unresolved scopes permit reading
native evidence but not activating a binding. Candidate activation revalidates archive availability
inside its binding transaction after any completed-nonce readback. WorkspaceChanges retains each
finishing Run's recording slot until its directory handle and disposable staging are physically
released; disposal joins the same complete finish promise. A rejected close or staging cleanup
retains the original failed owner and outcome until process exit. Recording preparations and Undo
retain their own existing slots, actual handles, and unreleased scratch credits on cleanup failure;
scope settlement reads all three owners without retrying close, Stop, finalization, or file writes.
An invalidated JavaScript descriptor alone is not evidence of physical release.

Main's normal Utility shutdown keeps its existing five-second deadline: up to four seconds for the
flush response and the remaining time for actual child exit. A kill request does not release the
child identity. Unconfirmed exit reports uncertainty and keeps Main and its profile alive; the
existing exit notification completes quitting when the old child actually exits. No replacement
Utility, polling, or additional shutdown deadline is introduced.

App owns the archive-result projection and the single prepare/confirm/check/restore action gate.
ArchiveNotice receives result rows and named callbacks; it owns only disclosure, details, page and
keyboard-focus state. The projection retains at most 50 entries, each bounded by the archive DTOs
and 2048-character local error text (at most 64 KiB serialized UTF-16 per entry, 3.2 MiB aggregate).
The view renders ten entries per page and at most five Stop outcomes per expanded entry. Admission
reserves an entry before prepare; a full projection refuses another archive instead of evicting Undo
or uncertainty. One scoped Escape listener exists only while expanded and is removed on collapse
or unmount. No timer, polling, automatic Retry or new persistence owner is added. Explicit
dismissal releases resolved entries; confirmed restore releases only its own entry. Unconfirmed
entries retain their original nonce until checked. One action uses the existing Main RPC deadlines;
the confirmation remains user-owned until Cancel, completion or Renderer disposal. Renderer restart
clears this projection; durable receipts and scope barriers retain their existing recovery semantics.

| Owner                                   | Numerical bound                                                                                                                                                                             | Settlement                                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Conversation Run admission              | 5 preparing/active operations App-wide; 0 queued Runs                                                                                                                                       | Reserve before awaits; sixth refuses before User/Run/Journal write and retains draft; duplicate receipt bypasses new admission                                           |
| Conversation Adapter lifetime           | 5 total slots including create/title/dispose; ≤ 8 native contexts per Adapter/40 observations App-wide                                                                                      | Evict only eligible idle owners; pending native work is not TTL-evicted; confirm actual release before reuse                                                             |
| Conversation native checks/interactions | ≤ 8 checks; ≤ 8 private requests App-wide                                                                                                                                                   | Operation/Run/generation fences; expiry/abort is application settlement, not a fabricated user/native decision                                                           |
| Native interaction                      | 10 min absolute response lifetime; ≤ 32 fields/32 KiB request or answer; 4 fields/page; ≤ 64 options                                                                                        | Question radio rows ≤ 6 choices, longer complete lists use native select; private templates/answers/URLs stay transient; cancel/Stop/dispose invalidates operation       |
| Main private native detail read         | One result/read owner; 30 s                                                                                                                                                                 | Session/request/generation fence; close/change cancels and clears; no durable private-data overlay                                                                       |
| Runtime Preparation                     | Fixed child command 4 s; capture ≤ 64 KiB; Main request12 s                                                                                                                                 | Both Agent probes independent; abort closes owned child; no Ready/auth cache or model call                                                                               |
| DefaultSessionSettings                  | ≤ 4 catalog operations/8 probes; 24 s whole operation; 4 s cleanup reserve; catalog command 15 s; Main25 s                                                                                  | Zero-input native catalog; awaits physical close before ACK/disposal; no early capacity release after SDK close                                                          |
| UtilityProcessClient                    | Startup ready10 s from fork; default RPC2 s; catalog/workspace5 s; saved workspace file15 s; Skill/image operation12 s; native reply 30 s; Fork prepare45 s/create15 s; normal shutdown 5 s | One startup waiter/timer per child; explicit startup Retry only; request ID/response-kind/one settlement; not-sent versus unknown-delivery; no automatic Utility restart |
| Codex connection                        | Init 10 s; Thread RPC 15 s; Turn acceptance 30 s; optional title 2 s                                                                                                                        | Absolute request deadlines and cancellation; uncertain acceptance persists evidence; title runs after terminal truth                                                     |
| Claude Adapter                          | Startup/native acceptance 30 s; permission-mode gate15 s; optional title 2 s; interrupt acknowledgement2 s                                                                                  | Native work/Hook receipt remains authoritative; gate failure ends empty input naturally without inventing termination                                                    |
| Codex cold feature probe                | 2 s plus1 s exit confirmation; ≤ 64 KiB/256 lines                                                                                                                                           | Bounded fixed args and owned child; no model input/cached Ready result                                                                                                   |
| Codex loaded Threads                    | ≤ 8 entries/64 KiB each; 5 min idle connection close                                                                                                                                        | Keyed connection/CWD/config; close/dispose clears; active/unresolved native work is not closed merely by idle age                                                        |
| Codex pending transport                 | ≤ 64 RPCs; outbound queue ≤ 4096 items                                                                                                                                                      | Each admitted request owns deadline/abort; final pending count0 after confirmed disposal                                                                                 |
| Codex inbound notifications             | hard 8 MiB/4096 items; high 4 MiB, low 2 MiB; count pause at 2048                                                                                                                           | Independent hysteresis latch; parsing pause cannot choose low-water incorrectly; RPC/control bypass, ACK/cancel/deadline re-evaluate pause                               |
| Codex framing/managed parse admission   | Compatibility single-frame bound16 MiB (`128 MiB/8`); 8× raw/decoded/Worker/clone estimate; 4×64 KiB framing workspace                                                                      | Reject while framing, not after unlimited newline accumulation; correct split UTF-8/FIFO; one physical parser per Connection                                             |
| NativeFrameWriter                       | One exclusive writer; ≤ 64 KiB chunk; 10 s whole-frame deadline                                                                                                                             | At most one chunk/drain pending; no control interleaving into partial JSONL; post-first-byte logical cancel lets frame finish; transport failure retains uncertainty     |
| Codex stderr                            | ≤ 16 KiB                                                                                                                                                                                    | Drain without unbounded retained output; discovery stderr can be discarded; close removes listeners                                                                      |
| Codex connection listeners              | ≤ 9 background /8 server-request listeners                                                                                                                                                  | Owner removes on settlement/disposal; late actor/generation facts cannot become current                                                                                  |
| Early native facts / Connection         | ≤ 128 items/8 MiB; 30 s attribution                                                                                                                                                         | Retain managed reservation across callbacks/requeue; empty replay clears timer; expiry/close/dispose releases same reservation                                           |
| Terminal evidence cache / Adapter       | ≤ 8 entries/16 MiB managed bytes; recent-access ordering                                                                                                                                    | Capacity eviction only of cached evidence, not unresolved physical work; dispose clears                                                                                  |
| Agent answer assembly                   | ≤ 128 body-bearing output identities; ID ≤ 512 B; Native managed allocation below                                                                                                           | Complete body size is no longer the old 1 MiB logical limit; preserve ordered items/durable seal and exact source                                                        |
| Native working memory                   | 128 MiB per named owner; 512 MiB shared App                                                                                                                                                 | Charge SDK/encoder copies, raw/decode/Worker/receiving clones, queues, answers, evidence and counting workspace before construction; not process RSS                     |
| Native JSON parser                      | ≤ 5 physical Workers/8 waiters; 10 s includes admission; heap old 128/young 8/stack 4 MiB                                                                                                   | Caller reserves work before Worker; abort/OOM/timeout await termination before returning capacity                                                                        |
| Native title synchronization            | ≤ 5 tasks; one in-flight/latest flag per Session; ≤ 3 revisions/4 s; RPC 2 s/8 KiB                                                                                                          | Existing initialized connection only; pump rechecks owner after backpressure; uncertain write blocks later executor writes; cancel/await on eviction/dispose             |
| Metadata Session title                  | ≤ 120 characters; one accepted root result                                                                                                                                                  | Existing native tool server below; actual adoption index is authority, never a provider-controlled flag                                                                  |
| OwnedProcessGroup                       | 256 identities/32 KiB; 4 s cleanup; 250 ms TERM grace                                                                                                                                       | POSIX identity query 1 s/256 KiB/4096 rows; one shared in-flight observation, no cache; startup ≤ 20 observations/2 s; prove child close/group absence before release    |
| Codex explicit Stop command ownership   | ≤ 64 commands; identity ≤ 64 KiB; discovery ≤ 256 KiB; 5 s stop                                                                                                                             | Verify original child ancestry; cleanup does not imply delivered task ended; no external writer kill                                                                     |

There is no native meaningful-progress inactivity classifier anymore: the old renewable five-minute timeout, stable-absence resend, polling reconciliation, latest40/50,000 B reconstruction, and read-only fresh-generation Retry policy are superseded by evidence-only recovery. Five minutes now denotes idle connection lifetime, not a Turn deadline. Unknown delivery and unresolved background work cannot be shortened away to release slots.

### Bodies, drafts, recovery, and native history

| Owner/resource                        | Bound                                                                                                                                                                                   | Lifecycle                                                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository body write                 | ≤ 8192 UTF-16 units/part; complete request ≤ 64 KiB                                                                                                                                     | Monotonic offset, trusted document identity, duplicate-segment/seal checks; seal does not create User/Run                                                                          |
| Temporary body storage                | 1 GiB/App; 256 MiB/document; 512 unreferenced identities/document                                                                                                                       | Input ≤ 8192 parts; document ≤ 32,768 unreferenced parts; App ≤ 131,072; inactive 10 min expiry at owner operation; cancel/document death/restart clears only unreferenced content |
| Referenced persistent bodies          | No temporary quota/TTL eviction or cumulative stored-part count gate                                                                                                                    | Message/Run/receipt/report/source references are durable; cleanup is reference-aware and not whole-history deletion                                                                |
| Repository complete body working read | 8 MiB                                                                                                                                                                                   | Indexed identity/revision, physical 8 KiB SQL byte segments with streaming UTF-8 decoder and control-plane yield; contextual whole-read deadline10 s                               |
| Handoff source read                   | 25 candidates/1 MiB/page; 8 MiB current complete-context work; 10 s; source-ID metadata ≤ 512 KiB                                                                                       | Entire required contiguous bundles; source revision/digest/cutoff frozen; no silently skipped older source or guessed provider-context ceiling                                     |
| Rebuild source preparation            | ≤ 4096 chunks/8 MiB; page 25; physical source chunk ≤ 65,536 UTF-16 units; 10 s                                                                                                         | Immutable manifest/nonce/original Run; candidate check is cold only; changed source/refusal retains old binding                                                                    |
| Claude false-only Rebuild             | Text source/envelope/text-only SDK frame each 8 MiB before creation; image seeds use separate managed admission; one deterministic seed UUID/hash manifest                              | One canonical envelope, no per-chunk ACK assumption; exact native readback/natural EOF/actual exit/work settlement; no model Turn added                                            |
| Native Rebuild receipts               | ≤ 8/64 KiB transient candidate controls; private witness ≤ 1 MiB                                                                                                                        | Persist creation before send; missing ACK never auto-creates again; exact actor/generation/source and CAS                                                                          |
| Input return                          | One active pending/installed receipt per Session; private JSON ≤ 64 KiB; restoration 10 s; parts ≤ 8192 units with byte checks                                                          | Body/Batch identities instead of full manifest per read; first page/claim validates complete facts; indexed all-draft eligibility; retries same identity, no automatic Send        |
| Composer edit work                    | 32 MiB managed estimate before construction                                                                                                                                             | Charge old/candidate/DOM/incoming/inverse work; rejected edit keeps prior text/Skill/route/receipt; no completed-history parsing                                                   |
| Draft/pending Hook residency          | 128 MiB/512 identities                                                                                                                                                                  | Share immutable identities where actual copies are absent; charge new copies separately; capacity refusal never silently evicts draft content                                      |
| Composer inverse history              | ≤ 100 edits/1 MiB                                                                                                                                                                       | Session/external document/receipt replacement clears; refuse an inverse over capacity rather than lose Undo for admitted edit                                                      |
| Composer rich projection              | ≤ 10,000 DOM nodes; list index ≤ 1024 items/2048 rows/128 KiB metadata                                                                                                                  | Two list levels, call-local bounded sets/prefix maps; explicit plain projection when structure exceeds budget, no text truncation; composition validates before history admission  |
| Composer clipboard                    | Legacy structured whole-fragment ceiling 512 KiB; current v2 metadata ≤ 64 KiB with text digest                                                                                         | Plain text is not limited to 512 KiB by metadata budget; opaque facts/checks stay exact; ignore imported HTML; refuse unsupported drag/drop                                        |
| NativeForkFiles                       | One Worker/one parent RPC at a time; 10 s; heap old 128/young 8/stack 4 MiB; 128 MiB reservation                                                                                        | Physical termination before release; no streaming-loop parsing or native file rewrite                                                                                              |
| Native history closure                | ≤ 32 physical parent files; 10,000 records; ordinary text/control 8 MiB; encoded aggregate and individual line 32 MiB; recognized collaboration carriers use their explicit format path | Stable inode/size/mtime/ctime/root/prefix recheck; all original opaque bytes retained through exact cutoff; text-only record paths retain their own tighter checks                 |
| Codex terminal/history check          | ≤ 1000 Turns; body recovery ≤ 128 items/8 MiB; single-item body pages                                                                                                                   | Metadata ending independent of body; short-lived read-only connection released success/error/abort/overflow; never closes execution connection for a body failure                  |
| Pact complete Fork copy               | 10,000 entities/8 MiB escaped serialized cold fact set                                                                                                                                  | SQL admission before hydration, then exact check; one atomic visible clone; full-history expansion remains separate scope                                                          |
| Fork witnesses/receipts               | Witness ≤ 1 MiB; ID map ≤ 10,000; ≤ 8 prior receipts/8 MiB per operation/Agent plus current                                                                                             | Archive/check capacity transactionally before new dispatch; unresolved receipts not TTL-deleted; no opaque witness in public IPC                                                   |
| Codex default model resolution        | ≤ 200 models/256 KiB; 25/page; 10 s                                                                                                                                                     | Zero-input inspection, no Ready/default cache; one ACK timer/listener disposed finally                                                                                             |

The removed Composer 100,000-unit gate and former Native 1 MiB physical-frame coupling are not restored. Current managed work can still refuse admission. Likewise, complete collaboration sources are not capped at 8 MiB merely because an internal complete-history operation has that budget. Read refusal preserves original source and accurately names the unsupported operation.

The broader large-history/editor proposal is not implemented. Future expansion must freeze paginated identities/manifests, atomically publish complete Forks, and preserve old hash/version semantics. A virtual editor is not proven bounded merely by current text length: piece-tree backing strings, pre-callback inverse allocation, internal Undo, and cumulative projection generations require preallocation admission and physical release evidence. A noncooperative source must retain real charged reservation after logical timeout, refuse replacement work while full, and release only on actual termination. Earlier prototype heap/latency observations do not establish those contracts; their proposed budgets are not current runtime policy.

### Skills, document compilation, and collaboration

| Owner/resource                   | Bound                                                                                                          | Lifecycle                                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation Skill discovery     | ≤ 2 tasks under existing5 operation/Adapter slots; 0 discovery queue; 10 s; one single-flight/ ≤ 4 waiters     | Cancel/dispose releases reader; refresh/send revalidates effective state rather than caching Ready                                                       |
| Skill catalogs                   | ≤ 4 snapshots; each 4096 entries/1 MiB; total4 MiB; entry ≤ 8 KiB                                              | Success TTL 30 s/failure 5 s; key includes executable/CWD/settings/binding/executor/manifest; explicit invalidation; overflow visible, no truncated list |
| Skill IPC/results                | 50 items/64 KiB page; Renderer ≤ 200 rows/256 KiB, ≤ 100/128 KiB per Agent; ≤ 40 option DOM                    | Independent ≤ 20 options per Agent (18 when Pact options present); forward/back paging preserves contiguous window; local More adds no IPC               |
| Skill invocation/decoration      | Metadata ≤ 64 KiB; opaque facts ≤ 4096; normal Message ≤ 40 badges                                             | Native paths/args not in progress Patches; frozen with User/Run/Batch; no probe/history reconciliation per character                                     |
| Skill autocomplete               | ≤ 2 replaceable debounce timers/80 ms each                                                                     | Generation fence; clear on replacement/unmount; CSS entrance160 ms/exit100 ms, reduced motion; no animation timer                                        |
| Skill document                   | One physical read, 0 queue; 10 s logical/12 s Main; JSON<1 MiB−2 KiB reserve                                   | Prechecks within discovery capacity; logical cancel suppresses publication but physical I/O remains reserved; App owns one Context document              |
| ApplicationMenu                  | 2 fixed trees/ ≤ 4 managed-window listener sets; one command/0 queue; 1 s receipt                              | Recheck focus/editor/composition/expiry; navigation/crash/destroy/dispose clears; restores prior menu                                                    |
| Collaboration indexed metadata   | ≤ 24 items/48 KiB per Todo/decision/identity/Batch/member/response/result page                                 | Indexed SQL, revision/manifest cursor; no full ledger hydration; large fields use body refs                                                              |
| Collaboration document transport | Stored part ≤ 8192 UTF-16 units; source-tool text ≤ 4096; each view/page ≤ 48 KiB                              | Complete text/opinion count not product capped; one UI source read+one latest intent; UI RPC 5 s/native source 10 s                                      |
| Native source/tool capability    | ≤ 4 concurrent requests/64 KiB/10 s                                                                            | One current exact Run/grant per Adapter; root retirement/abort/committed replacement releases; prior owner cannot revoke new grant                       |
| Clarification                    | ≤ 3 material new questions/Turn; decision options2 or 3                                                        | Semantic interaction bound, not total unresolved questions or Batch answers; preserve question revision/resolver                                         |
| Todo/Comment detail UI           | One expanded detail/one editor; ≤ 3 document pages; Todo ≤ 72 rows/144 KiB                                     | Collapsed rows issue no detail read; active anchors included; close/switch/unmount releases reads/focus/selection                                        |
| Markdown compiler / Conversation | One physical Worker; ≤ 32 pending identities; 30 s queue expiry; physical 10 s (also remaining queue lifetime) | Old96/young 16/stack 8 MiB heap; 128 MiB reservation until actual termination; durable page ACK before next credit; no retained Renderer AST             |
| Markdown projected page          | ≤ 512 nodes/depth64, ≤ 48 KiB; producer splits at 256 nodes/4096 projected text units                          | Renderer mounts ≤ 3 pages/global coordinates; one Text child/span; dense GFM resource failure yields explicit full plain-source fallback                 |
| Received input                   | One Session receipt/5 App-wide; one coalesced wake; existing RPC deadlines; return read10 s                    | No durable expiry; Stop/failure/restart pause; sources/operation receipts retained; unknown never replays                                                |
| Semantic reference display       | ≤ 4096 transforms over mounted ≤ 3 pages                                                                       | No rewriting original hash/source; transformed nonoriginal ranges cannot create fake Selection anchors; overflow visible                                 |
| Todo reason tooltip              | One scoped state; 5 listeners only while open                                                                  | Close on leave/blur/outside/Escape/scroll/window change; remove on close/unmount; no persistent listener set                                             |

The old 24 KiB report, 16,000-character plan, total24-opinion and per-field complete-text gates are removed. The old whole-workspace version reader (4096 files/8 MiB/10 s) is retired: collaboration does not capture/fingerprint new whole-workspace snapshots or automatically detect external drift. Existing Changes evidence/preview remains under its own budgets. Acceptance uses exact role/basis, whole persistent ledger, required-member anti-join, continuous input watermark, and native completion. A current page/empty delta cannot prove no pending work. Missing result indices/source/format preserve original evidence and an explicit report-only action, never an extra model summary.

### Images, file preview, and recorded changes

| Owner/resource                   | Bound                                                                                             | Lifecycle                                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ConversationImages               | ≤ 4 active I/O/2 physical codec Workers; 10 s/operation; 512 held/released owner IDs              | Worker heap old 64/young 16 MiB; cancel awaits physical termination; UUID file identity; no unrestricted paths via Renderer                                           |
| Image transport/work             | 32 KiB segments/64 KiB requests; original work64 MiB; decode ≤ 48Mi pixels/256 MiB                | Type/hash/stability checks; no Base64 in normal Patch/Journal/logs; one message control envelope ≤ 128 image refs, not a four-image business cap                      |
| Temporary images / Repository    | 1 GiB/App; 256 MiB/document; 512 uncommitted identities/App and owner                             | Active drafts do not age-expire; restart/window cleanup only unreferenced owned assets; Message/Fork/return refs durable                                              |
| Renderer thumbnails              | LRU128 items/32 MiB/5 min; 4 reads/64 waiters; 10 s                                               | Object URL exists only while reader mounted; zero-readers eviction/release; no whole history work on typing                                                           |
| Original preview                 | Managed estimate ≤ 256 MiB/image/768 MiB App; 10 s                                                | Charge assembly/Blob/decode; cancel dropped loads, release URLs; not renderer/process RSS bound                                                                       |
| Gallery/strips                   | ≤ 2 separately owned slides/180 ms transition; filmstrip 9/strip 16 nodes                         | Reverse navigation/reduced motion/focus trap; close/Session switch releases reads/URLs                                                                                |
| ProjectFileReader                | Descriptor buffer ≤ 1 MiB+1 overflow byte; whole serialized response ≤ 1 MiB; normal5 s Main RPC  | Reads exact stat/stability/UTF-8; growth/oversized error not truncation; external files never Comment/Undo sources                                                    |
| Native Plain Reader              | ≤ 100 logical lines/gutters and ≤ 350 UA-shadow nodes/page                                        | All supported pages reachable; wrap retains native Selection/Unicode; fallback crosses exact linked ranges                                                            |
| Monaco plain/unknown file        | Mounted lines ≤ `ceil(viewport height / 20px)+32`                                                 | Test100,000 short lines/extreme900,000-character line; lazy tokenizer; JSON only for JSON; all models/workers/listeners clean up                                      |
| Changes capture                  | ≤ 256 paths/round; ≤ 64 native patches/file; ≤ 64 MiB/version/evidence; 1 GiB/round; 10 GiB store | 4 pending callbacks/128 MiB per Run; 5 recording Runs; 30 s recording/Git; unreferenced-only reclamation; missing capture disables Undo, not native editing           |
| Changes metadata                 | ≤ 20 files/256 KiB page                                                                           | Indexed relative-path metadata, no bodies; workspace monotonic revision fences cache/late reads                                                                       |
| Saved version/patch panel        | One independently owned read/side; combined recorded patches ≤ 64/1 MiB; 30 s                     | Read patches sequentially; hash/Session/changeSet/path/index/count fences; one lazy read-only virtual viewer ≤ 100 mounted rows; failure never partial-prefix success |
| Undo / WorkspaceChanges          | ≤ 5 operations; all listed preflight; 30 s owner/Git deadline                                     | Stage outside Project; zero writes before all files pass and revalidate; post-start failures retain actual backups/incomplete intent; no forced restore               |
| Directory boundary               | Main ≤ 5 one-operation workers; Utility ≤ 20 pending/64 KiB request; copy buffer64 KiB            | TERM grace 2 s/force-exit confirmation 1 s; cancellation confirmation 4 s; unconfirmed worker quarantined; recovery page/path refs ≤ 1024                             |
| Git subprocess                   | ≤ 5 children; stdout 128 KiB/stderr 16 KiB; exit grace 1 s/confirmation 1 s                       | System Git supplies diff/apply/three-way; deadline/abort disposes only owned children; no whole-Project enumeration                                                   |
| External HTTP(S) launch / window | One physical launch/0 queue; 10 s reporting; raw+normalized URL ≤ 8192 chars macOS/2081 Windows   | Trusted live document/no credentials; timeout retains physical slot; close clears timer; no retry/URL cache/Session mutation                                          |

Undo benchmarks must distinguish zero-write last-file-conflict refusal from drift/failure after application begins. Compare unchanged preparation, changed-version capture, deduplicated blobs, single-file Diff, and all-listed-file Undo while independently scaling Project/source files, changed files, bytes, long lines, binaries, and unrelated history. Report read/written/staged bytes, hashes/deduplication, storage growth, IPC/DOM, event-loop lag, worker/child counts, and recovery without overwriting external edits.

### Diagnostic storage

Main owns one log Worker. Utility producer ≤ 64 records, Main ≤ 64, Worker ≤ 128; record ≤ 4 KiB, aggregate admission/copy residency ≤ 256 records/1 MiB including records awaiting ACK. Loss counters summarize saturation; streaming Deltas and complete Sessions generate no logging work.

Each development/production environment uses10 fixed JSONL slots, each below 5 MiB, within 50 MiB total with 16 KiB reserved metadata (within 20-file retention policy). Retain ≤ 7 days only when ownership safely permits reclamation; live/unknown ownership is never reclaimed by age. Worker I/O/progress/watchdog5 s; close2 s; failed retry30 s; maintenance 60 s. One Debug timer30 min expires at restart. Dispose clears timers/listeners/credits and confirms Worker close. Atomic private slot claims and symlink/hardlink checks cannot be bypassed for quota or convenience.

Measure same fixed stream logging off/on/burst, pressure/ACK loss, total transport/written bytes, concurrent/dead/unknown owners, disk-full/permissions/slow I/O, and 100 close/restart cycles. Encoder-only microbenchmarks are not disk/IPC/packaged latency evidence.

### Windows test infrastructure

These bounds belong to test owners and do not certify production CLI readiness, change security software/configuration, or enlarge product deadlines. See [Contributing](../CONTRIBUTING.md#testing) for isolation and commands.

| Owner                            | Bound                                                                                                                                                                                          | Cleanup/restart                                                                                                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixture registry                 | ≤ 8 fixtures; one live/preparing App; ≤ 2 concurrent native commands; ≤ 3 pending constructions                                                                                                | Reserve before awaits; drain pending construction on dispose; unconfirmed release retains capacity/evidence; no replacement generation until release                                     |
| Authenticated Job launcher       | ≤ 64 generations; one control socket/4096 B buffer; one start/release pair                                                                                                                     | Admission/connect5 s; release 5 s; App lifetime 15 min; exact Main PID/birth/generation and independent empty receipt                                                                    |
| Shared startup deadline          | Electron30 s/native command 15 s armed immediately before launch after compilation                                                                                                             | Authentication/start receipt/launch/PID confirmation consume one absolute monotonic budget; no extra10 s gate/fresh wait budget; UI readiness ≤ one Retry within 30 s                    |
| Transport facts                  | 64 invocations; record ≤ 512 entries/64 KiB; frames1 MiB; pending128; stream accounting16 MiB                                                                                                  | One writer/invocation; owner10 min; held reply 15 s; existing cleanup2 s/4 s/5 s; independent physical child release before success                                                      |
| Failure observations             | Published/unpublished files ≤ 64 invocations/64 KiB each/1 MiB aggregate; redacted final attachment ≤ 1 MiB                                                                                    | Keep initial incomplete facts unchanged; failed release preserves private directory, not fabricated closed=true                                                                          |
| Same-candidate publication       | One4 B wait cell; relay50 ms/32 attempts; synthetic state250 ms                                                                                                                                | Retry only unchanged candidate rename after bounded lock; never repeat serialization/unlink destination/replay native request; other errors fail immediately                             |
| Compiled test launcher cache     | One immutable seed ≤ 64 KiB; cold compiler setup30 s; unreferenced TTL 10 min; source/key ≤ 64 KiB; ≤ 256 private4096-char links (2 MiB UTF-16)                                                | Same-volume hardlinks; no ordinary-copy fallback; prune missing links; expire/dispose/exit/source/compiler/Node/CWD generation change retires; integrity/unconfirmed cleanup stops reuse |
| Owned-process observer           | 32 nodes/depth3; query 2 s; exit wait1 s; returned ≤ 3 ancestry identities/64 KiB                                                                                                              | Complete discovery/revalidation in two OS invocations; birth/path/ancestry guards; no process cache or broad unbounded scan                                                              |
| Claude Windows accounting suffix | Existing10 s Fork owner/10,000 records/8 MiB text/32 MiB aggregate; ≤ 10,000 model entries/4096-char labels/nonnegative numeric fields and four token totals each ≤ 10^15; totalCostUSD ≤ 10^9 | Strict candidate identity/schema/empty-input counter checks; unchanged prefix/raw SHA; no extra I/O/model/native rewrite                                                                 |

The cache key includes actual source/effective compiler and Node file generation, architecture, canonical compilation CWD. It caches no Ready/auth state, warms no process, and starts no model. Cold startup still must fit the caller budget; reduced repeat compilation/FileId cost does not establish cold p95 or an OS/Defender cause. Permission tests admit only the exact bounded next native command when necessary, not retained rules or broad Session grants.

Observed cancel preserves reads; ≤2 cancel/ACK lines, ACK ≤1 s within cleanup; EOF/ACK is no Job proof.

Native protocol setup uses one 60-second deadline for CLI discovery, cold launcher preparation,
two version probes and the Adapter bundle. Each actual version probe remains bounded to five
seconds and the remaining setup time. Compilation is preparation work; the admitted RPC owner
still has its original 50-second lifetime and ten-second request budget. Async fixture factories
reserve one caller-owned preparation ticket before awaiting work, with four live factory slots,
eight total live owners and 64 generations. Closing drains preparation and cannot start a late child.

### Deterministic and packaged benchmark matrix

| Fixture              | Required shape and checks                                                                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transcript           | 100/1000/10,000 Messages; prose/GFM/code/tables/Comments/Work Logs; typing gives0 completed-history reparses; ≤ 100 rows; historical Comment/page/gap/reorder/anchor/focus                                                              |
| Catalog              | 100/1000 Sessions, 90% archived, 10 versus100 Run/completed-reply pairs/Session; 10× unrelated growth; 10,000-Session/1000-Project paging/focus; indexed first-five; 0 no-op updates                                                    |
| Streaming            | 1/5/6 requested Runs; normal/burst rates; five preparing/active plus visible refused sixth; 0 complete reads; Patch bytes/SQL rows/writes; terminal/error/shutdown durable tail                                                         |
| Visibility           | Foreground versus other Session/Settings/minimized/hidden; 0 inactive body Patches, necessary facts<8 KiB in fixed60-part fixture; A→B→A/fresh ACK/gap/Selection/work-log continuity                                                    |
| Files                | 100 KiB/1 MiB; 100,000 short lines; 900,000-character extreme line; TS/JSON/unknown; full Selection/wrap/resize/linked page boundary/Comment/old anchors; 100 cycles                                                                    |
| Providers            | Init/stream/title silence, lost ACK, connection close after acceptance, split UTF-8, no-newline overflow, stdin backpressure, late duplicate/terminal/background facts; no model replay                                                 |
| Large input          | 128,001 UTF-16 units; 4 MiB original/answer; Emoji+Skill clipboard>512 KiB; source digest/revision, upload/seal/return/Undo/Redo/cold restart; every owner releases actual capacity                                                     |
| Complete content     | 9 MiB plan, 80 opinions, 48,000-character opinion, 9MB answer, 12 MiB carrier; complete immutable hashes/source reads, plain fallback for dense GFM; three-page DOM/selection/repeated Comment return                                   |
| Collaboration        | Both roles/all duties; >20 Comment/answer members in one Turn; required-member missing/duplicate/foreign; pending member on another page; A-fails/B-succeeds watermark; unchanged plan/revisions/counters/rejected report-only recovery |
| Native recovery/Fork | Exact terminal/candidate/readback, legacy refusal, abandon/generation/nonce, restart-before/after dispatch, no replay; 1000/4096/9000-message clones; paginated parents/opaque/tool/compaction/image cuts/append races                  |
| Images               | Ten-image18-key reversal, two-slide bound, 35-URL release fixture, late ACK/cancel/Session switch, actual native pixel input/history/Fork/cold resume, codec package/restart; 100 Worker success/cancel cycles                          |
| Changes/Undo         | Complete/incomplete native evidence, last-file conflict, missing/corrupt snapshot, dirty/untracked/later nonconflicting edits, writer contention, post-start crash/drift; no external edit overwritten                                  |
| Lifecycle            | 100 success/open/close/abort/error/timeout/restart cycles; processes/Workers/models/timers/listeners/requests/reservations return to baseline, or retained unresolved owner visibly blocks reuse                                        |

`pnpm bench:catalog` explicitly enables the four100/1000×10/100 fixtures. Warmed in-memory indexed first-five reads and historical partial-aggregation comparison differ in output scope; report each correctly, never claim a like-for-like full Catalog speedup. Ordinary skipped benchmark tests are not measured results.

Packaged gates (record OS/hardware/power/Electron/build SHA/fixture/raw samples):

- Composer input-to-paint with 1000 retained Messages:p95 ≤ 50 ms, p99 ≤ 100 ms.
- Steady Renderer and Utility event-loop lag:p95 ≤ 50 ms.
- No sustained repeated Long Tasks>50 ms; every one-time task>200 ms is bounded/explained.
- Native terminal to enabled Composer:p95 ≤ 100 ms; title is not on critical path.
  -10× inactive history must not linearly multiply active CPU, hot-query lookup/result rows, or IPC bytes.

Record input latency, React commits/frame rate/Long Tasks, per-process RSS/CPU, Utility event-loop lag, IPC bytes/s, SQLite transactions/s/query plans/timing, database/WAL growth, owned resource high-water/final counts, and recovery outcomes. Deterministic fixtures use isolated temporary data/protocol stubs and never user conversations or paid models. Real provider evidence is separate and explicitly authorized/configured.

### Evidence, known gaps, and future scope

For each change retain a same-fixture before/after report with responsibilities/interfaces, complexity/payload/query/write frequency, resource counts, normal/failure/restart traces, correctness regression, platform/package scope, and unsatisfied budgets. Newly added/enlarged dependency reports initial/lazy/process/package cost; moving code to Utility/lazy load is not eliminating total cost. Compare frozen lockfiles/same build mode/gzip and genuinely isolated dependency installs, not a baseline that accidentally already contains the new package.

Sharp 0.35.5 is a Utility-only native dependency. Its documented isolated macOS arm64 package comparison increased App Resources 408,268,354→427,985,768 B (+19,717,414), ASAR 153,563,022→154,657,345 B, and unpacked 252,462,894→270,993,595 B; installed Sharp/core 19,500,012 B accounts for most growth. That codec restart smoke does not prove Windows/signing/p95. Keep this dependency-cost evidence; routine chronological bundle deltas and local report paths are not current budgets.

Current unresolved boundaries:

- Windows x64/arm64 native installer/launch validation and full Windows/macOS production Dev/Stable coexistence, upgrade and uninstall validation remain TODO. Basic manifest-bound extraction/restart evidence does not establish those lifecycle or release-performance obligations.
- Comment view intended 72-row policy versus actual 75-row implementation (both 144 KiB); Todo window remains 72. Source migration does not silently increase the intended policy or claim correction.
- Packaged maximum-input p95, full cross-item IME/VoiceOver, forced native compaction/remote encrypted history/all provider-version compatibility, and personal Hooks/MCP behavior lack complete acceptance evidence. Single protocol observations/fake provider acceptance/zero-model injection are not paid-model generation or maximum context proof.
- Windows recorded packaged seed/restart smoke and scoped real/lifecycle successes, but the last broad verification retained five transport/process failures; follow-up nine scoped cases passed without a final clean whole check/E2E. Original command output absence and cold pre-managed-entry delay remain unproven causes. No budget/security/configuration was relaxed.
- Later Project rename/navigation visual acceptance explicitly waived new tests; macOS/package/uncertain-write/large-Catalog regression for that increment was not established by Windows visual inspection.
- Complete stored collaboration text has no old total gate, but arbitrarily dense formatted Markdown can exhaust its physical compiler; complete plain text remains available. Current normal Transcript oversized-message interaction limits and current cold complete-history admission remain disclosed.
- Full recurring database backup/restore, Journal replay, reference-aware retention/archived compaction, complete Checkpoints, and arbitrary large-history Handoff/Rebuild/Fork expansion are future work. Migration backup alone is not disaster recovery; maintenance must be incremental/cancellable/restartable without blocking active conversations or deleting facts.

Optional future policies are not implemented: readiness cache successful TTL 30 s/failure 5 s with capacity/bytes/generation/single-flight/Retry bypass; warm Send readiness p95 ≤ 100 ms with no probe child; one Utility child with ≤ 3 restarts/60 s and 250 ms/1 s/4 s backoff, zero timers after dispose. Current sends still probe fresh; no fair Run queue or automatic Utility restart exists. The superseded 2-active/32-queued proposal is not current policy. These options need explicit approved scope/measured need and must preserve unknown-delivery evidence.
