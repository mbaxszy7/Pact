# Product specification

Pact is a local desktop workspace for a user, Claude Code and Codex to work in one shared conversation. Users bring their own installed and authenticated CLIs. Pact routes requests, retains visible conversation and collaboration facts, presents native interactions and recorded file changes, and provides explicit recovery actions.

This document separates current behavior from **Planned scope**. A future requirement is neither an implemented capability nor authorization to build it. Process boundaries, persistence, resource limits and measurement belong to [Architecture](../technical-foundation.md), verification to [Contributing](../../CONTRIBUTING.md#testing), appearance to [Design](../../apps/desktop/DESIGN.md), and terminology to the [glossary below](#terminology).

## Terminology

Use these terms consistently in code, UI and documentation.

| Term                       | Meaning                                                                                                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project                    | A canonical user-added local directory reference, classified as Git or directory. Rename/archive changes Pact metadata, not files.                                                                    |
| Session                    | One shared visible conversation belonging to a Project, with its own settings, native bindings, history, Comments and collaboration tasks.                                                            |
| Primary / Secondary        | Default Session responsibilities. Explicit message/task routing can choose either Agent without permanently changing these defaults.                                                                  |
| CLI Ready                  | The selected native CLI is discoverable, accepts its own effective authentication and can start its control/probe operation. This does not guarantee model quota or future task success.              |
| Runtime Preparation        | First-use setup before defaults are saved. Both CLIs must be Ready; no model task is used to prove readiness.                                                                                         |
| Runtime Degraded           | A returning user's readable workspace with Agent-start actions disabled while a required CLI is unavailable. It is not a return to onboarding or an offline mode.                                     |
| Default Session Settings   | The singleton App template copied when a Session is created. Global edits affect future Sessions only.                                                                                                |
| Session Settings Revision  | An immutable whole Session configuration. A Run keeps the revision frozen at admission; later tasks use later saved revisions.                                                                        |
| Agent Run / root Turn      | One explicitly authorized execution owned by a concrete Agent, with native identity, completion and delivery evidence. Root Turn does not mean exactly one provider API request.                      |
| Native Agent Context       | One provider's own conversation identity/private history. Claude and Codex maintain separate native contexts for the same Pact Session.                                                               |
| Binding generation         | The identity epoch tying one Agent's native context and executor to the Pact Session. Retired callbacks cannot mutate the current binding.                                                            |
| Durable Session Context    | Pact-owned original messages, sent Comments, images and collaboration facts preserved independently of native private context.                                                                        |
| Event Journal              | Ordered durable facts about execution, messages, decisions and recovery. It is not a raw token stream, diagnostic log or complete provider transcript.                                                |
| Message Projection         | A bounded/readable representation of an immutable or streaming message source. Preview/cache eviction never changes the original source.                                                              |
| Work Log / Agent Activity  | Sanitized provider-visible progress and Tool lifecycle for a Run, excluding hidden chain-of-thought, unrestricted arguments and raw output.                                                           |
| Session Activity           | Current Run/interaction/recovery needs, independent of a collaboration task's workflow phase or review verdict. Idle means no active work or required user response.                                  |
| Session Title              | Pact's display name, with placeholder/local/Agent sources and user rename priority. Derived native `[Pact]` naming is separate.                                                                       |
| Cross-Agent Handoff        | Ordered, source-attributed user questions and completed answers not yet received by the target Agent, with Comments/images and frozen coverage. It does not merge native contexts.                    |
| Ordered independent `@all` | Primary then Secondary on one User Message. Secondary excludes this round's Primary answer; later ordinary Handoff can deliver it. It is not shared-file isolation.                                   |
| Peer Proposal              | A validated lazy suggestion to ask the other Agent. It starts no work until the user clicks and cannot consume current drafts.                                                                        |
| Collaboration Task         | One `/plan`, `/build` or `/review` objective with frozen roles, version/source basis, Todo ledger, input progress and counted actions.                                                                |
| Duty                       | The frozen authority of a collaboration Turn: plan submission/adoption/review, code review or stage result. A role label alone does not authorize edits or acceptance.                                |
| Current Plan               | The task's one authoritative complete plan/reference. Primary maintains later versions; peer review does not publish a competing plan.                                                                |
| Review basis / fact        | Exact frozen plan or code scope/source plus the responsible Actor's actual completed verdict. It is not an entire workspace snapshot or an inferred agreement.                                        |
| Todo                       | A versioned opinion, decision or information item with stable identity. Open needs handling; Awaiting review needs confirmation; Done records a reasoned final disposition.                           |
| Question revision          | The exact version of a Todo's user-input requirement. An answer to an older revision cannot answer a new question.                                                                                    |
| Answer resolver            | The frozen Actor responsible for processing a question's actual sent answer. Closing that question does not grant peer review acceptance.                                                             |
| Input Batch                | All accepted body/attachment/Comment/answer sources from one atomic Send, including members outside the resident UI page.                                                                             |
| Processed-input watermark  | The contiguous settled Batch sequence. A later success cannot skip an earlier unresolved Batch.                                                                                                       |
| Plan ready                 | A durable exact-plan review acceptance with the complete ledger and required inputs settled. Temporary runtime admission can disable dispatch without deleting this fact.                             |
| Anchored Comment           | A persistent user draft or sent observation tied to an immutable message/plan/report/Todo revision or versioned Project-file selection, with a quote snapshot. It is not a user-editable Todo status. |
| Project File Reference     | Click-triggered local text preview metadata. Relative paths stay in the Project; explicit outside absolute paths are preview-only and grant no Comment/Undo authority.                                |
| Changes Card               | Actual native-recorded file modifications for one settled Run. Missing/mixed evidence limits Undo; it does not block native forward tools or claim full Project coverage.                             |
| Undo                       | Whole-card guarded inverse file application after all-file conflict-free preflight. It has no Redo and does not restore transcript, native context, Git state or external effects.                    |
| Native permission mode     | Session/Agent choice of Native, Ask, Auto or confirmed Full access. Tool approvals are separate transient native requests; modes do not save global permission rules.                                 |
| Unknown delivery           | The request may have reached native execution but its outcome is not established. Do not blindly resend or infer termination from timeout/silence.                                                    |
| Retry / check              | Inspection or saved-result/candidate readback, without a new model task, old-request replay or new native candidate.                                                                                  |
| Rebuild                    | User-confirmed verified initialization from durable visible history into a new native binding. It is not native resume, Fork or replay of the prior task.                                             |
| Returned input             | A durable receipt for a provably unsent/refused latest input excluded from a successful Rebuild seed, offered back for explicit user Send without overwriting newer drafts.                           |
| Fork                       | A new Pact Session and genuine native branch for both Agents at one completed-answer boundary, sharing current Project files. It is not historical code restoration.                                  |
| Managed image              | Immutable locally saved PNG/JPEG/WebP content referenced by messages/receipts/branches; a thumbnail is a disposable view.                                                                             |
| Native compaction          | Provider-managed private-context reduction while retaining the same native identity. Pact does not treat it as missing history or auto-Rebuild.                                                       |
| Checkpoint                 | Planned automatic Session/workspace restore point. Separate from current Fork and Changes/Undo; no complete Checkpoint feature is shipped.                                                            |
| Writer Lease               | A former hard forward-write proposal, withdrawn from current execution. Pact only coordinates its own Undo and known native Runs, not external editors/tools.                                         |
| Diagnostics                | Bounded sanitized local operation logs. They do not replace the SQLite Journal or the planned full audit export.                                                                                      |

Avoid using `completed`, `accepted`, `ready`, `responded` and `resolved` interchangeably: they describe different native, workflow, admission and input facts.

## Scope and boundaries

- Serve independent developers and small teams using Claude Code and Codex to discuss, implement, review and safely continue work.
- Keep Projects, Session records, managed images, diagnostics and recovery evidence local. Agent requests and native tools may communicate with user-configured services; local-first does not mean offline.
- Integrate exactly two built-in Agents. Primary/Secondary are default responsibilities, not permanent capability restrictions. Explicit task routing can choose either Agent without changing Session defaults.
- Preserve each CLI's native configuration, authentication, project instructions, Skills, MCP, Plugins, Hooks and tools. Share results and quoted sources, never authentication, tokens, tool instances or configuration between Agents.
- Do not manage Provider endpoints/API keys, compatible backends, CLI installation, third-party plugin installation or native global settings. A backend configured outside Pact remains the user's runtime configuration.
- The deterministic orchestrator does not act as a third model or substitute inferred agreement for recorded results and user authorization.
- Treat project text, generated output, links and extension/native results as untrusted. File-write intent does not implicitly authorize destructive commands, publishing, deployment, database mutation or external messages.
- macOS and Windows share functional requirements, with platform-specific path, control, shortcut, material and process verification. Publishing source does not establish a simultaneous signed-installation release.

## Current capability boundary

The code includes runtime preparation, first-use defaults, Project/Session management, streaming conversations, explicit routing and ordered `@all`, native Skills, static images, anchored Comments, native permission/input interactions, explicit Native Session recovery/Rebuild, recorded Changes and guarded Undo, genuine two-Agent Native Fork, `/plan`/`/build`/`/review` collaboration, and bounded local diagnostics.

It does not implement a global hard Project Writer Lease, arbitrary full-workspace snapshots, Session Checkpoints, automatic model-driven discussion, full audit export, complete capability/plugin management, native steering or unlimited-history Handoff/Rebuild/Fork. Current authorization and native permissions govern forward editing; incomplete recording limits Pact review/Undo, not native execution.

## Runtime preparation and first use

### Readiness

Assess Claude Code and Codex independently through executable discovery or a saved manual path, version, the CLI's own authentication status and bounded startup/probe operations. Never read, retain or display credential values. Missing, unauthenticated, unavailable, timed out and unconfirmed are distinct outcomes with installation/login guidance, manual location and retry.

**CLI Ready** means the selected CLI is discoverable, accepts an effective authentication method and can start its control/probe operation. It guarantees neither network, quota, model availability nor future Run success. Claude's accepted local API authentication is valid without a subscription login. GUI processes inherit only the environment available at launch; a later terminal export does not change an already running Pact.

First-time users remain on Runtime Preparation until both CLIs are Ready, then must complete Default Session Settings. There is no hidden skip or fake-model validation. Saving defaults and completing setup is atomic.

Returning users enter their existing workspace and refresh readiness there. If either CLI is not Ready, **Runtime Degraded** keeps local Projects/history readable and settings available while disabling Agent-start/continue actions with the reason. Recovery restores those actions; each actual execution still checks the runtime, rather than trusting stale Ready state.

### Defaults, Model and Effort

One App Default Session Settings template contains Primary/Secondary, independent Model/Effort for each Agent, discussion rounds (default 6, range 1–20), review cycles (default 3, range 1–10), repair attempts (default 3, range 1–10), and the stored running-message policy. Its two legacy choices do not currently represent distinct implemented native-steering timings.

A new Session copies the current template into its first immutable settings revision; creation-time customization affects only that Session. Later global edits replace the singleton and affect future Sessions only. There is no implicit Project template or hidden save-as-global action.

Discover models and supported Effort from the selected installed runtimes, rechecking Project configuration where relevant. Codex uses App Server model metadata; Claude uses the SDK with the selected local executable. Use native identifiers and explicit CLI/model-default choices, not invented shared lists. If reliable Effort metadata is absent, offer native default and explain it.

Loading, empty catalogs, discovery errors, stale saved choices and incompatibility are visible in the settings row. Preserve recognizable choices and offer refresh/reselection. Reject unsupported explicit combinations; never silently switch models/Effort. Distinguish requested from observed effective configuration and retain Usage only when reliably supplied. Native default must not be replaced accidentally by an SDK default. Explicit Claude Effort must apply to the actual Query, including initialization, without modifying global native configuration; Native Effort leaves the default intact.

### Settings and active work

Saving atomically creates a complete new Session revision. An admitted Run keeps its frozen settings, route, Agent and permission choice; later tasks use newer saves. Both existing `@all` stages keep their original revision after restart. Permission menus show a next-task pending indication during active work.

Collaboration task roles stay frozen even if Primary changes. Limits are checked before later dispatch; settings changes cannot erase consumed counts. A cancelable persisted Pending Revision editor and automatic settings-change Checkpoints remain planned, rather than current behavior.

## Projects, Sessions and navigation

### Project identity

A Project is an explicitly added canonical local-directory reference, not a copy or automatic scan. Resolve symlinks/canonical identity, reject filesystem roots and deduplicate. Classify Git from a `.git` file/directory at the selected root; do not silently promote a nested directory or bare repository. Non-Git is valid, and current native edits use the same authorization rules without initialize-Git/snapshot unlocking.

Rename changes only the saved display name: trimmed, nonempty, single-line and at most 120 UTF-16 units. Re-add preserves identity/name/Sessions. Name/Pencil opens the inline editor and selects the current name; Enter saves, Escape cancels, blur preserves the draft. Failures keep the draft with local error. Read back uncertain writes before another mutation. Folder disclosure remains separate.

Project/Session Archive hides App entries without deleting files, settings, messages or Native histories. Immediate Undo restores the archived item; re-adding an archived canonical Project restores its identity and Sessions. Project archive does not cascade Session archive state. Permanent delete and a persistent Archive browser are not exposed.

### Session ownership, title and activity

One Project may have multiple Sessions. Each owns transcript, settings, separate native bindings/cursors, Runs, Comments, images and collaboration tasks. No other Session's work may overwrite those facts. Only one admitted Agent Run executes per Session, with App/resource admission in Performance; this is not a filesystem lock against external editors/native background tools.

`New session` is immediate; a local first-message title is fallback. An Agent/native title can arrive within the existing authorized root Turn, without a hidden title-model Turn. User rename always wins. Only successful, current, correctly attributed root/generation evidence can be adopted; foreign/child/failed/expired/duplicate results cannot rename. A Fork preserves its inherited title semantics.

After adopting a native title into Pact, Codex's display name may become `[Pact] Project name · Session title`. Save user renames locally before one-way native synchronization. Failure does not block chat/rename; the next normal connection can reconcile. Never change an old generation, unconfirmed candidate or unrelated client's thread. The prefix is not part of Pact's own title. Users may intentionally open the native thread in another client; Pact does not hide it or migrate authentication to prevent this.

Activity projects actual Run/interaction/recovery facts, independent of collaboration phase/verdict. Normal completion returns Idle; Waiting means an actual required question/approval. Completed, failed, interrupted, unknown-delivery and abandoned remain distinct. Unread follows durable completed-message sequence and recorded reading position, not transient deltas/title changes.

Navigation is Project → Session, with neutral Project rows, folder disclosure, hover/keyboard-focus actions, 6 px before indented child Sessions and no persistent connectors/`Sessions`/branch/path/count/Changes metadata. There is no dedicated application fullscreen feature. The center header retains title. Settings temporarily replace navigation content and hide Context; Back restores workspace topology.

## Messages, routing and execution

### Explicit routing and atomic Send

| Input/action                   | Recipient and authority                                 |
| ------------------------------ | ------------------------------------------------------- |
| Ordinary message without route | Primary frozen at Send                                  |
| `@claude` / `@codex`           | That Agent for this message only                        |
| `@all`                         | Primary then Secondary, two sequential authorized Turns |
| Accepted peer Proposal         | One target Turn and visible source-linked User Message  |
| Collaboration command/feedback | Frozen task/stage responsibility below                  |

`@` autocomplete contains Claude Code, Codex and All, with filter, arrows, Enter/Tab, Escape, pointer and screen-reader support. Selection inserts an atomic token/space, never sends. One message has one route; replacement/removal changes only its pending route. Manual leading mention ignores initial whitespace and requires whitespace/end after the name; ordinary mid-sentence text is not routing. A selected structured mid-sentence mention retains identity. Freeze/persist the route; later Primary changes cannot reinterpret it.

One Send atomically associates complete body or sealed reference, route, Skill intent, ready images, all frozen Comment members and Run facts. Duplicate client identity returns its original receipt without dispatch; changed input under it conflicts. A late ACK clears only the submitted draft revision and preserves new input. Definitively unsent, natively accepted and possibly delivered are separate facts.

### Ordered independent `@all`

One User Message authorizes Primary then Secondary and at most one visible answer per `(User Message, Agent)`. Secondary receives the original task/Comments/Skills/images and necessary history strictly before that User Message, excluding Primary's current-round answer. Prior history is retained; a later ordinary Handoff can deliver the withheld answer. This boundary does not isolate shared files.

Never execute concurrently, alter Session roles/permissions or append a third summary Turn. Primary failure/cancel/unknown delivery prevents Secondary; Stop cancels its undispatched stage. Dispatched/uncertain stages preserve frozen sources/identity and cannot be replayed by inspection.

Check both required bindings before creating the User Message. Missing context preserves input and applies the Session recovery gate. Later failure keeps Primary's answer and Secondary stage facts. Startup can schedule only a durable pending Secondary whose Primary completed and whose Secondary Run never existed, using original settings. Stopped/failed routes, existing Runs and recovery-retired continuations are not silently resumed or resurrected.

### History and peer assistance

Each Agent retains independent native context and confirmed transcript cursor. The next target receives its consecutive unseen questions/completed answers with speakers, order, sent Comments and managed image/source references; do not duplicate the current request. Advance only on native acceptance. Retry/reconciliation uses its frozen history, not a newer source.

Native compaction keeps that context identity. Pact retains originals/images/Comments, does not synchronize native summaries or automatically Rebuild/replay old images; the user may provide an old image again. Budget failure keeps source/cursor and reports rejection, never truncates, summarizes, switches models or adds an unapproved compaction Turn.

Agents cannot invoke each other directly or trigger routing with prose. Validated `request_peer_assistance` yields a lazy supplement/fact-check/challenge/review Proposal only to the other Agent; it starts no model, changes no Primary and edits no files. One completed substantive answer may activate one Proposal; failed/stopped/empty/incomplete/foreign answers cannot.

Prompt policy proposes meaningful second-agent assistance for substantial review, design uncertainty, decisive facts, missing perspective or competing explanations, but not simple tasks or already dual-routed `@all`. Both `@all` stages enforce exclusion. The current answer remains independently useful; it must not replace substantive content with descriptions of tools/routing/confirmation or an imagined future review.

Show a compact initiator/target/action row with `Ask <Agent>`/`Not now`; bounded reason is source evidence, not an arbitrary hidden prompt or repetitive UI. Ask authorizes one Turn and creates its visible User Message directly, preserving current body/Comment/image drafts. Not now starts nothing. New User input or accepted Proposal transactionally supersedes pending Proposals; stale clicks fail. Missing native context keeps Proposal pending without message/Run; uncertain delivery never reactivates it.

### Streaming, Stop and drafts

Normalize native events; coalesce deltas into recoverable projections. Final text is authoritative. Multiple assistant items around a tool call form one ordered Pact answer rather than overwriting pre-tool text or repeating completed fragments. Native ending, complete-body storage and display publication are distinct; dependent actions cannot consume an unsealed source. Projection/storage failure preserves known ending and source without re-execution.

Work Log retains provider-supplied readable reasoning/progress and sanitized Tool lifecycle, not hidden chain-of-thought, unrestricted arguments/raw output. Absent reasoning is never invented. Present at most the latest 50 steps of the selected Run with an older-steps notice. User-opened older work stays selected during new progress; Collapse returns to latest. Eviction never deletes durable steps.

Normal response keeps Composer editable and replaces Send in place with Stop. While responding, ordinary Enter only inserts a newline (or selects autocomplete), never queues/autosends a new draft. Stop requests native interruption, retires cancellable pending work and retains completed changes/input; show waiting until real settlement. Lost observation is not a successful Stop. Recovery/read-only gates remain stronger than normal editing.

Native steering is deferred. Collaboration supplements received during live work wait for its already authorized work/side effects to settle, then follow their recorded delivery. A queue notice requires actual live work at durable acceptance; a receive ACK alone is not queued and completed-stage feedback stays silent. Distinct Safe Point/Next Round behavior needs a later scope with precise delivery/cancellation; model/Effort never change mid-Run.

## Composer and native Skills

The canonical document preserves text, route, opaque Skill selections, UTF-16 selection, IME, paste/cut and undo/redo. It starts at least two lines high and grows/scrolls. Textless decorations add no quote offsets; same-text formatting cannot discard route. Rejected edits keep the full draft without repeated identical notices.

Idle Enter/Cmd/Ctrl+Enter sends if admitted. Shift+Enter creates a paragraph or next ordered item. A positive integer plus dot/space, or pasted list, can establish a start-number-preserving two-level list: numbers then lower-case letters. Tab indents only with a preceding parent; Shift+Tab outdents. Structural edits renumber; an empty child exits to top level, an empty top item exits the list. Backspace at body start removes/raises structure while preserving text. Wrapping aligns with item body; no separate same-item soft-break shortcut is supplied.

`/` autocomplete groups Pact actions separately from native Codex/Claude Skills. Show enabled user-invocable system/personal/project/plugin entries. Within an Agent order User/Project, System, Plugin, then unspecified Native origin, with names sorted. Use visible bounded pages, More/Previous and range; unchanged catalog refresh cannot reset pagination or flicker per keystroke.

Multiple Skills share task text/arguments. Parse the command area and its one mention before final target validation, allowing mentions/slash selections in either order. Retain source identity without selecting a target automatically. Mismatch blocks Send with a compact actual-recipient error. `@all` requires each requested Skill to match separately on both Agents; definitions/permissions never merge. Validate every selection including repeated names against the current binding.

Inline book-icon/name chips are atomic for editing/cut/replacement/undo and copy as command text. They record request intent, not native success. Click reads native-exposed `SKILL.md` in Context; missing path is unavailable, not guessed/recreated by a model. Codex uses native structured input; Claude requests every selected Skill in the same task and reports actual invocation. Refusal/unconfirmed invocation is not success; loaded is not completed.

Code/ordinary historical prose without invocation facts is unchanged. Handoff/Fork/Rebuild/input return preserve intent without replay. A definitively returned editable draft can use current command grammar on its new Send; the original message/route/invocation remains history. A pending/unknown original request retains frozen target/parameters/identity and is never automatically reinterpreted.

## Images and lifetime

Support actual-byte-validated static PNG/JPEG/WebP via picker, clipboard and local drop. Remote-URL-only drops do not download. Clipboard bitmap may be saved as PNG; unavailable original file metadata/format is not promised. Allow image-only Send. Show thumbnail/name/preparing/error/Remove; add-image stays below full-width text. Do not silently send only a prepared subset.

Save managed immutable original bytes and ordered references with identity/name/type/bytes/dimensions/hash. Thumbnails are disposable. Source-file deletion/movement cannot break committed images. Protect message/Run/input-return/Fork references, with bounded interruption cleanup between import and SQL commit. Draft removal cancels import and fences late results; a late receipt clears only submitted images/body.

Session switching retains current ordinary drafts; App close/restart clears unsent ordinary body/images. Persistent Comment drafts, sent images and returned-input receipts survive. The current input metadata allows 128 image references, with real I/O/decode/memory/disk budgets in Performance; this is neither a four-image business limit nor proof a model understands 128 images. No model-name guessing, hidden capability Turn or automatic image-to-text fallback.

Native Send/Handoff/Rebuild receives real images, not path descriptions/OCR/another Agent's explanation. `@all` respects this-round answer isolation. Normal native resize/compression/conversion is not a Pact hash/recovery failure. Compaction does not cause automatic Rebuild/replay.

Group preview supports previous/next, arrows, bounded filmstrip, close/Escape and trigger focus restoration, without zoom/Fit/100% controls. A 180 ms slide/fade can retain outgoing/incoming views with reduced-motion support and bounded decoded residency. Fork includes boundary images only. Failed-input return restores images/body/route/Skills/Comments without overwriting newer drafts.

No generation, OCR, region Comments, arbitrary file attachments, background quality scoring, native conversion controls or full storage/backup manager is included.

## Anchored Comments and Input Batches

### Sources and persistent drafts

Anchor a Comment to immutable message/plan/report text, a versioned Project-file range or an exact Todo/question revision, retaining identity/hash/projection basis/range/quote. Message ranges use visible projected text; plain fallback has its own explicit basis. File anchors use Project-relative forward-slash paths and content hash/line/column. A whole-Todo Comment is not a forged message text selection.

Add to comment saves without dispatch, Todo mutation or implementation authority. Composer collects chips with body/images for one Send. Independent Comments remain separate; one answer draft is unique to its question revision. Edit answer restores selections/supplement and updates its original identity. Options deselect on another click; recommendation is a label, never automatic submission. Remove restores the answer entry.

Stable request identity and expected revision govern saves. ACK closes only the matching editor/revision; later edits stay open. Frozen/sent members are immutable, so subsequent edits become new drafts. Add/cancel a dirty source editor before changing its source/group/page. Recovery freezes mutations and retains drafts.

### Atomic completeness

The accepted Comments revision freezes every valid draft, including unloaded pages, body/images/route/nonce/task source into one durable **Input Batch**. Conflicts reject the whole receipt and preserve inputs. Never split authorization into multiple root Turns or omit later pages. The former ten-Comment Send cap is removed: 24 is a metadata-page bound, not a durable-member bound. Per-comment body/quote and physical page budgets remain.

Ordinary/collaboration Runs use the same bounded frozen-source reader for complete Batch members. Handoff/Rebuild retain references; Rebuild launches no model to read/summarize them. Input return clones identities from original sources; Fork maps them consistently. View-cache eviction never deletes durable members/drafts/sent Comments.

Member states are pending response, responded, awaiting confirmation, resolved or legitimately sourced withdrawal. Responded is not resolved; another required Actor's confirmation remains visible. Failed/invalid/unknown outputs do not close members. Close only when the body and every member are handled; advance the processed-input watermark contiguously, never past an earlier failed Batch. Mixed resolvers still use one target Turn, not automatic fan-out/impersonation.

### Return to source

Return to the exact original source/range. Current plan is read in Context Plan, never expanded fully again in Chat. Todo navigation locates its correct current Pending/Done page; old revisions appear separately as Historical/Referenced version with then-state and known current-state comparison. They do not alter counts or offer a new answer to an old question; Comment remains historical.

Failure retains the quote with a warning; read/transport failures show errors. Never silently retarget to similar text, open empty Context, rewrite anchors or guess current status. Repeated return gets a new navigation identity and waits for asynchronously loaded body DOM before positioning; preserve keyboard focus, selection and deliberate scroll on refresh.

Current durable Comments distinguish Draft/Sent. Todo closure is separate. Automatic Comment resolve/wont-fix and line-remapping to changed files remain planned rather than existing durable states.

## Explicit collaboration

### Entries, authority and one workflow

Pact commands have structured App-action identity; they are not installed native Skills, shell strings or native slash controls. Same-name native Skills remain selectable explicitly by source. Commands in quotes/prose/code/history do not start workflows. One Send/action authorizes one root Turn, not necessarily exactly one provider API request during native schema validation.

| Entry              | Initial work                                         | Frozen roles/next action                                                                                                                                               |
| ------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/plan [task]`     | Complete provisional plan and material clarification | Primary drafts unless mentioned Secondary; Primary maintains later versions, the other responsible Agent reviews. Secondary normally implements, Primary reviews code. |
| `/build [task]`    | Explicit implementation without forced planning      | Mentioned Agent, otherwise Primary, implements; the other reviews after user clicks Review changes.                                                                    |
| `/review [target]` | Read-only scope review                               | Mentioned Agent, otherwise Primary, reviews; the other responds/repairs only through explicit action.                                                                  |

Missing target/task prompts only necessary clarification. Investigate discoverable facts before asking. `/plan` actively clarifies goal/scope/acceptance/material design with few dependency-aware questions, not repeated decisions or code-fact questionnaires. Keep a provisional full plan while decisions remain; do not continue dependent work without answers/explicit tradeoff.

Freeze task identity, entry/objective/user decisions, roles, stage, allowed scope and exact plan/review basis. New entry creates a new task; prior Done/acceptance cannot become new authorization. Primary changes do not reassign active task roles. Three commands share ledger, scheduler and acceptance ownership.

Plan submission publishes complete current text or exact unchanged reference. Primary alone maintains later versions. Peer review submits exact basis/verdict/findings, not another plan. Secondary initial draft can be actually reviewed/adopted by Primary under frozen `plan_adoption`: exact unchanged plus formal verdict may accept; rewritten text requires independent review. Author identity alone proves no review; no hidden author self-acceptance Turn is required.

Planning/review/response is distinct from implement/repair permission. Codex uses native read-only sandbox for those duties, while native extension mechanisms remain; do not claim this isolates all third-party effects. Claude uses current stage-specific tool policy/prompts, not a universal filesystem sandbox. Native permissions and user limits remain authoritative; Pact cannot control arbitrary native Hooks/MCP by merely calling a phase read-only.

### Todo ledger and user questions

One ledger stores stable-ID opinions/decisions/information with immutable revisions. Pending includes Open/Awaiting review; Done records final disposition. Users cannot check/uncheck/delete state. Expanded detail shows issue/impact/recommendation/evidence/handling. Accessible Done info records resolved/merged/not adopted/withdrawn reason; Done means neither all suggestions implemented nor tests passed.

Primary plan maintenance or implement/response/repair proposes reasoned resolution; the responsible independent reviewer confirms that revision. Merge uses a same-task target with no cycles. Reopen requires new relevant evidence/reason; changing title/ID cannot bypass user decisions. Read effective-decision/identity indexes including off-page Done. Static IDs cannot perfectly detect semantic duplicates, so responsible review and prompts must check too.

Questions have exact versioned definitions and frozen `answerResolver`. Choices need real options/recommendation; information accepts free text without invented options. At most three new material questions per Turn, without limiting existing questions/Batch answers. Changed question increments version, returns Open and clears old resolution; old answers do not satisfy it. Explanatory-only updates retain Awaiting review. Confirm/propose-resolution cannot also edit question; Done requires evidenced reopen.

`needsUserAnswer` applies only to Open/current/unanswered. Historical question on Awaiting review/Done is not a repeat request. Its resolver may close a question using a real sent exact task/Todo/question/version answer in authorized scope and citing its source; this exception cannot self-confirm opinions or supply independent review acceptance.

Questions and Todo/Plan Comments use Add to comment/Cancel, with Send only in Composer. Default recipient is Primary for plan decisions, implementer for implementation clarification, actual reviewer for review evidence and responsible responder for response clarification. Mention can choose a permitted alternative Actor; no extra To selector, separate answer dispatcher or automatic Primary relay. Mixed Batch remains one recipient, with genuine other-resolver obligations retained.

### Readiness, implementation and review

Plan ready requires the complete current plan, actual responsible exact-reference acceptance, no Open/Awaiting/unanswered required items anywhere, and every required input handled. Empty delta, clear visible page, native TodoWrite/termination or omitted updates is not acceptance. Done history does not block readiness. Durable ready is separate from transient dispatch admission; unavailable runtime disables without deleting valid review.

Context Plan/Todos is the sole full-plan/shared-ledger reading area. Do not open an empty Plan. Transcript has compact opaque version/review cards, one title/count/disclosure and historical default collapse, keeping required action/error/Resume visible. Show every opinion/suggestion/user tradeoff before its Proposal, not only blocking defects; real evidence links only.

Implement plan binds the approved visible version/frozen implementer; no early-implementation bypass. Changed scope/version requires renewed review/approval. `/build` itself authorizes its explicit task; `/review` grants no edit permission.

Implementation/response/repair completion offers explicit Review changes. Review opinions offer Respond read-only or Repair (edits code) to the original implementer/responder. Response does not self-accept; repair needs explicit writing action. Next responsible review examines its current scope and exact Todo resolutions. Skipped suggestions preserve their disposition, not fabricated no-opinion acceptance. Completed current review with no unresolved work ends without another Proposal or extra Primary summary.

Review basis freezes target and available implementation/repair Run/ChangeSet/native evidence plus what was checked, not a whole-workspace snapshot/HEAD fingerprint. Direct `/review` cannot invent snapshots or widen preview; uncaptured/out-of-scope files are unverified. New implement/repair or changed target retires old current acceptance. External edits are not automatically fingerprinted; discovered changes can be normally reported/reviewed. No persistent Code version changed/automatic rework branch.

An implement/repair paused for required input keeps its unfinished duty. Answer work stays read-only. After true question settlement, explicit Continue implementation/repair resumes original Actor/scope/counts. Do not require all opinions Done before resuming the work that addresses them, or allow partial read-only review to finish an incomplete implementation.

### Limits and interruption

Separate discussion, review-cycle and repair counts. Initial draft is free of discussion count; later peer review plus author response/confirmation is a round for either initial drafter. New-version review starts another. Review cycles include review, response/repair and rereview; unresolved rereview can seed the next response without a redundant identical review. Explicit repair consumes once whether successful or failed; initial build, pure response and report correction do not, while failed reimplementation consumes its repair allowance.

Reserve/persist before dispatch; release only proven-unsent, reconcile possible delivery. Current round can finish but next cannot exceed limit. Proposal/new feedback/restart cannot reset history. At limit preserve work, exact plan/code, findings/validation and require explicit user decision to continue/increase budget. No unlimited automatic fix loop.

Accepted feedback retires old action nonce; ordinary task feedback is read-only under its duty, never implicit repair/implementation. Added/editing feedback prevents stale action clicks without rewriting acceptance. Explicit interruption retires future actions/cancels undispatched work; dispatched work uses native cancellation/reconciliation. Preserve changes/opinions and follow next user direction.

### Native result and transactional settlement

Use only the current v5 native structured envelope with frozen duty schema, never chat JSON, legacy publisher or TodoWrite. Original carrier is immutable and separate from natural answer/plan/report. Visible prose/Copy/quotes exclude submit instructions, UUID/hash/manifest/protocol JSON, while actual technical names remain appropriate. Never rewrite historical original bytes just to repair display/acceptance.

Compile long results into bounded indexed parts. Before one transaction, validate Actor/root/native ending/task/duty/exact basis/expected Todo revisions and all required members. Missing/foreign/duplicate member rejects the entire application. Unique result identity makes repeated terminal/result/restart idempotent. Legal old output can remain history without processing newer feedback or overriding newer Todo revisions.

Missing/invalid report offers explicit same-Agent read-only Submit plan/review/report, preserving original completed source/duty/rejection reason. It corrects formatting, not new investigation/code/automatic acceptance. Successful reads cannot clear action failure. Result/terminal may arrive in either order; timeout cannot manufacture ending. Resource failure preserves originals and honest incomplete status; cold settlement cannot repeatedly parse the whole stored report/ledger.

Plan/report text and opinion count have no cumulative product gate. Physical pages/parser/tools/source reads remain bounded. Dense Markdown can use explicit complete plain-source fallback with correct anchors, not silent truncation or unlimited formatted-rendering promise. Ordinary long-message preview remains separate.

## Native permissions and questions/forms

Each Session/Agent offers Native settings, Ask for approval, Auto and Full access. Native omits overrides instead of guessing rules. Auto uses the installed native mechanism, not Pact approval algorithm/model-name list. Claude's actual Query initializes/ACKs Auto before input; explicit mode rejection may prove unsent without a fabricated Turn or discarded healthy binding. Transport failure is not unsupported-model proof.

Full access explicitly confirms broad file/network scope in the selected Agent's menu, replacing rather than stacking the mode list. It affects that Pact Session/Agent and never edits project/global native rules. Restart/Rebuild does not repeat confirmation; leave/re-enter does. Ordinary new Sessions do not silently inherit consent; confirmed Fork is an exception. Changes affect next tasks, never answer active cards/replay tools. Recovery uses current choice, not revoked Full access.

Show approvals only when requested natively, with exact supported once/session-scope/refuse/cancel actions. No persistent command/network amendment or across-session saved rules. Claude session-allow exists only if all suggestions target the current native Session; do not split/widen mixed suggestions. Preserve native user rules. Record sanitized evidence before returning decision; expired/stopped/restarted/generation-mismatched requests never replay.

Questions/MCP forms require actual user answers/submission; Allow cannot answer them. OAuth/URL opens only on user click, proving opening intent rather than authentication success. Native connection establishes completion. URLs/fields/answers remain transient; passwords/tokens/credentials are excluded from durable logs/snapshots. Timeout/transport withdrawal is not user denial. Initialization interactions work even before a model Turn.

## Native recovery, Rebuild and input return

### Evidence and input gates

Bind evidence to Session/Agent/request/Run/native ID/generation/actual executor. Silence, timeout, observer release, another executor's notLoaded/history existence/old Completed label do not prove termination. Preserve original complete/partial body and distinguish auth/quota/protocol/permission/context/resource/unknown delivery. No fake empty answer bubble.

One recovery card lists affected Agents, concise title/reason and one valid Retry/Rebuild action, without repeated delivery/Comment explanations. Known ending with incomplete body is result-reading, not rebuild of a healthy binding. Unknown errors retain sanitized concrete reason instead of inferred missing/stopped.

| Gate           | Behavior                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `read_only`    | Read history/preserve drafts; disable input/Send/Add Comment/draft mutation/Agent starts while any required binding needs recovery. |
| `send_blocked` | Known ending and valid binding during result read; allow editing, temporarily block Send.                                           |
| `open`         | Recovery adds no restriction; normal runtime/work/sending gates remain.                                                             |

Retry inspects native status, saved results or existing candidate without Query/resume/start, old-message/Comment replay, retired `@all` or new candidate. Prefer valid pure inspection; offer Rebuild only when replacement or inspection-capability evidence requires it. Codex may use exact reliable native terminal metadata; Claude history may lack whole-turn termination evidence, which is a visible limitation, not permission for a Query probe.

### Explicit replacement

Each replacement needs Rebuild and same-card confirmation with Cancel/Confirm rebuild, keeping history/drafts and not repeating prior task. Only relevant old-running-work/prior-candidate impact appears. Rebuild neither stops/deletes old Native Session nor prevents its physical side effects.

Persist nonce, old identity/generation, frozen complete seed/coverage/hash and candidate. Same confirmation creates at most once; identity changes invalidate authority. Verify real initialization/matching candidate/complete receipt/readback before atomic swap and transcript divider. Failure keeps old/candidate evidence. Existing candidate is checked before another explicit create; history/creation ACK alone is not ready. Unknown old work becomes abandoned with real facts, never false stopped/success. Old callbacks archive only to old Run, without changing current answer/title/unread/activity/permission/Proposal/Handoff.

Seed includes ordered visible User/Agent messages, marked partials, images, sent Comments and full collaboration/Batch source references. Exclude hidden retries/system prompts/reasoning/tool logs/unsent drafts. It restores saved public conversation, not identical private provider state. Never substitute a Summary, trim history or raise a budget to claim recovery. Oversized history stays readable but restoration fails under current limits; no automatic archive.

Codex initializes without model work. Claude injects a complete versioned envelope through `shouldQuery:false`; native continuous inputs may merge, so verify envelope/hash and real initialization/interaction settlement/natural EOF/exit rather than one UUID per chunk. No extra model question/automatic second attempt. Native Hooks/MCP/Skills/tools remain; user hooks may still have effects. Apply actual selected permission/Auto ACK before releasing history.

Another client holding a native thread is permitted user activity. Reject before model input, retain request and use check/Rebuild. Never steal lock, kill external client, migrate authentication, isolate native home or change global configuration.

### Return provably unsent input

Only latest input with all Runs failed/proven unsent/native-refused, no native Turn/result/unknown dispatch or later User/Agent message, may be excluded from Rebuild seed. Verified zero-history initialization is required if nothing was accepted. After successful replacement offer exact body/route/images/Skills and cloned Comment drafts through a durable return receipt; user chooses Send.

Preserve original Message/Run/Comment/anchor. Do not cover new body/target/image/Comment drafts; retain explicit restore entry. Receipt survives restart/repeated restore without duplicate drafts. Accepted/unknown original input or an already-initialized old history cannot be returned retrospectively from failure labels. Only definitively returned editable input can be interpreted by current grammar on a new explicit Send.

## Recorded Changes and Undo

Forward native tools follow real user tasks/permissions without an edit switch, formal-plan prerequisite, Pact snapshot tool or hard Writer Lease. Pact cannot lock VS Code/Hooks/MCP/background tools. Dirty/non-Git follows same policy. HEAD, proposed tool input or later reads cannot substitute for actual endpoints.

After Run/known file-work settlement, attach durable Changes to that Agent answer for real edits, including failed/stopped work. No streaming changing-statistics card. Retain actual ownership and exclude existing dirty/external/other-Session changes. Mixed/unknown attribution, broken chain/missing endpoints disables reliable Undo with reason, not native capabilities or fabricated complete coverage.

Card has reliable file/line totals, bounded rows, View changes and Undo. Review historical Diff/complete After when saved, not current files. Patch-only evidence is Recorded patch in native operation order, not fake whole file; disable unavailable After/Undo. Unsupported/binary/oversized shows explicit unavailability, never invented lines/truncation. Retry only transient errors. History stays readable after Undo; no Redo.

Any settled complete round may be undone, not just latest, using before/after/current and mature Git inverse three-way merge to retain later nonconflicting edits. Patch without reliable full endpoints is reviewable, not proof of safe reverse matching. No full-Project scanning/snapshot or initialize-Git requirement.

1. Preflight every listed path/content/existence/metadata and calculate all candidates/conflicts before any Project write; private merge output never changes HEAD/index/branch/staging.
2. One conflict/read failure/missing source/incomplete check/timeout/cancel/unsafe path/link/object/attribution rejects whole round with zero writes and bounded warning. No force-side, relaxed match, conflict markers or partial visible-subset Undo.
3. Recheck endpoints immediately before applying; concurrent change invalidates preflight. Own Undo is exclusive and disabled during known Project native Runs, not a global external-writer lock.
4. Persist backups/candidates/recovery intent first. Multi-file disk writes are not atomic: I/O/crash/concurrent change can leave incomplete application. Stop, retain evidence and warn; never force rollback over new external edits or declare success.
5. Success marks undone/disables repeat. Only files change, not transcript/Comments/settings/native history/Git commits/branch/index or deployment/database/external effects. Textual merge is not semantic/test proof.

Never delete unique Changes endpoints/unfinished-Undo evidence through cache or future Checkpoint FIFO. Storage failure limits recorded Undo rather than manufacturing native write admission; future protection needs its own design.

## Genuine conversation Fork

Fork branches through one completed Agent Message and earlier visible conversation/sent Comments/images, shares current Project files and preserves original Session/drafts. It is not historical code restore/Checkpoint; User/draft/streaming messages are not targets.

Require both Agents' usable native history at that exact boundary before commit/dispatch. Never-used/later-first-used Agent cannot be replaced by an empty context. Genuine provider fork uses corresponding native message/Turn/tree cutoff, new identity, verified lineage/prefix/initialization. Never use Rebuild or copy all current history as fallback.

Confirmation describes boundary/shared files/current source Model/Effort/roles and inherited permission modes. Visible Full access summary/create action explicitly covers the new Session/Agent, unlike ordinary creation. No native tool-approval cache copying or global/project rule change.

Commit Pact Session/frozen history/settings/confirmation/per-Agent fork intents atomically before any native dispatch. Committed incomplete Fork remains in catalog with error, never hidden/rolled back. Creating dialog is busy/non-dismissible; after initial work settles normal catalog/Session recovery takes over. Navigate only under current intent/readiness; late receipts cannot steal navigation. Lost ACK of known commit reads same-nonce receipt, never forks again.

Both native sides must be ready for Send/Comment mutation/Agent actions. Copy boundary task/Todo/question/Batch/Comment/plan/review-source references using one ID map; beyond-boundary dependencies remain unavailable, never later answers/closures. Inherited reviews are historical, not new dispatch/edit authority. Work Log/Changes/Diff remain read-only; old Undo/Ask/approval/form/pending input is inert. Branch content/images survive source archive/removal.

For committed incomplete Fork, Retry checks source/cut/candidate/lineage/settings/readiness without mutation, reuses healthy side, and never substitutes query/resume/fork for inspection. A verified candidate needing initialization/permission ACK gets explicit continue-initialization only. Proven undispatched or candidate-absent with valid source permits explicit continuation of the same operation/Session. Timeout/auth/paging gap/unknown identity is not absence. No blind recreation/auto-cleanup/Rebuild fallback. Real initialization questions/OAuth/approval remain user-owned.

Startup starts no new model/duplicate fork. Uncommitted means invisible and no native dispatch; committed means readable/gated until verified. Operation/Agent/source/target/settings/generation fencing and nonce idempotence prevent duplicate publication/stale unlock/clearing the other side. Catalog error uses current readiness, not inherited failures. Current Fork count/byte/witness budgets remain in Performance; unlimited branching is deferred.

## Content and file navigation

Ordinary messages use safe GFM headings/lists/quotes/tables/links/code without raw HTML; streaming may be incomplete, final is stable. Above 128 KiB use bounded plain preview with preserved breaks and concise performance reason. Original remains complete but this Transcript view has no full Copy/expansion/new text Comment. Existing Comment quotes remain readable; preview does not mean changed source. Complete paged collaboration documents have separate rendering/anchors.

Local links read only on click. Relative path stays inside real Project root with symlink checks; explicit local absolute path may preview an outside file/Skill. Outside preview grants no file Comment/Changes/Undo authority. Renderer has no `file://`, generic filesystem or arbitrary system-open API. Reject missing/nonregular/binary/undecodable/oversized targets visibly. File/serialized preview is bounded to 1 MiB, not an arbitrary large-file reader.

`#L42`/`#L42-L58` locate/highlight; absent anchor opens top. Context shows resolved path/lines/text. Lazy readonly Monaco handles recognized code/structured language with theme; unknown/load failure falls back to readable wrapping plain text with same anchor semantics. Heavy editor stays out of initial bundle.

HTTP(S) labels remain blue/underlined/keyboard-active with destination tooltip/textless ExternalLink icon. Trusted Main opens credential-free validated destination in system browser, denying Electron popup/navigation; decoration adds no quote offsets. Reject other schemes/credential-bearing links. Bounded failure reports destination-free error without replay; OAuth retains separate interaction lifecycle.

Bound DOM/caches while preserving selection, keyboard/screen-reader access, Comments and reverse navigation. Keystrokes cannot reparse completed history. Delayed above-viewport height changes preserve reading anchor; manual detail pauses tail-following; Home explicitly returns beginning. Late read/error cannot change another source or reacquire retired ownership.

## Appearance, accessibility and diagnostics

App-global persisted appearance includes independent System/Light/Dark theme, System/Solid/Translucent material and stored `materialOpacity` 70–100/default 85. Visible Transparency strength 0/50/100 maps to 100/85/70, not whole-window opacity. Semantic surfaces have distinct alpha; text/icons/code/focus remain opaque.

Live preview/reset respects revisions. Save failure restores durable value; uncertain delivery blocks writes until readback. System events cannot reconcile unknown write or overwrite newer revision. macOS uses transparent backing without Vibrancy. Supported Windows uses frameless transparent backing/native overlay, system backdrop disabled rather than Mica. Unsupported build/system, reduced transparency, high contrast/forced colors or observable init error falls back to complete Solid, retaining request/reason. API success/CSS alpha is not compositor evidence.

Use calm dense controls, progressive disclosure and non-color identity/state cues. Target WCAG 2.2 AA, keyboard/focus/scalable text/screen-reader/reduced-motion/light-dark semantics. Code/Diff/permissions stay nearly opaque. Titlebar interaction is no-drag with native safe areas and dragging/resizing elsewhere. Exact visual rules live in Design.

Diagnostics is bounded local metadata JSONL separate for development/production, not Journal/full audit. Default/temporary Debug excludes body/image/source/Diff/command args/raw streams/URLs/credentials/full environment. Explicit Debug ends in 30 minutes or restart. One failure notice cannot block business/streaming; Performance owns quotas/retention/exit. Native rejection is not labeled process crash without exit evidence.

## Planned scope and open decisions

These retained requirements do not imply current implementation or approval.

### Capacity and delivery

Daily large text can be edited/sealed/sent/saved/explicitly returned beyond old 100,000-character and shared 1 MiB logical-frame limits. Native/provider/resource limits still apply; no arbitrary-size promise. Complete internal reads differ from Transcript preview. Aggregate Handoff/Rebuild and full Pact/native Fork still have safety/count/manifest gates. Expansion requires paged immutable manifests, complete mapping, atomic publication, proof compatibility, all-process memory and true initialization/readback evidence; a larger constant alone is insufficient.

Native steering, distinct Safe Point/Next Round, model-generated Summary or automatic extra Turn needs explicit trigger/target/cost/cancel/unknown-delivery/approval scope. Interrupt-plus-new-Turn fallback changes behavior/cost and needs user authorization. Do not change Model/Effort mid-Run.

### Further artifacts and capabilities

- Formal Requirements: background/goal/scenarios/scope/rules/interaction/constraints/acceptance/assumptions/questions/provenance/history; distinguish user decision, Agent inference, code evidence, agreement and unconfirmed proposal.
- Derived Summary: goal, confirmed requirements, decisions, open questions, progress, next step with source versions/navigation. Never overwrite Journal/user decision/approved Plan.
- Fuller Plan/amendment UI: objective/scope/assumptions/acceptance/tasks/dependencies/owners/files/verification/risks/questions; approval binds version and changed scope requires reapproval. Extend existing plan seam.
- Decision UI: disagreement/both positions/evidence/tradeoffs/impact/recommendation and choose/request evidence/assign/defer. Current Todos/answers do not justify a separate automatic Gate engine.
- Test/Delivery results: actual commands/duration/exit/status/acceptance/files/risks/unknown/unrun scope. Unsupported Usage/cost is unavailable. Integrated terminal, arbitrary attachments and full test/delivery dashboard are not shipped.
- Capabilities: namespaced Skill/MCP/Plugin source/version/status/snapshot time with honest Best effort metadata. External Context retains producing Agent/capability/sanitized result/time/expiry/source without sharing credentials/tools. Plugin management/config conversion is excluded.

Full Journal replay/disaster recovery requires versioned event envelopes, deterministic reducers, the last-applied per-Session sequence, verified projection checkpoints and bounded Journal reads. Normal startup can use a verified projection; missing/lagging/damaged projections replay the appropriate checkpoint and later facts. Retention/GC cannot discard facts referenced by a Session, Comment, artifact, Checkpoint or audit record. Current persisted projections and recovery checks do not establish this complete replay feature.

### Automatic Checkpoints, deletion and storage

Checkpoint remains paused, **automatic only** and separate from current Fork/Undo. Direction: save visible Session/sent Comments/history/settings/Project files without speculative artifacts. Times: initial task baseline, actual new file version after task/background settlement, protective point before restore, and later-task baseline if external files diverged. Pure chat/questions/settings alone do not create identical file points. No manual Checkpoint feature is intended.

Default scope is tracked/nonignored untracked, explicitly included important ignored config, excluding dependencies/cache/build. Restore never silently changes HEAD/branch/index or creates commits. Retain ten unpinned automatic points with reference-aware FIFO, tentative 2 GiB/Session and 10 GiB/App subject to approved storage design. Deduplicate/protect pinned/unique restore bases and referenced Changes/unfinished Undo. Checkpoint FIFO cannot delete card recovery evidence.

Open: restore-original vs new Session, added files, active-Project gates, protection failure, Native consistency/recovery/storage. Earlier manual and Summary-first restore recommendations are withdrawn. Resume design must define ownership/atomicity/failure/GC events/space preflight and destructive preview/confirmation.

Future Session Delete affects only Pact index/UI with tombstone/references, never implicit Native history/files/Git/blob/audit destruction. Actual deletion needs separate scope/confirmation. GC handles only eligible unreferenced cache; tombstone/snapshot retention is undecided.

### Audit export and release

Planned local audit ZIP supports whole Session/time/checkpoint scope, inclusion/redaction preview, explicit save, manifest/hash/size/native reveal. Include readable transcript/facts/artifact versions/settings/Comments/approvals/reviews/tests/Diff/checkpoint metadata/sanitized capability/runtime errors. Default exclude credentials/cookies/authorization/MCP headers/OAuth/full env/raw native events/full source/untracked bodies. Map private paths and redact credential URLs/user/host/email/address. Diff/commands can be sensitive: preview risk and allow exclusion. Never auto-upload.

Distributable release must confirm OS/CPU matrix, signing/notarization/update channel, install/upgrade/uninstall/protocol ownership, third-party licenses/notices and runtime authentication/branding requirements. Pact is independently branded and offers no third-party subscription login/credential collection. Verify release-specific requirements instead of treating historical policy quotations as current. Code publication is not signed-package/real-provider/platform acceptance.

### Deferred alternatives

Independent Worktrees, phase-specific Model/Effort, remote/team service, fuller plugins and stricter independent curation require evidence/explicit scope. Do not revive hard Writer Lease/front-door snapshot/gateway/semantic novelty/multilayer Gate/arbitrary Agent count/cross-provider credential sharing from old proposals. A seam must own actual variation/trust boundary.

Further first-task goal/phase/interview metadata can be supplied within an already authorized root Turn. A separate Primary title/metadata request when the user explicitly selected Secondary is not currently authorized behavior: it adds a model Turn/cost and requires its own confirmed scope. Future convergence cues may report new information, repeating views and blocking questions with user decision exits; they must not impose unapproved automatic peer work, semantic scoring or a complex Curator/Gate hierarchy.

## Acceptance and maintenance

Preserve originals/source/role/authorization, one-root idempotent dispatch, cancellation/honest unknown delivery, user-priority titles/settings, atomic Send/Batch/result settlement, zero-write Undo conflict preflight and non-destructive cleanup. Trace normal and failure/restart paths through Renderer/Main/Utility/persistence. Retain meaningful regression/resource obligations after old plans are removed.

Feature Modules stay independently reviewable; Planned scope does not authorize implementation. [CONTRIBUTING](../../CONTRIBUTING.md) defines delivery/visual-first/migrations/platform gates, Performance defines resource requirements, Testing distinguishes contract/deterministic/real-provider/package evidence. Report actual failures/skips/unknowns; build/simulated provider success is not real-model or native-visual acceptance.
