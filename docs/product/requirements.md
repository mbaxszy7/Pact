# Product specification

Pact is a local desktop workspace for a user, Claude Code and Codex to work in one shared conversation. Users bring their own installed and authenticated CLIs. Pact routes requests, retains visible conversation and collaboration facts, presents native interactions and recorded file changes, and provides explicit recovery actions.

This document separates current behavior from **Planned scope**. A future requirement is neither an implemented capability nor authorization to build it. Process boundaries, persistence, resource limits and measurement belong to [Architecture](../technical-foundation.md), verification to [Contributing](../../CONTRIBUTING.md#testing), appearance to [Design](../../apps/desktop/DESIGN.md), and terminology to the [glossary below](#terminology).

## Terminology

Use these terms consistently in code, UI and documentation.

| Term                       | Meaning                                                                                                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project                    | A canonical user-added local directory reference, classified as Git or directory. Rename/archive changes Pact metadata, not files.                                                       |
| Session                    | One shared visible conversation belonging to a Project, with its own settings, native bindings, history, Comments and collaboration tasks.                                               |
| Primary / Secondary        | Default Session responsibilities. Explicit message/task routing can choose either Agent without permanently changing these defaults.                                                     |
| CLI Ready                  | The selected native CLI is discoverable, accepts its own effective authentication and can start its control/probe operation. This does not guarantee model quota or future task success. |
| Runtime Preparation        | First-use setup before defaults are saved. Both CLIs must be Ready; no model task is used to prove readiness.                                                                            |
| Runtime Degraded           | A returning user's readable workspace with Agent-start actions disabled while a required CLI is unavailable. It is not a return to onboarding or an offline mode.                        |
| Default Session Settings   | The singleton App template copied when a Session is created. Global edits affect future Sessions only.                                                                                   |
| Session Settings Revision  | An immutable whole Session configuration. A Run keeps the revision frozen at admission; later tasks use later saved revisions.                                                           |
| Agent Run / root Turn      | One explicitly authorized execution owned by a concrete Agent, with native identity, completion and delivery evidence. Root Turn does not mean exactly one provider API request.         |
| Native Agent Context       | One provider's own conversation identity/private history. Claude and Codex maintain separate native contexts for the same Pact Session.                                                  |
| Binding generation         | The identity epoch tying one Agent's native context and executor to the Pact Session. Retired callbacks cannot mutate the current binding.                                               |
| Durable Session Context    | Pact-owned original messages, sent Comments, images and collaboration facts preserved independently of native private context.                                                           |
| Event Journal              | Ordered durable facts about execution, messages, decisions and recovery. It is not a raw token stream, diagnostic log or complete provider transcript.                                   |
| Message Projection         | A bounded/readable representation of an immutable or streaming message source. Preview/cache eviction never changes the original source.                                                 |
| Work Log / Agent Activity  | Sanitized provider-visible progress and Tool lifecycle for a Run, excluding hidden chain-of-thought, unrestricted arguments and raw output.                                              |
| Session Activity           | Current Run/interaction/recovery needs, independent of a collaboration task's workflow phase or review verdict. Idle means no active work or required user response.                     |
| Session Title              | Pact's display name, with placeholder/local/Agent sources and user rename priority. Derived native `[Pact]` naming is separate.                                                          |
| Cross-Agent Handoff        | Ordered, source-attributed user questions and completed answers not yet received by the target Agent, with Comments/images and frozen coverage. It does not merge native contexts.       |
| Ordered independent `@all` | Primary then Secondary on one User Message. Secondary excludes this round's Primary answer; later ordinary Handoff can deliver it. It is not shared-file isolation.                      |
| Peer Proposal              | A validated lazy suggestion to ask the other Agent. It starts no work until the user clicks and cannot consume current drafts.                                                           |
| Collaboration Task         | One `/plan`, `/build` or `/review` objective with a fixed owner/reviewer, versioned sources, bounded automatic handoffs, pause state and counted actions.                                |
| Workflow stage             | One host-authorized responsibility: plan, plan review, implementation, code review, response, repair or priority user reply. A role label alone grants no edit or acceptance authority.  |
| Current Plan               | The complete native plan snapshot maintained by the task owner. Its independent reviewer comments on an exact version without maintaining a second plan.                                 |
| Review basis / fact        | Exact frozen plan or code scope/source plus the responsible Actor's actual completed verdict. It is not an entire workspace snapshot or an inferred agreement.                           |
| Task owner                 | The selected plan author or implementer, fixed for the task. The owner is the default implementer after plan acceptance; the other Agent independently reviews.                          |
| Native question            | A provider-originated user interaction answered through its live form. The answer resumes that same native root and grants no new implementation or repair authority.                    |
| Automatic collaboration    | Previously authorized, bounded handoffs between the fixed author and reviewer. It pauses independently of the current root and never grants an unapproved code-writing step.             |
| Input Batch                | All accepted body, image, Skill and Comment sources from one atomic Send, including members outside the resident UI page.                                                                |
| Handled input sequence     | The task input version handled by a normally completed authorized root. Later user input invalidates dependent acceptance and cannot be settled by an earlier reply.                     |
| Plan ready                 | The current plan has independent acceptance against the current input sequence. Its Implement plan Proposal still needs user approval and current runtime admission.                     |
| Anchored Comment           | A persistent user draft or sent observation tied to an immutable message, plan or report version, or a versioned Project-file selection, retaining its quote and exact source.           |
| Project File Reference     | Click-triggered local text preview metadata. Relative paths stay in the Project; explicit outside absolute paths are preview-only and grant no Comment/Undo authority.                   |
| Changes Card               | Actual native-recorded file modifications for one settled Run. Missing/mixed evidence limits Undo; it does not block native forward tools or claim full Project coverage.                |
| Undo                       | Whole-card guarded inverse file application after all-file conflict-free preflight. It has no Redo and does not restore transcript, native context, Git state or external effects.       |
| Native permission mode     | Session/Agent choice of Native, Ask, Auto or confirmed Full access. Tool approvals are separate transient native requests; modes do not save global permission rules.                    |
| Unknown delivery           | The request may have reached native execution but its outcome is not established. Do not blindly resend or infer termination from timeout/silence.                                       |
| Retry / check              | Inspection or saved-result/candidate readback, without a new model task, old-request replay or new native candidate.                                                                     |
| Rebuild                    | User-confirmed verified initialization from durable visible history into a new native binding. It is not native resume, Fork or replay of the prior task.                                |
| Returned input             | A durable receipt for a provably unsent/refused latest input excluded from a successful Rebuild seed, offered back for explicit user Send without overwriting newer drafts.              |
| Fork                       | A new Pact Session and genuine native branch for both Agents at one completed-answer boundary, sharing current Project files. It is not historical code restoration.                     |
| Managed image              | Immutable locally saved PNG/JPEG/WebP content referenced by messages/receipts/branches; a thumbnail is a disposable view.                                                                |
| Native compaction          | Provider-managed private-context reduction while retaining the same native identity. Pact does not treat it as missing history or auto-Rebuild.                                          |
| Checkpoint                 | Planned automatic Session/workspace restore point. Separate from current Fork and Changes/Undo; no complete Checkpoint feature is shipped.                                               |
| Writer Lease               | A former hard forward-write proposal, withdrawn from current execution. Pact only coordinates its own Undo and known native Runs, not external editors/tools.                            |
| Diagnostics                | Bounded sanitized local operation logs. They do not replace the SQLite Journal or the planned full audit export.                                                                         |

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
- Local development and locally packaged production identify themselves separately from official Pact installations and use distinct application browser profiles. Existing development records and saved image/Changes objects are retained. CI development uses Pact Dev and validated Actions downloads; Stable uses Pact and complete-platform immutable Releases. Projects and native provider configuration remain user-owned shared resources.

## Current capability boundary

The code includes runtime preparation, first-use defaults, Project/Session management, streaming conversations, explicit routing and ordered `@all`, native Skills, static images, anchored Comments, native permission/input interactions, explicit Native Session recovery/Rebuild, recorded Changes and guarded Undo, genuine two-Agent Native Fork, `/plan`/`/build`/`/review` collaboration, and bounded local diagnostics.

It does not implement a global hard Project Writer Lease, arbitrary full-workspace snapshots, Session Checkpoints, automatic model-driven discussion, full audit export, complete capability/plugin management or unlimited-history Handoff/Rebuild/Fork. Current authorization and native permissions govern forward editing; incomplete recording limits Pact review/Undo, not native execution.

## Runtime preparation and first use

### Readiness

Assess Claude Code and Codex independently through executable discovery or a saved manual path, version, the CLI's own authentication status and bounded startup/probe operations. Never read, retain or display credential values. Missing, unauthenticated, unavailable, timed out and unconfirmed are distinct outcomes with installation/login guidance, manual location and retry.

Minimum supported CLI versions are Claude Code **2.1.272** and Codex **0.159.2**. Compare numeric version components, ignoring build metadata; a prerelease of the minimum release is not sufficient. An older version has an explicit Upgrade required warning, showing the detected version and required minimum with upgrade/recheck guidance. Unreadable versions remain unconfirmed, never Ready. Version compatibility is checked before authentication or native execution; Pact does not install or upgrade CLIs automatically.

An existing manual executable choice takes precedence. Without one, Windows Claude discovery first
uses the newest completed versioned native runtime installed by Claude Desktop, then inherited PATH
and platform lookup. Readiness, model catalogs and native recovery use that same selection policy;
automatic discovery never persists a manual override. Incomplete installations are not executable
candidates, and bounded discovery failure is not permission to choose an older truncated result.

**CLI Ready** means the selected CLI is discoverable, accepts an effective authentication method and can start its control/probe operation. It guarantees neither network, quota, model availability nor future Run success. Claude's accepted local API authentication is valid without a subscription login. GUI processes inherit only the environment available at launch; a later terminal export does not change an already running Pact.

First-time users remain on Runtime Preparation until both CLIs are Ready, then must complete Default Session Settings. There is no hidden skip or fake-model validation. Saving defaults and completing setup is atomic.

Returning users enter their existing workspace and refresh readiness there. If either CLI is not Ready, **Runtime Degraded** keeps local Projects/history readable and settings available while disabling Agent-start/continue actions with the reason. Recovery restores those actions; each actual execution still checks the runtime, rather than trusting stale Ready state.

The existing top yellow warning bar identifies required CLI upgrades during normal use and links to the same Runtime Preparation page. Readiness refreshes on window focus/visibility and once per minute while visible, with no background polling or automatic retry loop. After upgrading, Check again/Retry rechecks the selected installations and clears the warning when both Agents are Ready.

### Defaults, Model and Effort

One App Default Session Settings template contains Primary/Secondary, independent Model/Effort for each Agent, discussion rounds (default 6, range 1–20), review cycles (default 3, range 1–10), and repair attempts (default 3, range 1–10). The Composer's explicit Queue and Steer actions govern ordinary running-message delivery. Retired database columns do not select a live behavior. Speed has no App default or setting in the App, Session or creation-time settings forms.

Speed offers Native, Standard and Fast; new Sessions start at Native independently of the App template. Native preserves the selected CLI's speed configuration; Standard explicitly requests ordinary speed; Fast requests compatible native acceleration without changing Model or Effort. Each Session and Agent owns its selection. Composer groups each Agent's independent Permission and Speed menus with a divider, following the Project folder/branch controls. Speed always displays its label and value; dropdown arrows remain neutral even for Full access. Selection saves immediately through a revision-checked single-Agent update, while a Run keeps its frozen settings revision. Changes apply to the next execution. Settings-page saves preserve current Speed and permissions; uncertain replies trigger readback without automatic resend. Fast can increase usage or cost; known incompatibility continues at standard speed with a visible reason. Requested speed and provider-observed state are distinct; an acceptance ACK does not prove acceleration or account entitlement. If an override was not applied and no effective speed was reported, the Run header shows Native speed and an info icon exposes the explanation on hover or keyboard focus. A possibly delivered failure never causes a second standard-speed execution. Unsupported native controls identify their limitation without claiming an override succeeded.

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

Project/Session Archive hides App entries without deleting files, settings, messages or Native histories. Idle items archive directly. Active tasks require a Pact confirmation showing the affected Sessions: Cancel changes no task; Stop and archive requests interruption and waits for actual native settlement and saved output before hiding the item. Project archive confirms its affected tasks once and archives the Project only after all settle; it does not cascade Session archive state. Partial failure, timeout or unconfirmed native work leaves the item unarchived and identifies finished, stopped and unresolved tasks. Unsupported recovery, Rebuild, Fork or detached work must finish or be checked before archive; archive never invents a successful Stop. Confirmation expires or requires review if the task identities change. Immediate Undo restores visibility without restarting tasks; re-adding an archived canonical Project restores its identity and Sessions. Permanent delete and a persistent Archive browser are not exposed.

Archive feedback combines successful, failed and unconfirmed results in one summary with an expandable, paged list. Each entry identifies the Session or Project and its own result; a Project counts as one entry even when its affected Sessions have different Stop outcomes. Undo restores only the selected successful entry and removes that entry after confirmed restoration. Failure details preserve individual Stop outcomes; Review again prepares current task identities and requires confirmation for active work. An unconfirmed entry only checks the original operation; it cannot authorize another Stop or be dismissed until resolved. Retrying a failed item updates its existing entry. Results remain available until explicitly dismissed or the Renderer restarts; new archives do not overwrite earlier Undo actions. At the display capacity, further archives require reviewing or dismissing resolved entries first. Restoring an independently archived Session requires its Project to be visible first. Feedback is a disposable projection; durable archive receipts remain authoritative.

The Composer footer shows the canonical folder basename and current Git branch beside the permission menus. Folder actions open the registered Project directory in the native file manager or copy its complete path; the branch action copies the complete branch name. A renamed Project display name does not rename this filesystem label. Refresh on entering the visible Session, returning window focus, opening a context menu and Run-state changes. A selected subdirectory inside a repository shows that containing repository's branch without changing the Project directory or classification. Directories outside a repository omit Git metadata; detached HEAD shows its commit without inventing a branch name. Read/open/clipboard failures remain visible and retry is explicit.

### Session ownership, title and activity

One Project may have multiple Sessions. Each owns transcript, settings, separate native bindings/cursors, Runs, Comments, images and collaboration tasks. No other Session's work may overwrite those facts. Only one admitted Agent Run executes per Session, with App/resource admission in Performance; this is not a filesystem lock against external editors/native background tools.

`New session` is immediate; a local first-message title is fallback. An Agent/native title can arrive within the existing authorized root Turn, without a hidden title-model Turn. User rename always wins. Only successful, current, correctly attributed root/generation evidence can be adopted; foreign/child/failed/expired/duplicate results cannot rename. A Fork preserves its inherited title semantics.

After adopting a native title into Pact, Codex's display name may become `[Pact] Project name · Session title`. Save user renames locally before one-way native synchronization. Failure does not block chat/rename; the next normal connection can reconcile. Never change an old generation, unconfirmed candidate or unrelated client's thread. The prefix is not part of Pact's own title. Users may intentionally open the native thread in another client; Pact does not hide it or migrate authentication to prevent this.

Activity projects actual Run/interaction/recovery facts, independent of collaboration phase/verdict. Normal completion returns Idle; Waiting means an actual required question/approval. Completed, failed, interrupted, unknown-delivery and abandoned remain distinct. Unread follows durable completed-message sequence and recorded reading position, not transient deltas/title changes.

Navigation is Project → Session, with neutral Project rows, folder disclosure, hover/keyboard-focus actions, 6 px before indented child Sessions and no persistent connectors/`Sessions`/branch/path/count/Changes metadata. There is no dedicated application fullscreen feature. The center header retains title. Settings temporarily replace navigation content and hide Context; Back restores workspace topology.

### Resident application and native Session navigation

Each complete application start centers the workspace on the display containing the pointer, at
80% of that display's available work-area width and height. Sizing uses logical display coordinates
and excludes taskbars, menu bars and the Dock. Prefer a 720 by 520 minimum, capped by the available
work area on smaller displays. Revealing a running instance preserves its current geometry and
window state; an unreachable title bar is moved back into an available display's work area.

On macOS and transparent-backed Windows windows, the first workspace display and a normal or maximized workspace revealed from
the tray fade in over 150 ms; closing to the tray fades out over 100 ms. Already visible windows
are focused without replaying the entrance. Repeated visibility changes replace the current target
from its current opacity. Reduced-motion or disabled system animation settings use immediate
visibility changes. Native minimization/restoration, fullscreen and macOS Space transitions retain
their native behavior without an additional workspace fade. Opaque Solid Windows windows use system
window operations without custom opacity or shape updates. Transparent Windows windows retain their
current effects and do not promise native scaling animations unavailable to that window style.

On macOS and Windows, closing the workspace hides its window and keeps Pact and its existing work
available from the system tray. The tray uses a monochrome version of the shared Pact mark; macOS
uses a transparent Template image. Clicking the tray icon shows and focuses the existing workspace.
Right-click opens a native menu with Show Pact, Needs attention, Running, Recent Sessions and Exit.
Window closure does not authorize Stop, archive or another Agent Turn.

Needs attention includes actual pending approvals/questions and unresolved native recovery, using
the same facts as the workspace. An ordinary unread answer alone is not attention. The menu shows
up to five entries and the total, with a paginated App view for additional entries. Running shows
up to five Sessions with an actual native Adapter, including recovery and native checks. Waiting
for an Adapter is Starting, rather than Running. Recent Sessions are the five most recently opened
visible Sessions across Projects, excluding the other groups and filling any resulting gaps.
Repeated selection of the already visible Session is not a new opening. Native entries identify
Session and Project names and state without conversation bodies, Project paths or private requests.
The full attention view also retains unread indication.

Selecting a native entry reveals the workspace and opens that Session without sending input,
restarting work, restoring an archived entry or initializing a native context. A newer deliberate
Session choice supersedes an older pending navigation. Archived or unavailable entries report their
current state and leave the existing selection available. Recent ordering persists across restarts.

Packaged Windows applications publish the same Session groups in their taskbar JumpList. Entries
launch that exact application identity with only the Session identifier; a second launch reveals its
existing instance. A normal confirmed exit retains recent entries for cold launch and removes live
groups. Windows privacy or policy can disable custom categories, and removing a Session from the
JumpList suppresses it until a later deliberate App opening. Windows development publishes the same
groups for its running repository-specific instance, with the Pact development name and icon.
Development taskbar entries only reveal or navigate that existing instance; after a full exit,
start it with `pnpm dev`. They never launch bare Electron or an older Renderer build. Normal
development exit clears custom categories unless pending Windows removal records must be preserved.
macOS publishes the groups in its Dock menu while Pact is running.

Exit, the application Quit command and macOS Cmd+Q use the existing safe shutdown owner. Known idle
work exits directly. Active or unsettled work opens a Pact confirmation listing affected Sessions;
Cancel keeps working, and Exit Pact confirms that work may be interrupted. Unavailable or uncertain
runtime state requires confirmation rather than assuming idle. Cancellation is confirmed before
the dialog closes. During shutdown the workspace and tray remain available until the actual runtime
exit is established. Saved conversations and files remain on the device; unsent ordinary drafts
retain their existing restart behavior. System shutdown or logout does not wait for this user
confirmation. A system dialog is a fallback only when the Pact interface is unavailable.

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

Normal response keeps Composer editable and retains Stop. While responding, Enter queues one complete input and Shift+Enter inserts a newline; IME and autocomplete retain their own acceptance rules. A full queue preserves the new draft and reports the occupied slot. With queue disabled, Enter inserts a newline. Idle Enter sends normally. Stop requests native interruption, preserves completed changes and pauses pending input; real settlement is required. Lost observation is not a successful Stop. Recovery/read-only gates remain stronger than editing.

Each Session holds at most one durable queued message, including complete body, images, Comments and Skills. A compact bar above Composer shows recipient and preview, with Steer, Remove and a menu containing Edit message and Disable queue. Disable queue is Session-scoped: retain the item, pause automatic delivery and keep manual Steer available; an empty disabled queue provides Enable queue. Re-enabling restores otherwise eligible delivery. Edit message atomically removes the unsent item and returns its complete content to Composer, directly overwriting the current draft; the queue is then empty. There is no separate edit mode. A later Send creates a new input. Recoverable return receipts preserve sources through lost ACK/read failure/restart, and explicit restoration cannot overwrite newer input through a stale request.

Normal completion, sealed output and settled side effects permit automatic queue delivery before later collaboration work. An original ordered @all Secondary completes first to preserve independent native history. Stop, failure, disconnect or restart preserve and pause the item until Resume queue. Unknown delivery remains locked for checking its original Run without automatic resend. After a confirmed Rebuild abandons that exact Run and replaces its binding, explicit Remove releases only the Pact queue slot; native delivery, frozen sources and unresolved Batch obligations remain retained. Late receipts belong only to the original Run and cannot affect replacement input. Pending content does not expire merely because execution takes a long time. Submission settings are read at actual execution admission; route and immutable input sources remain frozen.

Steer targets only the same single currently running Agent and keeps its Model/Effort/Speed, native permissions and frozen duty. Ordinary @all and new workflow commands remain queued; workflow feedback remains a single-recipient input. Codex uses an exact current-Turn precondition; Claude uses next at a safe point and can naturally continue into the next native turn in the same Pact Run. Unsupported steering reports its reason without interrupting or starting a replacement task. Native acceptance is distinct from consumption and full handling. Workflow messages use a priority next-turn reply while automatic handoffs are paused; native Steer is available only for ordinary conversation Runs and is rejected for workflow Runs. Known consumed native input identities preserve complete multi-turn reply recovery and Fork boundaries. These capabilities depend on the actual CLI and must pass real-provider verification; SDK field presence or mocked results alone do not establish support.

Accepted Steer freezes the already committed complete output snapshot at its original source identity and position. Subsequent output starts another full snapshot below the supplement in the same Run; repeating earlier text is allowed. Work Log stays in place while responding, then moves into the final answer and resets collapsed on completion, even if previously expanded or being read. Users can explicitly reopen it. After normal native completion, a committed nonblank canonical answer and resolved delivery/recovery, intermediate snapshots are automatically hidden from the main transcript. The main transcript keeps all User inputs in order followed by the final complete answer, including when no new text followed the last Steer. Only display order changes; source sequence, hash, Comment basis and ranges remain exact. Finalization waits for the complete body and bounded gap recovery, then updates the transcript without preserving the preceding reading or expansion layout. There is no dedicated earlier-response or manual collapse control. Jump to latest appears only for genuinely newer history. Exact historical Comment sources remain reachable through bounded pages; contexts and bodies share the existing 25-row page and 100-row window. Failed, interrupted or uncertain Runs retain their snapshots. Native history uses only the canonical answer; Fork copies presentation metadata without duplicating forwarded history. Legacy Runs have no inferred historical cuts.

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

Anchor a Comment to immutable message, plan or report text, or a versioned Project-file range, retaining identity/hash/projection basis/range/quote. Message ranges use visible projected text; plain fallback has its own explicit basis. File anchors use Project-relative forward-slash paths and content hash/line/column. Unsupported historical anchor formats remain visibly unavailable; they are never converted into a different source.

Add to comment saves without dispatch or implementation authority. Composer collects independent Comment chips with body/images for one Send. Native question answers use their live form and are not persistent question-answer Comments or an alternate workflow dispatcher.

Stable request identity and expected revision govern saves. ACK closes only the matching editor/revision; later edits stay open. Frozen/sent members are immutable, so subsequent edits become new drafts. Add/cancel a dirty source editor before changing its source/group/page. Recovery freezes mutations and retains drafts.

### Atomic completeness

The accepted Comments revision freezes every valid draft, including unloaded pages, body/images/route/nonce/task source into one durable **Input Batch**. Conflicts reject the whole receipt and preserve inputs. Keep each accepted input atomic; do not split its Comments into additional Send receipts or omit later pages. Workflow handoffs have their separately frozen stage authority. The former ten-Comment Send cap is removed: 24 is a metadata-page bound, not a durable-member bound. Per-comment body/quote and physical page budgets remain.

Ordinary/collaboration Runs use the same bounded frozen-source reader for complete Batch members. Handoff/Rebuild retain references; Rebuild launches no model to read/summarize them. Input return clones identities from original sources; Fork maps them consistently. View-cache eviction never deletes durable members/drafts/sent Comments.

Batches preserve complete original input sources and their receiving Run. Workflow settlement binds the completed root to its frozen task input sequence; models do not submit per-member response receipts. A later message cannot be silently covered by an earlier completion, and a Batch does not fan out into additional Agent calls.

A confirmed necessary-information answer is current user information for the same original request.
The dispatched user input includes that exact answer, while the original Batch, declaration and
answer source remain immutable. Complete the requested result using supplied values instead of
asking the same answered field again. Answering changes no route, tool authority or permission.

### Return to source

Return to the exact original source/range. Current plan is read in Context Plan, never expanded fully again in Chat. Historical plans and reports remain immutable sources. Unsupported old anchors retain their quote and an unavailable reason instead of reopening removed task-item UI or retargeting the Comment.

Context Plan reads continuously in both directions without Previous/Next controls. Transport pages do not truncate the document or a valid Comment quote. Selection keeps immutable source coordinates as visible pages change; creating a Comment requires complete quote verification and original selectable text throughout the range. Display aliases are not original quote text. Returning to a source verifies the complete range before acknowledging navigation, while highlighting its currently mounted portion. The existing three-page mount limit and single physical source read also apply during selection; each quote fragment is at most 4096 UTF-16 units/48 KiB. The logical quote remains bounded to 20,000 units with at most 20,000 coverage bytes. Merged/display trees and an in-progress replacement are separate bounded copies, not part of a claim that total memory equals three transport pages.

Failure retains the quote with a warning; read/transport failures show errors. Never silently retarget to similar text, open empty Context, rewrite anchors or guess current status. Repeated return gets a new navigation identity and waits for asynchronously loaded body DOM before positioning; preserve keyboard focus, selection and deliberate scroll on refresh.

Current durable Comments distinguish Draft/Sent. Automatic Comment resolve/wont-fix and line-remapping to changed files remain planned rather than existing durable states.

## Explicit collaboration

### Entries and fixed responsibilities

Pact commands are structured App actions, distinct from installed native Skills and native slash controls. Same-name Skills remain selectable by source. Commands quoted in prose, code or history do not start work. A workflow entry authorizes its bounded automatic handoffs; implementation and each new repair keep their own explicit write authorization.

| Entry              | Initial work                                                                                              | Fixed owner and reviewer                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `/plan [task]`     | Native planning and necessary clarification, followed by automatic independent review and author revision | Selected Agent, otherwise Primary, owns the plan and is the default implementer. The other Agent reviews. |
| `/build [task]`    | Explicit implementation, then automatic independent code review                                           | Selected Agent, otherwise Primary, implements; the other Agent reviews.                                   |
| `/review [target]` | Read-only review of the specified scope                                                                   | Selected Agent, otherwise Primary, reviews; the other Agent is the response/repair owner.                 |

Freeze objective, owner, reviewer, stage, authorized scope, current input sequence and plan/review basis at each Run's admission. Session Primary changes do not transfer an active task's responsibilities. The plan owner maintains one plan throughout drafting and revision; there is no separate adoption step or competing reviewer plan.

### Native planning and clarification

Use Codex and Claude Code native Plan mode with a dependency-aware clarification workflow. Inspect discoverable repository facts first. Ask only decisions that materially affect the goal, scope, acceptance or implementation; resolve upstream choices before dependent details, using at most three material questions at once. Distinct choices may include a recommendation, which never submits an answer automatically.

Necessary questions may precede any plan. Do not fabricate a complete provisional plan to satisfy a result protocol or continue dependent work while required answers are missing. Native question forms replace the ordinary Composer, retain its unsent draft and attachments, and require the user's actual answer to resume the same native root. When the native request clears, restore the pending workflow decision or ordinary Composer. Answering a form does not unpause automatic collaboration or authorize a writing step.

The owner submits a complete native plan. The reviewer receives the original objective, current decisions and exact plan, supplies a natural review report, and either accepts it, requests changes, needs a user decision or reports incomplete work. The author responds and revises as necessary; the reviewer checks the current version and important responses. A native submission that explicitly retains the authenticated frozen plan preserves its version and source; a complete author response goes to independent review. Failed or pending edits and unresolved native questions cannot be treated as an unchanged plan. Agreement means the current plan is implementable without unresolved blockers or necessary user decisions, not that every suggestion was adopted or both Agents repeated the same conclusion.

Native plan submission never starts implementation. Codex uses native plan items; Claude captures acknowledged writes/edits to its root-bound native plan document; a plan-exit request never approves coding. Reviewers use read-only review execution rather than native Plan mode's authoring workflow. Codex retains native read-only sandbox enforcement for read-only stages; Claude uses native Plan mode or stage-specific tool policy. These controls do not isolate arbitrary native Hooks/MCP effects.

### Implementation and code review

Plan ready requires a complete current plan, its fixed independent reviewer's acceptance of that exact version and current input sequence, and no later unhandled relevant user input. Native completion, prose that sounds positive or a progress task list cannot establish acceptance. Changed plan or input retires the dependent acceptance. Temporary admission failure preserves valid review facts while disabling dispatch.

The user clicks Implement plan to authorize the displayed version and owner. Completion automatically starts independent code review, as does the initial `/build` implementation. Direct `/review` remains read-only and grants no repair permission. Review scope binds its target and available implementation/repair Run, recorded changes and checked evidence; it does not imply a whole-workspace snapshot or automatic external-edit detection.

A review requesting changes offers Respond or Repair. Respond lets the owner explain or challenge findings read-only; Repair authorizes one scoped code-writing attempt. Both automatically return to the fixed reviewer when their complete sources and native effects settle. A fresh required repair needs a new explicit action. Acceptance ends the task without a third summary Turn. Findings, suggestions, evidence, author responses and unverified scope stay in natural reports rather than a shared per-item state ledger.

Implementation, repair and code-review reports state confirmed verification results truthfully and explicitly label anything they cannot confirm as **Unverified**, in the user's language. Reviewers distinguish author-reported results from independently checked evidence. A completed Agent Run or tool acknowledgement is not proof that tests passed. Missing evidence is a disclosed limitation; verification explicitly required for acceptance remains unresolved until confirmed. Use the existing natural reports and available sources, without a separate command-execution proof system.

An interrupted implementation or repair retains its unfinished authorized scope and owner. Continuing that same work does not create a new repair attempt. A priority user reply stays read-only; it cannot complete unfinished implementation or substitute for write authorization. A completely processed later reply may advance the input cursor while the original write grant remains bound to its original input. Pre-receipt workflow records retain their verified original grant and complete source access on explicit Continue; migration does not manufacture consent or rewrite historical authorization.

Context Plan is the sole full-plan reading area. Chat retains complete natural replies and review reports with compact plan-version/status/action footers, not a duplicated full plan or shared Todos tab. Current Implement, Respond, Repair, Continue collaboration and failure actions remain visible independently of historical disclosure.

### Automatic limits, pause and continuation

Session settings provide three independent limits:

| Setting           | Counted action                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Discussion rounds | Each plan review, including the first review of the initial plan and each revised-plan review. Initial drafting, author revision and user questions do not consume a discussion round.     |
| Review cycles     | Each code review, including the initial review and every rereview after a response or repair.                                                                                              |
| Repair attempts   | Each explicitly authorized repair that starts; initial implementation and read-only responses do not count. Resuming the same unfinished authorized work does not consume another attempt. |

Reserve and persist a count before dispatch. Release it only when execution is proven unsent; failure, uncertain delivery, pause, user reply, restart or a new Proposal cannot reset consumed history. Current execution may finish, while the next automatic step must fit the current Session limit. At a limit retain the plan, reports, changes and exact next-step reason; changing settings affects later admission and never silently replays uncertain work.

Workflow continuations share a durable handoff receipt keyed by the original task, producing Run and
transition slot. Manual and automatic triggers with different message receipts compete for that one
Run and its existing collaboration count. Configuration, model, pause and ordinary task revisions
change freshness checks without creating another dispatch identity. A later business Run creates
the next handoff; continuing unfinished authorized work retains its original writing authorization.

Persistence records same-fact evaluation deduplication, invocation counts and independent budgets
for extra Turns and recovery. Evaluation calls have no cumulative task, stage, input or fault cap;
counts and reservations never grant business authorization. Relay defaults off and requires an
explicit exact-model selection. Enabling it, reading its state or refreshing a native catalog does
not start inference. Automatic checks, positive-unsent replacements and qualified extra-turn
proposals use the existing Conversation execution owner and durable Repository facts. Existing
Check session/status and Rebuild retain their controls when Relay is off or unavailable. Native,
platform, visual and real-provider acceptance is separate from local fixture tests.

Relay consults only at qualified handoffs. A Plan containing a processed user decision after review
can receive review focus when it has at least two frozen sources. A second changes-requested review
with an intervening complete owner response can receive revision focus. An owner completing the
same repeated-review chain can receive rereview focus; retaining a Plan alone does not qualify.
Repair following a complete Respond in the same review scope can receive code-review focus. Simple
first plans, first review feedback and first implementations skip consultation. The owner, reviewer,
original goal, permissions and required review steps remain fixed. Manual Continue does not wait for
advice and competes for the same durable handoff claim. Further code-review actions still require
concrete user authorization.

Relay decisions use their own request/revision and answer/receipt identities. The only admission
categories are a concrete arrangement change, genuinely missing new authorization, or necessary
scheduling information unavailable through existing authorized investigation. The host checks the
actual operation, source basis, missing authority, versions and duplicate interactions; a model's
uncertainty or technical disagreement alone cannot open a card. Task requirements and technical
questions remain with the original Agent. The strict contract represents all three categories;
native recovery has a deterministic arrangement-change consumer. Users send their task directly;
the Composer has no manual question, choice or supplied-state configuration. Necessary task questions
use the existing native forms or workflow decision replies. Confirmed answers remain bound to the
same original request and follow its owner's existing continuation rules. Frozen information and answer sources remain
readable for saved requests and recovery. Cancel terminates an unsent information request and returns
to the current Composer with editable Comment copies; it offers no Continue for that request and
retains newer draft edits. The next explicit Send sends the current draft under a
new message identity. Stop, restart and preparation failure retain their existing explicit Continue
with current execution settings and original frozen sources. An unconfirmed Cancel retains one
receipt-check entry in its Session, including after switching Sessions. Until its matching receipt
confirms cancellation, ordinary Send waits; other Sessions remain usable. Checks never repeat the
Cancel mutation or resume the old request. Closing Relay uses the
original legal default once only when the user has not paused and its original admission is current.
Do not invent business questions or ask for facts available through authorized investigation.

At a qualified repeated-review handoff, Relay may propose one read-only author
supplement and its mandatory return to the fixed reviewer. The user does not first request or
preauthorize an evaluation. Confirmation grants that exact extra Turn; no second inference decides
whether to use it. Its approved responsibility and cited complete originals are frozen for the
receiving Agent. The existing task-level extra-turn allowance and return-review limit still apply.
An existing concrete manual action or Run claim takes priority over a late proposal.

At the same qualified repeated code-review checkpoint, Relay may request one scoped Repair. No
writing grant exists before confirmation. Its normal Repair receipt freezes current review scope,
complete sources, owner, execution permissions and fixed reviewer. It charges both the extra-code
allowance and the original Repair count, with room for the required review. Use ordinary
Repair-to-review behavior, not read-only supplement authority. Continuing an already-authorized
write never consumes another auxiliary allowance.

Automatic recovery checks only newly qualified faults in the current Utility/configuration epoch:
the original Run/binding, exact input-delivery receipts, or the same existing Rebuild candidate.
Substantive changed native facts can permit another check; changed timeout prose, configuration
ABA, model recovery and restart cannot recreate eligibility. Keep original budgets: at most four
checks per task or two per ordinary input, and two per fault. Authentication, quota, permission and
incompatible-runtime failures retain existing controls. One automatic ten-second deadline includes
preparation and serial reads. Logical expiry retains the App lease, Adapter and physical obligations.
When a newly qualified fault has no fresh compatibility observation, the existing probe owner may
perform one zero-Turn check before recovery admission. Opening Session settings is not a prerequisite.
The fault remains consumed if compatibility cannot be proved; there is no deferred retry queue.
Manual receipt and root/candidate reads have independent ten-second stage budgets; receipt cleanup
joins before root inspection begins.

A replacement needs a positive typed boundary proving that the exact original root was not
delivered. Generic rejection, absent output/history, timeout, EOF or completed inspection is not
proof. Preserve the complete pathless original prompt, immutable input Batch, Comments/anchors,
images, Skills, source grants and historical requested/native-effective settings. Optional segmented
capture is bounded at eight MiB and 4,096 entries; overflow closes replacement eligibility without
truncating or limiting the original Send. Unknown effective model, effort, speed, permissions or
configuration closes eligibility. Utility resolves native image/Skill paths through existing owners.

The independent replacement reuses the original user Message, input Batch and duty without
freezing later drafts, advancing the input cursor or creating fresh authority. Each original fault
permits at most one replacement, within two per task or one per ordinary input. Duplicate operation
receipts return the same Run after lost acknowledgments. Reacquire actually refunded business
counters and extra-turn reservations once, preserving linked history. Recheck native executor,
session, generation and effective settings at actual delivery. Stop, user pause, newer input and
conflicting scope prevent dispatch. Each failed `@all` leg is independent; never replay a completed
leg. Claude replacement stays closed when a new Query has a different executor. Check an uncertain
replacement against that child Run using the original fault budget, never a fresh fault or blind Send.
On Codex 0.163.0, a fresh Thread with no materialized rollout cannot resume after a pre-write failure.
That native rejection ends the replacement without another root write, model request or executor;
the original fault allowance remains consumed. The proven positive path uses an existing native
Session with a completed prior Turn.

After an automatic check physically joins, a current Rebuild action may appear as a Relay arrangement
decision. Host facts do not fabricate a model evaluation. Confirmation and the existing Rebuild
operation commit atomically under one answer nonce. Only a newly created transaction starts native
work; receipt reads and restart never recreate it. Preserve exact generation, original Run/candidate,
complete initialization source and binding-switch evidence. Show when old work may continue or an
earlier attempt may already have created a session. Rebuild does not repeat the prior task or resume
collaboration; unsent input keeps its explicit restore/send flow. Cancel preserves recovery and
same-matter deduplication. Hide only the recovery row represented by the visible Relay card.

Read-only Activity projects actual inference, user decisions and native operations from SQLite.
Distinguish suggestion, acceptance, dispatch, business completion, readback and rebuilt context.
Show historical provider/model only when inference ran; native checks and deterministic recovery
do not invent model calls. One stable original-fault row groups checks and replacement. Unresolved
facts survive the thirty-day recent window. Pages hold at most 25 rows; Renderer residency is at most
100 rows/400 KiB, preserving selection and reading anchors. Add no log actions, exports, full prompt
bodies or credentials.

Native permission/question/OAuth interactions retain first priority, followed by still-valid
collaboration decisions and recovery, then a freshly host-validated Relay request. Relay answers
never become ordinary Send, Agent answers or native consent. Keep message drafts, images, Comments,
Skills and queued input intact. Cancel abandons only that advancement and preserves the workflow's
user pause; it does not stop or replay native work. Disable/configuration changes discard unused
auxiliary intent and recompute the legal default. Restart discards old auxiliary cards and unused
grants while retaining committed work, pause, native recovery, budgets and history.

An ordinary Send may consult about its single recipient only when the Composer explicitly records
implicit routing and its frozen Comments reference both Agents or only an Agent other than Primary.
Explicit Primary or Agent choices, commands, Skills, images, `@all`, returned input, queued input and
workflow replies retain their existing routes. The existing Send owner freezes the complete body,
Comment membership and anchors before asking for advice, under the same 16 MiB auxiliary reservation
and absolute 15-second deadline. No placeholder Message or Run is created. One real Run transaction
binds the recipient and consumes only the original Comment set; Primary settings and later drafts
remain unchanged. Advice failure or expiry uses the frozen default recipient. New queued input
invalidates old advice while retaining its original queue path. Stop and preparation failure leave a
terminal unsent receipt, unlock its Comments and refresh their projection. The same nonce cannot
restart a cancelled preparation. Cold startup never sends it automatically; ordinary Composer body
and image restart behavior remains unchanged.

The 15-second auxiliary deadline includes input freezing, complete source loading, native preflight
and output validation, without renewal. It is followed by the original 10-second business preparation
window. Send's outer RPC allows 27 seconds, or 37 seconds when it first resolves an existing sealed
body through the bounded 10-second body reader. These outer deadlines do not extend native execution
or other readiness and Steer limits. A logically finished consultation retains its physical
reservation until its owned processes, readers and cleanup operations have actually joined; default
business work uses its existing independent capacity.

Consultation requires all relevant complete frozen inputs, Comments, anchors and exact source
contents, including the complete target of every message anchor. Workflow material also includes the
original task and applicable Plan, reviews, owner responses and review scope. It never substitutes a
fresh worktree read or a generated summary for missing facts. More than 12 sources, complete input
over 128 KiB, required images or unavailable material skip the entire consultation. A processing
budget never truncates the original business input or its sources.

A recommendation selects a supplied legal candidate or null and may include up to eight grounded
highlights. Complete highlight JSON is at most 8 KiB and an adopted guidance proposal at most 16 KiB.
Workflow guidance uses `handoff-guidance-v2`, with historical `plan-revision-guidance-v1` still readable.
The receiving Run transaction rechecks its evaluation receipt, complete source fingerprint, input
hash, configuration generation, scope and deadline before sealing adopted focus as evidence. It
never becomes permission or a substitute for the original sources. Ordinary recipient selection
retains only its scalar adoption receipt. Unadopted advice bodies are not durable; historical grants
cannot authorize a new execution.

Settings shows global enable intent, exact model selection and the indicator preference independently
of Session model and permission choices. State reads are side-effect free. Explicit Refresh checks
native compatibility without a model request, separately for the host and the current Project.
Observations expire after 60 seconds and never replace admission checks. Native catalogs identify
GPT-6 Luna through Codex or exact Haiku 5.5 through Claude Code; aliases and unavailable models do not
cause substitution. Configuration changes invalidate in-flight discovery and advice. Indicators
reflect actual evaluation or cleanup ownership, not merely an enabled preference.

Codex decision execution admits exact GPT-6 Luna only with Codex 0.163.0. Claude decision execution
admits exact Haiku 5.5 on macOS through verified native authentication, configuration, isolation and
protocol capabilities. This acceptance was executed with Claude Code 2.1.272; other Claude versions
have not been certified by these checks. The native runtime retains its login
owner and global instructions, uses an ephemeral context outside the Project, and never resumes
development history. Its operating-system sandbox denies child processes, execution outside the
selected native binary, writes outside owned temporary storage and network access outside the owned
response guard. Hooks and MCP startup therefore cannot execute processes or contact services.
Claude keeps its ordinary global configuration; it does not use a bare replacement home.

On macOS, the bounded guard binds the native destination, exact model and request. It permits only the required
native metadata route during admission, then the single bound inference request. It rejects tools
before forwarding and withholds all model output until the complete response is verified. Complete
inherited input remains within 128 KiB and the native transport envelope within 256 KiB. Observable
usage is retained even for rejected output. Authentication requiring native credential refresh fails
closed instead of modifying the original authentication files or replaying inference.

The Codex version boundary is deliberate because its identifier behavior is version-specific.
Codex requires its existing valid, singly linked installation identifier with native mode 0644. The
native binary opens that one file for data writing even when its contents are valid. The sandbox
permits file-write-data on that exact existing file, while denying creation, replacement, metadata
changes and other home writes. The pinned CLI's validated-existing-state path performs no write.
A retained file descriptor verifies identity and content through physical
completion; Pact never creates or repairs this identifier. This is a narrow trusted-native exception,
not an operating-system guarantee that every native-home file is read-only.

Windows Claude Relay uses a trusted native CLI in one fresh, tool-disabled context outside the
Project, retaining the original native login. It uses fixed Relay instructions and the complete
Pact-supplied business context, disables built-in tools, MCP, Hooks, Skills, plugins and other
development customizations, and never resumes development history. Native organization policy remains
trusted; if it prevents effective disablement, Relay refuses inference. Startup configuration runs
under normal native permissions. Effective credential helpers remain unavailable even with cached
account identity. This mode was checked with Claude Code 2.1.309.

Windows trusts the installed CLI and its native authentication behavior. The CLI may maintain its
normal authentication, cache and client state. Pact does not provide OS-level filesystem, ACL or
network isolation for this process and does not insert the macOS response guard. Model output is
untrusted: require the exact selected model, one normally completed bound turn, no tool-use blocks,
matching assistant/result text and a valid admitted recommendation before adoption. The existing
Windows Job owner provides cancellation, physical exit and durable receipt proof. One 15-second,
16-MiB invocation reservation, bounded input/output and host freshness/authorization checks remain.
Refresh performs no inference. Codex decision execution remains unavailable on Windows. Platform,
packaged and real-provider acceptance remain separate requirements.

Evaluation rows record only invocation/outcome/usage and bounded physical identity metadata below
4 KiB, never complete inputs or unadopted suggestion bodies. Adopted guidance is separately sealed
with its receiving Run and remains available in history and Fork. Fork remaps standard references
while retaining historical evaluated hashes; historical guidance creates no new dispatch authority.
Restart preserves committed guidance, discards uncommitted proposals and never replays advice.
Logical timeout/cancellation does not release physical
reservations or refund possible delivery. Restart performs no replay: unknown owners remain held
until the old Utility, recorded native identities and private process group are proven absent.
Global enable/model changes permanently invalidate the old invocation, including value changes
back to the original selection; indicator-only changes remain independent.

The Relay heading and core-function subtitle remain visible. Off reduces configuration to the
Enable Relay row; On reveals Model, usage terms, indicator preference and read-only Activity.
Closing retains the saved model and indicator choice. Catalog discovery and activity reads run
only while the expanded surface is visible. Relay's workspace background remains opaque in
translucent windows so background text cannot interfere with its controls and reading area.

Scheduling activity is a read-only SQLite projection of actual auxiliary evaluation records, showing
recent and unresolved facts with the recorded provider/model. Normal default handoffs are excluded.
Results describe decision requests, not business completion; suggestions remain separate. Scrolling
loads older/newer pages with bounded residency and preserves the reading anchor. Hiding Settings
releases its subscription and display state; pending physical reads settle before a latest intent.
The activity region has no filters, details, navigation, copy, export, retry or clearing controls.

Ordinary Send immediately pauses future automatic work, cancels any undispatched handoff, and queues a priority reply after the current native root, output and effects settle. The current root normally finishes; Stop separately requests its interruption. Plan feedback defaults to the plan owner, Build feedback to the implementer, and direct Review feedback to its reviewer; an explicit Agent route remains explicit. Workflow feedback is next-turn input and cannot use native Steer.

When a completed review or planning reply needs a user decision, its card replaces the message input, with explicit unselected choices and free-answer fields. Send answers uses the existing Send owner but sends only the card answers: no hidden message text, images, Comments, Skills, routes or return receipts. Keep those ordinary drafts intact. Partial answers and clarification requests remain valid answers. Reject unreferenced new messages and new Pact commands while an unresolved decision exists, including after asynchronous preparation; previously accepted receipts and authorized workflow dispatch retain their original handling. Bind answers to the current task, decision Run and decision/current input sequences before freezing input. Route a decision reply to the verified Agent that asked it, independent of the current Primary or plan owner. Reviewer replies remain read-only and settle through their input result; only owner replies can publish or retain the plan. Show the frozen recipient as an @mention and separate each question and answer in the sent message. Stale references fail without clearing drafts; identical durable receipts remain idempotent. Historical requests without question data show an expandable original-request entry and an in-card free-answer field without inferred choices. Processing keeps ordinary input unavailable. Incomplete replies retain recovery; only a confirmed ended or never-dispatched prior Run may accept an explicit bound follow-up answer. Unknown execution never permits a blind resend. InputReplacement provides the shared input location, focus handoff and reduced-motion-aware transition, with two mounted panels, one observer, one animation and one 220ms exit timer. Successful Send immediately removes editable questions; rejected Send preserves them. While awaiting the result, show answer progress with existing Stop, queue and recovery controls in the same input location. The next completed reply may ask for a new decision or confirm processing and offer Continue. Receipt, queueing and native completion alone do not resolve the backend decision gate. Until the latest reply is positively settled, Continue and automatic review are unavailable through both UI and dispatch interfaces. Cancellation, failure, missing or conflicting evidence, newer input and restart preserve that gate. After the reply is confirmed processed, remain paused and show Continue collaboration with the computed next step. Clicking it rechecks current inputs, plan/code sources, review, unfinished authorized work, limits and runtime admission; it does not replay a saved prompt or authorize Implement/Repair. A plan change requires current-version review; new code requires corresponding review. Answering a native form continues the existing root but leaves an independent automation pause intact.

Stop, failure and restart preserve work and pause automation. Unknown execution first reconciles its original Run; neither Continue nor restart starts a duplicate root or resets counts. An application restart never automatically resumes the peer chain.

### Native artifacts and settlement

Plans and reports are complete natural documents. A small host-authenticated `submit_review` tool supplies accepted, changes_requested, needs_user or incomplete; needs_user includes explicit questions and other verdicts omit them; Pact binds actor, root, input sequence and exact source basis. Conflicting result or question submissions cannot become acceptance. Questions are limited to three per request, with two to six options when supplied; prompts are at most 2048 characters, labels 160 and option descriptions 512, with at most 8 KiB of UTF-8 JSON for the complete question set. Individual card answer fields accept up to 4096 UTF-16 units. Questions and answers remain inside the existing view and draft residency budgets. Planners may use `submit_input_result` only for needs_user questions; processed planning input still requires an authenticated native plan settlement. Live native forms retain their original operation lifecycle. The model copies no identities, hashes, per-member acknowledgements or result envelope.

Persist observed native plan/verdict candidates immediately. Promote them only after exact successful root completion, complete source sealing, current task authorization and native-effects settlement. Unique Run admission and source checks make duplicate events/readback idempotent. Stale callbacks remain historical and cannot advance a new input or version. Cold readback uses the same artifact verification, including authenticated ancestor bindings and complete preimages for continued native Sessions. Restore saved plan checks the original successful root and publishes its missing initial or revised version through the normal version transition, preserving earlier versions, review bases, counters and paused automation. Source recovery is separate from Continue; a missing revision shows recovery status and an explicit restore action before business next steps. An actual native plan may have an empty ordinary answer; preserve that canonical source without inventing prose.

A missing or unconfirmed native plan is not a new user question. Create a decision only from an explicit needs-user result or an unanswered native request. Preserve existing answer receipts and unresolved input gates when plan settlement fails. When saved-plan recovery is available, show recovery ahead of the old question form; do not infer that a missing plan proves a recoverable source exists.

Recovery reads original native/source facts and saved authenticated candidates. An unknown cold tool namespace or missing verdict is incomplete, not inferred acceptance. There is no separate formatting-only submission Turn: missing evidence requires a genuine explicitly resumed review or planning action. Preserve complete original bytes and visible failure details rather than automatically generating a summary or repairing a protocol carrier.

Plan/report text has no cumulative product gate. Stored parts, source tools, Markdown pages, parsers and complete-history operations retain their own documented bounds. Dense Markdown can expose complete plain source with correct anchors instead of truncating content.

## Native permissions and questions/forms

Each Session/Agent offers Native settings, Ask for approval, Auto and Full access. Ordinary Native execution omits permission overrides instead of guessing rules. Workflow stages apply their required native Plan/read-only policy and retire stale Plan mode while preserving applicable execution permissions. Auto uses the installed native mechanism, not Pact approval algorithm/model-name list. Claude's actual Query initializes/ACKs Auto before input; explicit mode rejection may prove unsent without a fabricated Turn or discarded healthy binding. Transport failure is not unsupported-model proof.

Full access explicitly confirms broad file/network scope in the selected Agent's menu, replacing rather than stacking the mode list. It affects that Pact Session/Agent and never edits project/global native rules. Restart/Rebuild does not repeat confirmation; leave/re-enter does. Ordinary new Sessions do not silently inherit consent; confirmed Fork is an exception. Changes affect next tasks, never answer active cards/replay tools. Recovery uses current choice, not revoked Full access.

Full access produces no tool-approval cards. Native bypass/never executes permitted operations; a residual native request for extra tool permission is explicitly refused without asking the user or widening task authority. Native questions/forms and Implement plan remain separate user decisions. Planning and review retain their project read-only restrictions. Existing permission-menu help distinguishes the next-task selection from the active Run's frozen choice and task restrictions; it does not claim an unobserved native mode.

Pact's frozen-source reader and title-candidate validator declare their actual read-only MCP behavior as well as exact tool allow rules. Native planning evaluates these annotations before its allow list. Source execution still verifies the current root, grant, owner and supplied references; metadata never grants arbitrary MCP or filesystem access.

Show approvals only when requested natively, with exact supported once/session-scope/refuse/cancel actions. No persistent command/network amendment or across-session saved rules. Claude session-allow exists only if all suggestions target the current native Session; do not split/widen mixed suggestions. Preserve native user rules. Record sanitized evidence before returning decision; expired/stopped/restarted/generation-mismatched requests never replay.

Questions/MCP forms require actual user answers/submission; Allow cannot answer them. OAuth/URL opens only on user click, proving opening intent rather than authentication success. Native connection establishes completion. URLs/fields/answers remain transient; passwords/tokens/credentials are excluded from durable logs/snapshots. Timeout/transport withdrawal is not user denial. Initialization interactions work even before a model Turn.

## Native recovery, Rebuild and input return

### Evidence and input gates

Bind evidence to Session/Agent/request/Run/native ID/generation/actual executor. Silence, timeout, observer release, another executor's notLoaded/history existence/old Completed label do not prove termination. Preserve original complete/partial body and distinguish auth/quota/protocol/permission/context/resource/unknown delivery. Do not fabricate answer text. A normally completed native Plan may retain an empty canonical answer source while the saved plan artifact supplies its visible content.

One recovery card lists affected Agents with concise title/reason and valid Retry/Rebuild actions. An exact original binding can also offer Check session beside Rebuild when no replacement candidate is pending. It reads saved status/output without creating or resuming a task. Known ending with incomplete body is result-reading, not rebuild of a healthy binding. Unknown errors retain sanitized concrete reason instead of inferred missing/stopped.

Tool/thinking frames without text do not consume answer identities. Output processing failure retains incomplete saved text and does not stop exact native terminal/Steer observation or imply whole-task success. Failed output cannot establish collaboration acceptance. Recovery can restore readable partial text while Run, Steer and effects remain unconfirmed; it never resends that input automatically.

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

Both native sides must be ready for Send/Comment mutation/Agent actions. Copy boundary task, Batch, Comment, plan, review and workflow-Turn source references using one ID map; beyond-boundary dependencies remain unavailable and later decisions cannot appear at an earlier cut. Inherited reviews are historical, not new dispatch/edit authority. Work Log/Changes/Diff remain read-only; old Undo/Ask/approval/form/pending input is inert. Branch content/images survive source archive/removal.

For committed incomplete Fork, Retry checks source/cut/candidate/lineage/settings/readiness without mutation, reuses healthy side, and never substitutes query/resume/fork for inspection. A verified candidate needing initialization/permission ACK gets explicit continue-initialization only. Proven undispatched or candidate-absent with valid source permits explicit continuation of the same operation/Session. Timeout/auth/paging gap/unknown identity is not absence. No blind recreation/auto-cleanup/Rebuild fallback. Real initialization questions/OAuth/approval remain user-owned.

Startup starts no new model/duplicate fork. Uncommitted means invisible and no native dispatch; committed means readable/gated until verified. Operation/Agent/source/target/settings/generation fencing and nonce idempotence prevent duplicate publication/stale unlock/clearing the other side. Catalog error uses current readiness, not inherited failures. Current Fork count/byte/witness budgets remain in Performance; unlimited branching is deferred.

## Content and file navigation

Ordinary messages use safe GFM headings/lists/quotes/tables/links/code without raw HTML; streaming may be incomplete, final is stable. Above 128 KiB use bounded plain preview with preserved breaks and concise performance reason. Original remains complete but this Transcript view has no full Copy/expansion/new text Comment. Existing Comment quotes remain readable; preview does not mean changed source. Complete paged collaboration documents have separate rendering/anchors.

Local links read only on click. Relative path stays inside real Project root with symlink checks; explicit local absolute path may preview an outside file/Skill. Outside preview grants no file Comment/Changes/Undo authority. Renderer has no `file://`, generic filesystem or arbitrary system-open API. Reject missing/nonregular/binary/undecodable/oversized targets visibly. File/serialized preview is bounded to 1 MiB, not an arbitrary large-file reader.

`#L42`/`#L42-L58` locate/highlight; absent anchor opens top. Context shows resolved path/lines/text. Lazy readonly Monaco handles recognized code/structured language with theme; unknown/load failure falls back to readable wrapping plain text with same anchor semantics. Heavy editor stays out of initial bundle.

HTTP(S) labels remain blue/underlined/keyboard-active with destination tooltip/textless ExternalLink icon. Trusted Main opens credential-free validated destination in system browser, denying Electron popup/navigation; decoration adds no quote offsets. Reject other schemes/credential-bearing links. Bounded failure reports destination-free error without replay; OAuth retains separate interaction lifecycle.

Bound DOM/caches while preserving selection, keyboard/screen-reader access, Comments and reverse navigation. Keystrokes cannot reparse completed history. Delayed above-viewport height changes preserve reading anchor; manual detail pauses tail-following; Home explicitly returns beginning. Late read/error cannot change another source or reacquire retired ownership.

## App version checks

About & updates always shows the running App version, including offline or when local settings
cannot be loaded. Only packaged official Production CI Stable checks for updates; Dev and local
Production show their version and the official GitHub download link without update requests.

GitHub Releases in `mbaxszy7/Pact` are the sole remote source. Read its Latest formal Release;
reject drafts, prereleases, malformed versions/dates and mismatched official release links. Compare
strict numeric `major.minor.patch` versions and prompt only for a higher version. Show the latest
version, publication date and a link to that exact GitHub Release in the system browser. Pact does
not download assets, install, restart, or change task/draft/exit behavior for this feature.

Automatic checks default on and can be disabled independently of manual checks. Check about 30 s
after startup and every six hours while resident, including the tray; resume checks only when due.
Concurrent checks share one operation. Disabling automatic checks affects future scheduling, not
an in-flight check. Respect GitHub rate-limit backoff for automatic and manual requests alike.
Failures retain the last successful result/time and never claim the App is current. Background
failures remain quiet; the page provides checking, unavailable, last-known and retry states.

Settings keeps a New marker while a higher version is available. A durable per-version receipt
allows at most one proactive light notice, including Latest returning to a previously seen version.
Present only in a visible trusted workspace after Conversation can confirm app-wide inactivity;
active/preparing/recovering/background work and unavailable state defer it. Do not poll, steal
focus, send system notifications or replace an existing notice. The receipt controls the notice,
not the persistent update entry. Native Check for Updates opens the same page, including first use.
Use restrained copy: version facts and controls are primary, with errors/details only as needed.

## Appearance, accessibility and diagnostics

App-global persisted appearance includes independent System/Light/Dark theme, System/Solid/Translucent material and stored `materialOpacity` 70–100/default 85. Visible Transparency strength 0/50/100 maps to 100/85/70, not whole-window opacity. Semantic surfaces have distinct alpha; text/icons/code/focus remain opaque.

Live preview/reset respects revisions. Save failure restores durable value; uncertain delivery blocks writes until readback. System events cannot reconcile unknown write or overwrite newer revision. macOS uses transparent backing without Vibrancy. Windows resolves the saved material before creating its first workspace: Solid uses a genuinely opaque window with native frame styles, while Translucent retains frameless transparent backing; both retain native caption buttons and disable system backdrop material rather than using Mica. Automatic resolves through the existing capability/accessibility policy. Unsupported build/system, reduced transparency, high contrast/forced colors or observable init error falls back to complete Solid, retaining request/reason. API success/CSS alpha is not compositor evidence.

Windows background-mode changes save immediately but take effect on the next complete application
start. The current background remains active and Appearance identifies a pending restart; returning
to the startup choice clears that notice. Closing to the tray is not a restart. Pact does not restart
itself or recreate the workspace when this preference changes, preserving current work and drafts.
Theme and transparency-strength adjustments remain live, and accessibility can immediately paint a
transparent-backed workspace Solid. An opaque window stays Solid until restart if system policy
later permits translucency. Startup waits for the local runtime and a successful saved-settings read
before constructing the workspace. A failed read offers Retry or Exit instead of fixing the process
to a default background; neither action overwrites saved preferences.
The pending-restart projection is transient; persisted settings and their revision remain authoritative.

Use calm dense controls, progressive disclosure and non-color identity/state cues. Target WCAG 2.2 AA, keyboard/focus/scalable text/screen-reader/reduced-motion/light-dark semantics. Code/Diff/permissions stay nearly opaque. Titlebar interaction is no-drag with native safe areas and dragging/resizing elsewhere. Exact visual rules live in Design.

Diagnostics is bounded local metadata JSONL separate for development/production, not Journal/full audit. Default/temporary Debug excludes body/image/source/Diff/command args/raw streams/URLs/credentials/full environment. Explicit Debug ends in 30 minutes or restart. One failure notice cannot block business/streaming; Performance owns quotas/retention/exit. Native rejection is not labeled process crash without exit evidence.

## Planned scope and open decisions

These retained requirements do not imply current implementation or approval.

### Capacity and delivery

Daily large text can be edited/sealed/sent/saved/explicitly returned beyond old 100,000-character and shared 1 MiB logical-frame limits. Native/provider/resource limits still apply; no arbitrary-size promise. Complete internal reads differ from Transcript preview. Aggregate Handoff/Rebuild and full Pact/native Fork still have safety/count/manifest gates. Expansion requires paged immutable manifests, complete mapping, atomic publication, proof compatibility, all-process memory and true initialization/readback evidence; a larger constant alone is insufficient.

Additional ordinary-conversation automatic timing policies, model-generated Summary and unrequested extra Turns remain planned and require explicit trigger/target/cost/cancel/unknown-delivery/approval scope. Steering never authorizes interrupt-plus-replacement fallback or changing Model/Effort mid-Run.

### Further artifacts and capabilities

- Formal Requirements: background/goal/scenarios/scope/rules/interaction/constraints/acceptance/assumptions/questions/provenance/history; distinguish user decision, Agent inference, code evidence, agreement and unconfirmed proposal.
- Derived Summary: goal, confirmed requirements, decisions, open questions, progress, next step with source versions/navigation. Never overwrite Journal/user decision/approved Plan.
- Fuller Plan/amendment UI: objective/scope/assumptions/acceptance/tasks/dependencies/owners/files/verification/risks/questions; approval binds version and changed scope requires reapproval. Extend existing plan seam.
- Decision UI: disagreement/both positions/evidence/tradeoffs/impact/recommendation and choose/request evidence/assign/defer. Native questions and natural review reports do not require a separate automatic Gate engine.
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

Preserve originals/source/role/authorization, one-root idempotent dispatch, cancellation/honest unknown delivery, user-priority titles/settings, atomic Send/Batch/workflow settlement, zero-write Undo conflict preflight and non-destructive cleanup. Trace normal and failure/restart paths through Renderer/Main/Utility/persistence. Retain meaningful regression/resource obligations after old plans are removed.

Feature Modules stay independently reviewable; Planned scope does not authorize implementation. [CONTRIBUTING](../../CONTRIBUTING.md) defines delivery/visual-first/migrations/platform gates, Performance defines resource requirements, Testing distinguishes contract/deterministic/real-provider/package evidence. Report actual failures/skips/unknowns; build/simulated provider success is not real-model or native-visual acceptance.
