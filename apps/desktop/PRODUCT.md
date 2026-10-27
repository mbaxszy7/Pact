# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Electron renderer using React, TypeScript, Vite and Tailwind CSS. The product runs on macOS and Windows, retaining native window controls, menus, keyboard conventions and filesystem behavior. `web` describes the browser-only Renderer surface; this is not a hosted web service.

## Users

Independent developers and small engineering teams who already use Claude Code and Codex and want to coordinate them without copying conversation between terminals.

## Product Purpose

Pact is a shared dual-agent coding workspace. It makes the current task, receiving Agent, original history, permission interactions, recorded changes, review findings and recovery options understandable without reconstructing them from raw terminal output.

## Positioning

The user controls routing, writing authorization and continuation. Ordinary messages stay lightweight; explicit `/plan`, `/build` and `/review` use native planning, complete natural reports and bounded automatic handoffs between a fixed owner and independent reviewer. Default orchestration is deterministic. Optional Relay uses a separately selected model for scheduling advice; Pact retains execution, source, authorization and recovery ownership.

Forward execution preserves native tools and user permissions. Recorded Changes support guarded whole-round Undo where evidence is reliable. Pact does not provide a hard filesystem Writer Lease against external editors/native tools or full Session/workspace Checkpoints.

## Operating Context

- A resizable desktop workspace with Project/Session navigation, shared Transcript/Composer and a contextual right pane.
- The contextual pane presents the sole current Plan, files, historical Changes and Session settings. It can be closed/reopened without making a second full plan in Chat.
- The Composer combines text, route, native Skill selections, static images and persistent Comment drafts in one Send. An optional reserved-detail declaration belongs to a new ordinary Send: the user supplies its question, choices and missing/supplied state; Relay may collect that exact field at an existing qualified node, otherwise the original Agent reads it. Unsupported input paths retain the draft and explain the refusal. Native question answers use their live forms.
- Implement plan and each new Repair explicitly authorize their displayed writing scope. Continue collaboration resumes the already authorized workflow after rechecking current facts. Native completion, independent review acceptance and dispatch readiness remain separate facts.
- Preserve deliberate reading position, selection and focus while streaming, expanding details, paging, navigating Comments or loading historical sources.
- Native approvals, questions, MCP forms and OAuth keep their own actual lifecycle. Recovery retains readable history and existing drafts.

## Capabilities and Constraints

- Projects, history, managed images and diagnostics are local. Native Agents/tools can communicate with the services configured by the user; local-first does not imply offline execution.
- Claude Code and Codex are the only built-in Agents, with independent native configuration, credentials, Skills, MCP, Plugins and context.
- Primary/Secondary provide defaults; explicit user task routing can choose either Agent without a permanent role change.
- A Plan owner maintains the native plan and is its default implementer; the other Agent reviews exact versions. Necessary questions may precede a plan. Accepted plans require an explicit Implement action.
- Build automatically proceeds to independent code review. Direct Review stays read-only; Respond and Repair are explicit and automatically return to the reviewer. Session settings count each plan review, each code review and each new repair separately.
- Sending workflow feedback immediately pauses later automatic work and prioritizes a reply after current native work settles. The reply stays paused until Continue collaboration; answering a native form resumes its root without clearing that pause. Restart also pauses the chain and reconciles unknown work before continuation.
- `@all` runs Primary then Secondary, excluding the current Primary answer from Secondary's input; the boundary does not isolate shared Project files.
- Default Session settings are mandatory during onboarding and copied into each new Session. Runs freeze their own settings and permission revision.
- The Renderer is browser-only and uses the typed DesktopBridge. It cannot import native/filesystem/persistence/runtime APIs.
- Recovery retains manual inspection and user-confirmed Rebuild. Optional Relay adds bounded readback and one independently recorded replacement only with exact positive-unsent evidence; unknown delivery never causes blind replay. Fork uses both providers' genuine native boundary histories.
- Composer supports one complete queued input per Session and explicit native Steer where the current CLI supports its lifecycle; complete recovery and unknown-delivery facts remain authoritative. Steer preserves full output snapshots in one Run, collapses Work Log in the final answer on completion and collapses earlier responses after normal settled completion without changing Comment sources or canonical native history. Full audit export, unlimited history, complete capability management and automatic Checkpoints remain future scopes.
- Agent provenance, workflow state, Diff meaning, warnings and consequential actions never depend on color alone.
- Relay performs scheduling, not task implementation or ordinary Agent questioning. Its necessary decisions replace the current Composer after higher-priority native/workflow interactions. A Rebuild decision replaces only its exact duplicate recovery notice. Repair advice needs a concrete writing grant plus applicable extra and original business allowances. The current-Session indicator and Relay card share the moving pastel border; native cards retain their appearance. Visual and complete runtime acceptance remain separate obligations.
- macOS and Windows share functional requirements; each platform's actual native effects and release verification must be established separately.

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
