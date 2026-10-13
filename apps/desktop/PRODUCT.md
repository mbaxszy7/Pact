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

The user controls routing and subsequent Agent work. Ordinary messages stay lightweight; explicit `/plan`, `/build` and `/review` share a versioned plan, Todo ledger and click-authorized workflow. Pact's orchestration is deterministic, not a third model.

Forward execution preserves native tools and user permissions. Recorded Changes support guarded whole-round Undo where evidence is reliable. Pact does not provide a hard filesystem Writer Lease against external editors/native tools or full Session/workspace Checkpoints.

## Operating Context

- A resizable desktop workspace with Project/Session navigation, shared Transcript/Composer and a contextual right pane.
- The contextual pane presents the sole current Plan, shared Todos, files, historical Changes and Session settings. It can be closed/reopened without making a second full plan in Chat.
- The Composer combines text, route, native Skill selections, static images and persistent Comment/answer drafts in one Send.
- Every Proposal authorizes one target root Turn when clicked. A native result, review acceptance and temporary dispatch readiness are separate facts.
- Preserve deliberate reading position, selection and focus while streaming, expanding details, paging, navigating Comments or loading historical sources.
- Native approvals, questions, MCP forms and OAuth keep their own actual lifecycle. Recovery retains readable history and existing drafts.

## Capabilities and Constraints

- Projects, history, managed images and diagnostics are local. Native Agents/tools can communicate with the services configured by the user; local-first does not imply offline execution.
- Claude Code and Codex are the only built-in Agents, with independent native configuration, credentials, Skills, MCP, Plugins and context.
- Primary/Secondary provide defaults; explicit user task routing can choose either Agent without a permanent role change.
- `@all` runs Primary then Secondary, excluding the current Primary answer from Secondary's input; the boundary does not isolate shared Project files.
- Default Session settings are mandatory during onboarding and copied into each new Session. Runs freeze their own settings and permission revision.
- The Renderer is browser-only and uses the typed DesktopBridge. It cannot import native/filesystem/persistence/runtime APIs.
- Current recovery is explicit inspection or user-confirmed Rebuild; unknown delivery never causes blind replay. Fork uses both providers' genuine native boundary histories.
- Native steering, full audit export, unlimited history, complete capability management and automatic Checkpoints remain future scopes, not design claims about available UI.
- Agent provenance, workflow state, Diff meaning, warnings and consequential actions never depend on color alone.
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
- A settled answer is not automatically an accepted plan, resolved input or verified code change.
- Keep native capabilities and credentials inside their provider boundaries.
- Preserve drafts, recoverable facts and unknown outcomes through failure/restart; never fabricate success to simplify a screen.
- Bound UI work and disclose more progressively without silently hiding required opinions or user input.

## Accessibility & Inclusion

Target WCAG 2.2 AA for Renderer surfaces: keyboard-only operation, visible focus, reduced motion, scalable text, screen-reader semantics, non-color state cues and equivalent light/dark behavior. Transparent surfaces remain optional; text, icons, code and focus stay opaque and the Solid theme remains complete.
