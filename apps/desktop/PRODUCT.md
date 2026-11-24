# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Electron renderer using React, TypeScript, Vite and Tailwind CSS. The product runs on macOS and Windows, retaining native window controls, menus, keyboard conventions and filesystem behavior. `web` describes the browser-only Renderer surface; this is not a hosted web service.

## Users

Independent developers and small engineering teams who already use Claude Code, Codex and Antigravity (`agy`) and want to coordinate an active two-Agent pair per Session without copying conversation between terminals.

## Product Purpose

Pact is a shared dual-agent coding workspace across three built-in native CLIs (`Claude Code`, `Codex`, `Antigravity`). Each Session runs a distinct two-Agent `(Primary, Secondary)` pair, making the current task, receiving Agent, original history, permission interactions, recorded changes, review findings and recovery options understandable without reconstructing them from raw terminal output.

## Positioning

The user controls routing, writing authorization and continuation. Ordinary messages stay lightweight; explicit `/plan`, `/build` and `/review` use native planning, complete natural reports and bounded automatic handoffs between frozen planning, implementation and independent review roles. Default orchestration is deterministic. Optional Relay uses OpenAI's Decisions API to select among host-admitted scheduling choices, with a locally encrypted API key; Pact retains execution, source, authorization and recovery ownership.

Forward execution preserves native tools and user permissions. Recorded Changes support guarded whole-round Undo where evidence is reliable. Pact does not provide a hard filesystem Writer Lease against external editors/native tools or full Session/workspace Checkpoints.

## Operating Context

- A resizable desktop workspace with Project/Session navigation, shared Transcript/Composer and a contextual right pane.
- The contextual pane presents the sole current Plan, files, historical Changes, Session settings, and parent-scoped Side chats. It can be closed/reopened without making a second full plan in Chat.
- Main Sessions support **Ask in side chat** from message selections and `/btw` Composer draft handoffs (`pact:btw` chip, seeding remaining text, `@claude`/`@codex`/`@agy` route and native `/skill` tokens into the new side chat without auto-sending), plus a continuous virtualized **Side chats** list (84px rows) in the contextual pane. Side chats lock their inherited two-Agent settings snapshot, hide settings/permission/speed/project controls, forbid `/plan`, `/build`, `/review`, `/btw`, and **Fork**, place `@Main` (**Send to main**) below the side chat's active member mentions and `@all` for sync-back tagged **From side chat**, and return from pushed File/Changes/Skill previews via **‹ Back to side chat**.
- The Composer combines text, route, native Skill selections, static images and persistent Comment drafts in one Send. Native question answers use their live forms.
- **Implement plan**, **Review plan**, **Review code**, **Update plan**, **Fix issues**, and **Retry** explicitly authorize their displayed transition. Only Phase 1 `/plan` <-> `plan_review` advances automatically; Open Mode (`Implement plan`, `/build`, `/review`) always waits for an explicit user action. Native completion, independent review acceptance and dispatch readiness remain separate facts.
- Preserve deliberate reading position, selection and focus while streaming, expanding details, paging, navigating Comments or loading historical sources.
- Native approvals, questions, MCP forms and OAuth keep their own actual lifecycle. Recovery retains readable history and existing drafts.

## Capabilities and Constraints

- Projects, history, managed images and diagnostics are local. Native Agents/tools can communicate with the services configured by the user; local-first does not imply offline execution.
- Claude Code, Codex and Antigravity (`agy >= 1.5.9`, routed explicitly via `@agy` with no `@gemini` alias) are the three built-in Agents, each keeping independent native configuration, credentials, Skills, MCP, Plugins and context. Any two Ready CLIs unlock first-use Runtime Preparation (`2 of 3 ready · Minimum 2 required`), pre-selecting the two Ready CLIs when the third is unavailable and offering all six `(Primary, Secondary)` permutations when all three are Ready. Daily workspace readiness and upgrade warnings evaluate only the viewed main Session's active pair (or viewed side chat's locked pair) plus unsettled historical bindings, never blocking on an unselected third CLI.
- Main Sessions allow swapping `Primary <-> Secondary` anytime and allow replacing an active member with the third Agent at a clean idle boundary (no running/recovering Run, queued message, active collaboration task, or unsettled background/interaction state for the retiring Agent), resetting the retiring Agent's `Full access` to `Ask` without mutating existing locked side chats. Provider usage tracks all three CLIs (`5h`/`7d` `% left` plus pool scope notes such as `Gemini Models quota`) within at most two concurrent probes App-wide.
- Pact tasks default to Primary for planning and code review, Secondary for plan review and implementation/repair within the Session's active two-Agent pair. An entry command's explicit `@Agent` selects that entry stage from the active pair; inactive-Agent mentions, conflicting recipients and `@all` refuse dispatch. Relay may select independent role pairs only within the frozen two-Agent pair for an implicit entry.
- After Phase 1 Plan acceptance and before code authorization, **Swap implementer** works with Relay off; Relay may also suggest that swap (and direct swap supersedes an unused suggestion). Confirmation changes future code roles only; **Implement plan** still requires approval. Historical authors, permissions and consumed allowances remain unchanged.
- `/build` and `/review` enter Open Mode without automatic code-review or repair chaining. In Open Mode, **Review code**, **Review plan**, **Fix issues**, **Update plan**, and **Retry** require explicit clicks, while `/review` over an unfinished Open Mode `/plan` or `/build` task triggers an in-task code review without replacing the task. Implicit Composer messages during an active Open Mode task may consult Relay routing or default to the latest code author. Session settings count each plan review, each code review and each repair separately.
- Sending workflow feedback blocks later handoffs and prioritizes a reply after current native work settles. Once the latest reply and plan are confirmed complete, authorized planning and review continue automatically. Stop, failure, restart, exhausted limits and historical pauses still require explicit continuation; replying or answering a native form does not clear those pauses or authorize new implementation/repair.
- A new Pact command on an unfinished task requires an explicit replacement confirmation at Send; queueing alone does not end the old task, and editing or removing the queued command discards that confirmation. Replacement is terminal for the old task, keeps its plans/reports/history readable, and does not cancel running native work or clear recovery barriers.
- `@all` runs Primary then Secondary, excluding the current Primary answer from Secondary's input; the boundary does not isolate shared Project files.
- Default Session settings are mandatory during onboarding and copied into each new Session. Runs freeze their own settings and permission revision.
- The Renderer is browser-only and uses the typed DesktopBridge. It cannot import native/filesystem/persistence/runtime APIs.
- Recovery retains manual inspection and user-confirmed Rebuild. Optional Relay adds bounded readback and one independently recorded replacement only with exact positive-unsent evidence; unknown delivery never causes blind replay. Fork uses both providers' genuine native boundary histories.
- Composer supports one complete queued input per Session and explicit native Steer where the current CLI supports its lifecycle; complete recovery and unknown-delivery facts remain authoritative. Steer preserves full output snapshots in one Run, collapses Work Log in the final answer on completion and collapses earlier responses after normal settled completion without changing Comment sources or canonical native history. Full audit export, unlimited history, complete capability management and automatic Checkpoints remain future scopes.
- Agent provenance, workflow state, Diff meaning, warnings and consequential actions never depend on color alone.
- Relay performs scheduling, not task implementation or ordinary Agent questioning. All admitted Relay decisions replace the current Composer through the shared InputReplacement after higher-priority native/workflow interactions, preserving the draft; optional suggestions carry direct Skip/confirm actions, and Skip restores the default workflow while keeping the existing automation or pause. A Rebuild decision replaces only its exact duplicate recovery notice. Repair advice needs a concrete writing grant plus applicable extra and original business allowances. The current-Session indicator and Relay card share the moving pastel border; native cards retain their appearance. Visual and complete runtime acceptance remain separate obligations.
- A pure question at a settled task checkpoint uses ordinary Send: the replying Agent may classify it as a proven read-only explanation, leaving the task checkpoint, Plan, review and counts unchanged, and Pact restores that checkpoint only after the reply completes. Choose repairer offers the other Agent for a scoped Repair with a Pact confirmation. Both work with Relay off.
- Revise plan opens a confirmation on a settled `/plan` result, then re-runs the fixed planner and reviewer; a fresh Implement approval is required even when the Plan text is unchanged. Keep current plan dismisses only the exact recorded revision request without starting work; the task stays paused on its original scope.
- macOS and Windows share functional requirements; each platform's actual native effects and release verification must be established separately.

- Accessibility & Inclusion work covers keyboard-only operation, reduced motion, contrast and live Light/Dark/Translucent themes cleanly.
- Integrated Project terminals (`Ctrl+\`` or the header toggle) run real native shells inside the Project's directory without disturbing Agent Sessions, blocking Project Archive until open terminals are closed, confirming before stopping active commands on tab close, and terminating gracefully during App Quit without blocking exit with a confirmation dialog.

## Brand Commitments

- Name: Pact.
- Voice: calm, direct, precise and operational.
- Quiet desktop controls, readable message provenance and progressive disclosure.
- Explain the current action and consequence without repeated alarm copy or internal protocol details.

## Evidence on Hand

- [Product specification](../../docs/product/requirements.md) is the behavior source, including the current/future distinction.
- [Architecture](../../docs/technical-foundation.md) defines accepted process, state and interface ownership.
- [Architecture resource requirements](../../docs/technical-foundation.md#performance-and-resource-requirements) owns resource bounds; [Contributing](../../CONTRIBUTING.md#testing) states verification methods and limitations.
- [Design](DESIGN.md) and its four main-workspace reference images define visual hierarchy. Sample content in those images is illustrative, not a current product fixture or production screenshot.
- The Renderer contains actual Project/Session conversation, collaboration and recovery UI. Do not call it a foundation-only health screen.
- Do not invent customer claims, usage benchmarks, testimonials, release maturity or unverified platform effects.

## Product Principles

- Make receiving Agent, authority, current state and next available action visible.
- Retain original sources and user decisions rather than relying on transcript summaries.
- A settled answer is not automatically an accepted plan, handled later input or verified code change.
- Implementation and review reports state confirmed checks with their evidence and label unknown results Unverified in the user's language. Author-reported results remain distinct from independent checks; existing reports carry these limits without a separate execution-proof system.
- Keep native capabilities and credentials inside their provider boundaries.
- Preserve drafts, recoverable facts and unknown outcomes through failure/restart; never fabricate success to simplify a screen.
- Bound UI work and disclose more progressively without silently hiding required opinions or user input.

## Accessibility & Inclusion

Target WCAG 2.2 AA for Renderer surfaces: keyboard-only operation, visible focus, reduced motion, scalable text, screen-reader semantics, non-color state cues and equivalent light/dark behavior. Transparent surfaces remain optional; text, icons, code and focus stay opaque and the Solid theme remains complete.
