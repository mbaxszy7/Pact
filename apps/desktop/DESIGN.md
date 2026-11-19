---
name: Pact Desktop
description: An airy daylight and midnight control room for governed dual-agent software work.
colors:
  canvas-light: '#ebf5ff'
  surface-light: '#fafdff'
  surface-raised-light: '#ffffff'
  ink-light: '#0a0d12'
  text-secondary-light: '#535862'
  canvas-dark: '#0f1720'
  surface-dark: '#141e28'
  surface-raised-dark: '#1d2a36'
  ink-dark: '#f2f7fb'
  text-secondary-dark: '#a9b7c4'
  action-light: '#181d27'
  action-dark: '#edf5fb'
  iris: '#0069e0'
  iris-dark: '#67b1ff'
  user-light: '#f1e6ff'
  claude-light: '#fff2eb'
  codex-light: '#d3f6e3'
  user-dark: '#2b2941'
  claude-dark: '#382923'
  codex-dark: '#19372f'
  diff-added-light: '#e5f8ed'
  diff-removed-light: '#fff0ee'
  diff-added-dark: '#17392b'
  diff-removed-dark: '#402421'
typography:
  display:
    fontFamily: 'Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif'
    fontSize: '45px'
    fontWeight: 500
    lineHeight: 1.07
    letterSpacing: '-0.03em'
  title:
    fontFamily: 'Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif'
    fontSize: '32px'
    fontWeight: 500
    lineHeight: 1.125
    letterSpacing: '-0.025em'
  body:
    fontFamily: 'Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif'
    fontSize: '14px'
    fontWeight: 400
    lineHeight: 1.43
    letterSpacing: '-0.01em'
  label:
    fontFamily: 'Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif'
    fontSize: '12px'
    fontWeight: 500
    lineHeight: 1.33
    letterSpacing: '-0.01em'
  code:
    fontFamily: 'JetBrains Mono Variable, SFMono-Regular, Consolas, monospace'
    fontSize: '13px'
    fontWeight: 400
    lineHeight: 1.54
    letterSpacing: 'normal'
rounded:
  control: '8px'
  message: '12px'
  panel: '14px'
  pill: '9999px'
spacing:
  compact: '6px'
  group: '12px'
  panel: '18px'
  section: '24px'
  spacious: '36px'
components:
  button-primary-light:
    backgroundColor: '{colors.action-light}'
    textColor: '{colors.surface-raised-light}'
    typography: '{typography.body}'
    rounded: '{rounded.control}'
    padding: '8px 18px'
    height: '36px'
  button-primary-dark:
    backgroundColor: '{colors.action-dark}'
    textColor: '{colors.ink-light}'
    typography: '{typography.body}'
    rounded: '{rounded.control}'
    padding: '8px 18px'
    height: '36px'
  message-user:
    backgroundColor: '{colors.user-light}'
    textColor: '{colors.ink-light}'
    rounded: '{rounded.message}'
    padding: '14px 16px'
  message-claude:
    backgroundColor: '{colors.claude-light}'
    textColor: '{colors.ink-light}'
    rounded: '{rounded.message}'
    padding: '14px 16px'
  message-codex:
    backgroundColor: '{colors.codex-light}'
    textColor: '{colors.ink-light}'
    rounded: '{rounded.message}'
    padding: '14px 16px'
---

# Design System: Pact Desktop

## Overview

**Creative North Star: "The Daylight Control Room"**

Pact pairs an airy sky-tinted workspace with a midnight companion theme. The interface remains operational and precise, while soft lavender, peach, mint, and cool glacier-blue message surfaces give User, Claude Code, Codex, and Antigravity (`agy`) distinct identities within each Session's active two-Agent pair without becoming noisy. Dense actions stay charcoal or pale inverse; Iris blue is rationed to focus, selection, and live state.

This is an Operate interface. Transcript, Diff, documents, permissions, and runtime activity must remain readable for hours. Translucency is optional material depth, not decoration: navigation may reveal more of the desktop environment, Chat reveals less, and code surfaces remain nearly opaque.

**Key Characteristics:**

- Pale sky canvas and bone-white work surfaces in light mode.
- Midnight-blue surfaces rather than generic black in dark mode.
- Lavender User messages on the right; peach Claude Code, mint Codex, and glacier-blue Antigravity messages on the left.
- Compact, familiar desktop controls with deliberate color fields.
- Solid and pure-translucent variants sharing one component system.
- Fully opaque type, icons, code, Diff meaning, and focus states.

Main-workspace visual references:

- [Opaque light](design-references/main-workspace/opaque-light.png)
- [Opaque dark](design-references/main-workspace/opaque-dark.png)
- [Translucent light](design-references/main-workspace/translucent-light.png)
- [Translucent dark](design-references/main-workspace/translucent-dark.png)

These references govern visual hierarchy, material, speaker alignment, Project/Session navigation, and the contextual Artifact panel. Their sample text and Diff are illustrative, not product fixtures.

## Colors

The palette uses daylight blue and midnight navy as environmental fields, with pastel speaker surfaces and a single precise Iris interaction accent.

### Primary

- **Iris Focus** (`#0069e0` light, `#67b1ff` dark): current selection, keyboard focus, and bounded progress indicators only.
- **Charcoal Action** (`#181d27` light, `#edf5fb` dark): the strongest action in a local decision area.

### Secondary

- **User Lavender** (`#f1e6ff` / `#2b2941`): right-aligned User messages.
- **Claude Peach** (`#fff2eb` / `#382923`): left-aligned Claude Code messages.
- **Codex Mint** (`#d3f6e3` / `#19372f`): left-aligned Codex messages and its inline activity rows.
- **Antigravity Glacier**: left-aligned Antigravity (`agy`) messages and inline activity rows using cool sky-slate provenance tinting paired with the `Antigravity` speaker label and mark.

### Tertiary

- **Ready Green** (`#16883f` / `#5ee58a`): healthy and running states.
- **Warning Ochre** (`#946200` / `#e6b84a`): recoverable operational risk. Routine collaboration decisions use neutral surfaces.
- **Danger Red** (`#b42318` / `#ff8a80`): failed, blocked, destructive, and irreversible actions.

### Neutral

- **Sky Canvas** (`#ebf5ff` / `#0f1720`): window environment and navigation field.
- **Bone Surface** (`#fafdff` / `#141e28`): Chat, documents, and primary pane surfaces.
- **Raised Surface** (`#ffffff` / `#1d2a36`): Composer, menus, and protected local emphasis.
- **Primary Ink** (`#0a0d12` / `#f2f7fb`): headings, body copy, and code-adjacent labels.
- **Secondary Ink** (`#535862` / `#a9b7c4`): helper text and metadata.

**The Semantic Color Rule.** Speaker color identifies provenance; Iris identifies interaction; green, ochre, and red identify operational state. Every colored signal also carries text, iconography, position, or shape.

**The Density-by-Importance Rule.** In translucent mode, Sidebar is most transparent, Chat is denser, and Diff/terminal/permissions are nearly opaque. Text and code never inherit surface Alpha.

## Typography

- **Display Font:** Inter Variable with platform sans fallbacks
- **Body Font:** Inter Variable with platform sans fallbacks
- **Label/Mono Font:** JetBrains Mono Variable for code, paths, hashes, commands, and measurement only

**Character:** Geometric and conversational. Weight 500 provides compact confidence; size, alignment, and spacing do most hierarchy work.

### Hierarchy

- **Display** (500, 45px/48px): onboarding and intentional empty states only.
- **Title** (500, 32px/36px): top-level settings and Project overview surfaces.
- **Subtitle** (500, 18px/24px): Session, panel, and Artifact titles.
- **Body** (400, 14px/20px): transcript, forms, and general interface content.
- **Label** (500, 12px/16px): metadata, toolbar labels, chips, and navigation.
- **Code** (400, 13px/20px): source, Diff, terminal, commands, identifiers, and measurements.

**The Mid-weight Ceiling Rule.** Use weight 500 for normal emphasis and 600 only when compact accessibility testing proves 500 insufficient. Product UI never inherits marketing-scale display type.

## Layout

The main workspace uses three resizable panes: Git Project/Session navigation, shared Session chat, and an optional contextual Artifact panel. The center Chat owns attention; selecting a Diff, document, or Comment opens the right panel, and closing it returns width to Chat.

The shell fills the Renderer viewport; only internal panes scroll. Wide mode starts at 1100px with three panes, compact mode is 860–1099px, and narrower supported windows retain Navigation left of Chat with Context overlaying from the right. The native minimum window is 720px wide and 520px high. Navigation never moves above Chat. Hiding a side pane returns its space and exposes a labeled restoration control; closing returns keyboard focus to that control. Overlay Context is a labeled modal with contained Tab order and Escape dismissal.

Resize separators show one 1px rule with an invisible 6px pointer extension on each side and support keyboard resizing. Interactive titlebar content is `no-drag`; native caption/traffic-light safe areas remain clear, and remaining titlebar space stays draggable. Navigation/Context transitions are interruptible, short and reduced-motion-aware. Lazy editors/details stay unloaded until needed; scoped loading and retry must preserve the rest of the workspace.

Project rows show disclosure state, repository icon, and editable Project name. The folder toggles disclosure; clicking the name opens its inline editor. Project-level New Session, Rename and Archive appear only on Hover or keyboard focus. Session rows begin 6px below the expanded Project header and are indented without tree connector lines, a persistent `Sessions` label, branch, Changes, path, or count metadata. A collapsed Project remains a single quiet row.

Spacing follows a 6px rhythm with 12px grouped gaps, 18px surface padding, and 24–36px separation between distinct tasks. Normal controls are 28–32px high; primary actions are 36px. Local layout state must not be described as a persisted per-Session preference; durable pane/state persistence is a separate planned behavior.

## Elevation & Depth

Solid themes use tonal separation and hairline dividers. Persistent panes do not use decorative shadows. Menus and dialogs may use one ambient shadow because they genuinely leave the plane.

Translucent uses explicit transparent window backing and per-surface color overlays on macOS and supported Windows. macOS has no Vibrancy blur; Windows disables native backdrop material rather than using Mica. Do not use whole-window opacity for material transparency; the bounded workspace visibility transition below is the sole temporary exception. The UI shows a 0–100 **Transparency strength** scale (default 50, higher is more see-through), not a literal window-opacity percentage. It maps to stored `materialOpacity` 100–70 (default 85) and then to separate surface Alpha ranges:

- Sidebar: 55–90% in dark mode; light translucency uses a brighter ice-blue overlay fixed seven percentage points below Chat (65–90%) so it remains part of the same environment instead of turning gray or becoming fully opaque.
- Chat: 72–97%.
- Diff, terminal, and code: 94–99%.
- Message surfaces: 86–96%.
- Text, icons, code, and focus rings: always 100%.

macOS uses `transparent: true` with `#00000000` backing and no Vibrancy. Windows resolves its startup material before window creation: Solid uses `transparent: false` and `thickFrame: true`; supported Translucent uses the existing frameless transparent window and semantic Alpha layers. Both retain native Window Controls Overlay and background material `none`. Windows background-mode changes are saved for the next full start; the settings surface identifies the currently active background and explains Exit from the tray before reopening. Theme and transparency-strength changes remain immediate. Unsupported platforms/builds, reduced transparency, high contrast/forced colors or observable material initialization failure fall back to complete Solid without forcing a running workspace to close. Retain the requested preference and show a concise effective fallback reason. A startup settings-read failure instead offers native Retry/Exit before the workspace exists; it must not silently choose Solid or show a false restart requirement. Renderer Alpha and successful API calls are not desktop-compositor evidence; inspect actual effects on each target platform. Verification is described in [Contributing](../../CONTRIBUTING.md#testing).

**The Legibility-before-Material Rule.** If desktop content competes with UI content, increase the local surface Alpha before adding blur, outline, or shadow.

## Shapes

Windows opaque Solid windows use system corner and shadow treatment, without a manual window region. Transparent-backed Windows windows retain subtle 8px corners with native clipping of drawing and pointer input. Maximized and full-screen windows use square corners; macOS retains its native window rounding. Inputs, icon buttons, and code-adjacent controls use 8px. Message surfaces use 12px; genuinely detached panels may use 14px. Pills are reserved for short recipient and attachment chips; normal toolbar actions are not pills.

## Components

### Buttons

- **Primary:** charcoal with white text in light mode; pale inverse with dark text in dark mode.
- **Project actions:** New Session, Rename and Archive controls are hidden at rest and appear together on Project header Hover or `:focus-within`. Rename uses a 14px Pencil beside Archive. Session Archive also appears on Hover/focus. Archive uses a 14px icon inside a 28px hit area. Idle archive acts directly; active work opens the Pact archive confirmation. The summary notice retains individual Undo actions without restarting tasks.

Archive confirmation uses the current raised surface, Inter body/18px title, 14px corners and dialog
shadow. A compact header names the action; complete target and affected Session names remain readable.
Flat task rows separate current activity from the later Stop outcome. Cancel receives initial focus;
Stop and archive names its consequence. During stopping, the same modal retains focus, displays
indeterminate progress and disables dismissal. Failure retains the item and reports individual
outcomes, with Check status reading the same operation rather than repeating Stop. The body scrolls
inside a viewport-bounded dialog while actions remain visible. Both themes, reduced motion, keyboard
focus and forced colors share this composition. This is an application modal, not a system dialog.

Archive results use one nonmodal raised panel below the titlebar, with a compact count summary and
View/Hide disclosure. The expanded list uses flat divided rows, complete wrapping names, Session or
Project metadata, and text/icon status cues for Archived, Archive failed and Result to check. Each
successful row has Undo; failures expand their reason and affected Session outcomes before Review
again; unconfirmed rows offer Check status. Progress and restore/check errors stay on their own row.
The list scrolls within the viewport while summary and footer remain visible; pagination keeps the
row count bounded. Escape collapses the list and returns focus to its disclosure. Dismiss removes
only resolved results, leaving unconfirmed entries accessible. The footer explains that stopped tasks
stay stopped. Both themes and forced colors retain the same hierarchy without a blocking backdrop.

- **Focus:** two-pixel Iris outline with two-pixel offset; focus never relies on translucency.
- **Destructive:** danger treatment only when the label states the destructive consequence.

### Icons

- Product controls use `lucide-react` with a normal 16px size and 1.75px stroke unless the control hierarchy requires a documented exception.
- Common controls must not introduce one-off inline SVG drawings. Custom vector work is reserved for product-specific diagrams, data visualization, and brand assets that Lucide cannot represent.
- Project disclosure uses Lucide's closed/open folder pair. The icon transition communicates collapsed versus expanded state; Project rows themselves remain neutral at rest and use Hover/focus treatment instead of a persistent selected background.

### Chips

Recipient and Comment attachment chips use a compact raised surface and full label. Their removal control remains a real icon button with visible keyboard focus.

### Cards / Containers

Messages and self-contained Artifacts earn a colored surface. Navigation groups, ordinary rows, and pane sections remain unboxed. Persistent content uses tonal layering rather than shadows.

### Inputs / Fields

Runtime Preparation presents three equal-hierarchy CLI cards (**Claude Code**, **Codex**, **Antigravity**) with readiness summary copy (`2 of 3 ready · Minimum 2 required`) unlocking **Continue** once any two CLIs are Ready. Default Session Settings and Session Creation (**Use App defaults** or **Customize this Session**) support all six `(Primary, Secondary)` permutations, pre-selecting the two Ready CLIs on first use when the third is unavailable and disabling an unready third option with its concise reason while loading model catalogs only for the active pair. Main-Session **Session settings** allow swapping `Primary <-> Secondary` anytime and allow replacing an active member with the third Agent at clean idle boundaries, disabling third-Agent replacement with a single inline explanation whenever active/recovering Runs, queued input, an unfinished collaboration task, or unsettled effects remain; leaving the active pair resets that Agent's `Full access` to `Ask`, while side chats keep settings, Permission, and Speed hidden.

Agent settings align Model and Effort, stacking in compact panels. Speed belongs in Composer: each active Agent in the Session's two-Agent pair groups independent Permission and Speed buttons with a divider and the Project folder/branch surface treatment. Speed always shows its label and Native, Standard or Fast value (Antigravity remains `Native` with an explanatory tooltip while native speed overrides and readback are unsupported). All dropdown arrows stay neutral; Full access warning color applies only to its icon and label. Speed opens its own upward popover with checked choices, descriptions and a Next run / This Session footer. Selection saves immediately; keyboard navigation, Escape and visibility/focus recovery follow existing Composer menus. Requested speed and native fallback remain distinct. Run headers show Native speed when a requested override was not applied and no effective speed was reported. Put the explanation behind a neutral info icon with a hover and keyboard-focus tooltip; keep long diagnostic prose out of the header. App defaults, Session settings and creation customization contain no Speed field.

Permission controls keep their existing layout and labels. Their tooltip and existing menu footer distinguish the next-task selection from the active Run's frozen choice and any project read-only duty. Full access does not display tool-approval cards; native-policy refusals do not become approvals, and questions/forms and plan implementation decisions retain their own interaction.

Fields use a dense local surface so their value remains stable over any native backdrop. Focus increases border contrast and adds the Iris focus outline. Disabled and error states retain readable values and recovery copy.

The Project name editor stays in its row: a 32px focused input group with 28px Check/X controls on the right, an Iris-tinted Save action and neutral Cancel. Select the current name on entry; Enter saves, Escape cancels, and blur keeps the draft. A failed save keeps the input and shows a local error; saving is visibly busy and cannot repeat. Names are trimmed, nonempty, single-line and limited to 120 UTF-16 units. The shell has no application fullscreen button or dedicated fullscreen Bridge.

### Navigation

Project ownership is expressed by disclosure, indentation, and grouping. Do not draw Project-to-Session connector lines. The selected Session uses a powder-blue or midnight-blue surface plus its title and state. Full path, branch, and repository status belong in a tooltip, context menu, or Project details—not the default tree.

Session group headers mix the chosen color into the raised surface and show the group name. Group titles keep their rounded corners and use more space between groups than between a title and its members. A quieter opaque tint sits behind the indented members and page controls. Hover changes the tint across one row without shifting its content. The group editor opens beside its invoking row. Its swatches run from gray through blue, red, yellow, green, pink, purple, cyan, and orange. A circular ring identifies the chosen color. A collapsed group containing the selected Session shows a Current hint. Drag previews show the original row content. A valid Session destination opens a text-free slot. The group gutter and the upper part of the source heading accept a drop into Ungrouped. The released row settles into that saved position. The group header indicates the target without outlining members. Membership changes animate visible rows into place and respect reduced motion. Names and icons remain visible in forced colors.

### Transcript and Composer

User messages are right-aligned on lavender. Claude Code, Codex, and Antigravity messages are left-aligned on peach, mint, and glacier-blue surfaces. Speaker labels remain visible, and ordinary messages avoid avatars that could be mistaken for account UI. Flow steps and runtime states may appear inline inside the responsible Agent message; global workflow timelines and `Plan approved` banners are not persistent Chat chrome. Main-chat user messages synced from a side chat carry a clickable **From side chat** badge (`+8px → 0`, 180 ms `--ease-out-pact`) that opens that side chat in the right pane; ordinary text selections on main-chat User/Agent messages expose **Ask in side chat** beside **Add comment** (`@starting-style` 140 ms float-in / 90 ms float-out).

The Composer is a stable dense surface at least two lines high. Native Skills and the selected route (`@claude`, `@codex`, `@agy`, `@all`, or side-chat `@Main`) are atomic inline units; attached Comments are removable source chips above the input; native question answers stay in their live forms. Images show thumbnails, filename and state, with Add image below full-width text. Active-pair Agent permissions, Speed, Project folder and branch stay on one row below the input. Project context shrinks first; labels truncate as space decreases while icons and dropdown controls remain visible. Full values remain available through accessible names, tooltips and menus. Send becomes Stop during a response. Enter queues one message, Shift+Enter inserts a newline; a disabled queue retains Enter as newline. Unsubmitted drafts never auto-send.

Completed Pact command tokens use the same book icon and inline badge treatment as native Skills, labeled `pact:plan`, `pact:review`, `pact:build`, and main-chat `pact:btw`. Their original slash text remains authoritative for editing, copying and sending. Main-Session `@` autocomplete offers the Session's active two-Agent pair and `All` (supporting `/btw @agy /skill` handoffs without `@gemini` aliases); `/` Skills groups Pact commands separately from native catalogs of the active two-Agent pair. In side chats, all Pact slash commands and **Fork** are disabled, and the locked Composer footer hides the Session settings gear, Permission, Speed, and Project controls. Side-chat `@` autocomplete places `@Main` below the side chat's active member mentions and `@all`, morphing Send (150 ms) to `CornerUpLeft` (**Send to main**) and displaying a compact **Sent to main chat · View** bar (160 ms entrance) upon sync-back. Seeding a `/btw` draft into a new side-chat Composer plays a 220 ms Iris border/surface arrive settle (`.pact-composer-handoff-arrive`) with cursor at end and zero auto-send. Skill and Agent recipient pickers sit 8px above the entire Composer and escape input-panel clipping. The Skill picker keeps command targets fixed as native catalogs load; both pickers fit their scrollable height to the available viewport. Escape and outside clicks dismiss the active picker until its query changes; incidental cursor events must not reopen it. Ordinary draft and validation resizing must preserve the complete Composer focus outline.

One compact raised message strip sits immediately above Composer, with a queue icon, recipient, readable preview and Steer, Remove and More actions. When the responding Agent differs from the queued recipient, an info icon beside disabled Steer explains both Agents on hover or keyboard focus. The menu contains Edit message and Disable queue; paused delivery offers Resume queue. State/reason and attachment counts wrap beneath the preview without displacing actions at narrow widths. A queued Pact command carrying a confirmed task replacement says it waits for the current response and will start instead of continuing the old task; it never claims the old task already ended. Unknown or active delivery locks destructive/duplicate actions and offers Check status for its original Run. After a confirmed Rebuild retires that Run, Remove becomes available with copy explaining that only the Pact queue is cleared and delivery remains unconfirmed; Edit, Steer and Resume remain locked. An empty disabled queue still exposes Enable queue. Use the existing Composer popover treatment, keyboard menu navigation, Escape/focus return and both themes. Edit removes the item and returns its full content to the normal Composer, overwriting its draft; no Save/Cancel edit mode is introduced. A return receipt needing recovery uses a quiet Restore returned message action outside the queue.

Steer supplements divide one Run into full response snapshots. Preserve prior bubbles while responding; new output follows the latest supplement. Work Log stays at the Run's original output position while responding. Completion moves it into the final answer and resets it collapsed, even if previously expanded or being read; an explicit click can reopen it. Once normal completion and the complete canonical body are ready, automatically hide intermediate snapshots and leave all User inputs followed by the final answer. Do not add an Earlier responses or manual snapshot-collapse button. Exact Comment source navigation remains available through bounded history. Jump to latest appears only when newer history is available; snapshot preservation and expansion are not history gaps. Source synchronization and mounted context/body rows retain the existing transcript budgets.

Composer permission, Project-folder and branch popovers share one presentation: raised surface, neutral hairline border, one subtle shadow (6px downward offset, 18px blur, 18% black), 14px radius, 8px padding, 12px text, 8px action-row corners and the same Hover/focus treatment. Use a title, actions and a divided footer for supplementary context; complete selectable paths and branch names live in that footer. All use the permission menu's 160ms opening/110ms closing motion with reduced-motion support. Width and alignment follow the content and trigger; do not introduce a separate background or shadow treatment for these menus. The registered folder opens with `Open in Finder` on macOS and `Show in Explorer` on Windows. Keyboard navigation must retain the chosen item when the asynchronous popover toggle arrives. Native attention and exit confirmation hide composer popovers; returning restores the permission trigger focus. Suspended image previews and Fork dialogs retain their selected image, form state and focused control.

### Artifact, Diff, and Review

The right panel is contextual, resizable and closable. Diff uses dedicated add/remove tokens in both themes and becomes nearly opaque under translucency. Documents preserve comfortable prose measure; Comments retain a visible anchor without obscuring code.

### Side chats

Main-chat headers place a **Side chats** button beside **Session settings** with a subtle Running/Needs attention badge (`pact-badge-pop`, 180 ms), or a quiet unread dot (`bg-focus`) when unread completed replies exist without active runs or attention items. Clicking opens a continuous scrolling virtualized list with a single **+** (**New side chat**) icon button in the header, fixed `84px` row height, and zero pagination or Load more buttons; each row shows title, Running/Needs attention badge (or quiet `New reply` unread dot), `ChevronRight` (`+2px` hover slide, 150 ms), single-line latest message preview (falling back to anchor quote or `Started with /btw`), and timestamp, with empty (`No side chats yet`) and inline boundary Retry states. Initial panel reveal staggers rows `150 ms` (`translateY(4px → 0)` + opacity, `18 ms` step capped `≤90 ms`), with zero enter animation while scrolling.

Side-chat detail replaces the list via `SideChatStage` horizontal push (`data-direction='1'`, 180 ms `+12px → 0`) and pop (`data-direction='-1'`, 160 ms `-12px → 0`) transitions using `--ease-out-pact` (`cubic-bezier(0.16, 1, 0.3, 1)`), animating only `transform` and `opacity`, keeping the outgoing layer inert, and respecting `freezePanelContent` reflow protection plus `prefers-reduced-motion: reduce` (60 ms opacity fade, zero translate or stagger). Its header renders **‹ Side chats** (restoring list scroll before paint), truncated title (starting at `New side chat` until updated by Agent naming), and **×** close (leaving runs intact and restoring trigger focus) with no settings gear. Empty side chats show `Ask <Agent>` and `Ask about the main chat, or type @Main to send a takeaway back.`; leaving an untouched empty draft side chat automatically discards it, while opening a side chat with unread completed replies marks it read. Selecting text for **Ask in side chat** pre-attaches the quoted excerpt as a standard removable Comment draft chip inside the side-chat Composer (`Main chat · “…”`, with **↩** return-to-source highlighting/pulsing the parent quote and **×** remove), settling into a standard sent **Comment** card once sent; `/btw` side chats show a quiet **Context from main chat** line when parent context exists. Main-chat messages tagged **From side chat** dynamically resolve the current side-chat title in their tooltip/label. Opening a File, Changes, or Skill preview from an active side chat pushes it onto the Context navigation stack with **‹ Back to side chat** in the header to pop smoothly back while preserving side-chat scroll and draft.

The current full plan is read only in Context's Plan tab with one status badge (`Unreviewed`, `Needs update`, `Ready`). Plan headers expose Expand/Restore beside Close. The Plan pane resizes within the available workspace without a percentage cap or document-width ceiling. In-app expansion keeps the same document, scroll position, Conversation owner and Comment state mounted; its Comment editor and attached drafts remain usable inside the expanded pane. Restoring returns them to the Composer without sending or discarding drafts. Chat preserves complete natural replies and review reports, with a compact footer for the native plan version, review state and next action. Avoid a second full plan or a separate structured-feedback disclosure. A native plan with no ordinary answer still has its compact source/footer and opens the saved plan document. Current **Implement plan**, **Review plan**, **Review code**, **Update plan**, **Fix issues**, and **Retry** actions remain visible independently of historical folding. Task action rows place one primary action first and bordered secondary actions after it on a single horizontal row that scrolls rather than wraps; at narrow widths repeated Agent suffixes compact while complete accessible names and tooltips remain. There is no standalone Pause or Continue collaboration action. A replaced task's result footer reads Ended, or Ended before review when its last changes were not reviewed.

The context pane contains Plan, files, Changes and Session settings; findings and author responses live in natural review reports. Native question, form and browser-authorization cards use the same InputReplacement location as workflow decisions, taking priority while their native operation is waiting. Their scrollable content keeps submission and cancellation reachable. Do not add a separate draft-retention caption or Stop row beneath the native card. Ordinary draft state stays mounted and inert until the native request clears, then the workflow decision or ordinary Composer resumes. Tool-approval cards retain their transcript placement. Native question forms present actual provider choices and free input, preserve keyboard/focus/cancellation behavior, and do not create shared task rows or persistent answer chips. Recommendations remain labels rather than submitted answers.

Historical plans and reports retain their exact source/version; unsupported old anchors show their saved quote and an unavailable reason without reopening removed workflow UI. Navigation waits for body readiness before alignment, restores exact source focus, and does not reset reading position on refresh. Internal UUIDs, hashes, JSON fields and transport instructions do not belong in visible product prose.

During authorized automatic collaboration, show the responsible Agent and concise current step. User Send immediately blocks later handoffs until its priority reply is processed; the current root normally finishes. Confirmed latest-input settlement automatically continues authorized planning/review unless an explicit or exceptional pause remains. When a completed reply requires a user decision, its question card replaces the ordinary Composer. Show each explicit prompt, unselected choices when supplied, and a labelled free-answer field; do not infer questions from report prose. Send answers submits only the card answers to the verified requesting Agent. Sent replies show the frozen @recipient beside You, a separate reply heading, and numbered question blocks with selected answers on their own lines. Stop interrupts the current response and pauses collaboration while preserving sent answers and ordinary drafts. Keep the ordinary message draft, images, Comments, Skills, route and returned-input receipts intact and unsent. The reusable InputReplacement component owns the shared input location, a 220ms height transition with a 140ms fade, focus handoff and inert inactive panels. Reduced motion removes height/movement and keeps a brief opacity cue. Its two panels, one ResizeObserver, one animation and one exit-retention timer are disposed on unmount. Processing keeps a compact answer status in this location with Stop and existing recovery/queue controls; ordinary message input returns only after the decision gate clears. Failed or uncertain work retains recovery and never silently opens a new-message path. When the current plan requires recovery, replace an existing decision form with a neutral Plan recovery required state. Keep its answers and ordinary drafts intact, and use the existing Proposal recovery action. Do not show question or answer-processing copy for this recovery state. Older requests retain an expandable original-text entry and a free-answer field inside the card. Result footers distinguish requests for input, processed replies and ordinary review responses using that Run's stored facts. Use a neutral muted surface, a thin neutral border and a monochrome conversation icon; routine input requests are not operational warnings. Successful Send dismisses this prompt immediately; failed Send preserves it. Sending a new Pact command over an unfinished task opens an application modal replacement confirmation using the Archive dialog's raised surface, backdrop and motion: the Composer and input stay unchanged behind the backdrop with the draft intact, the modal suspends with the native presentation surface, Keep current task takes initial focus, and Escape or Keep returns focus to the Composer draft without sending. Queue/progress/recovery use their existing surfaces. Only a new decision request shows the prompt again. Hide Continue and the next-review suggestion until the reply is confirmed processed. Active collaboration then proceeds automatically; only a persistent pause shows Continue collaboration with its computed next step. Keep Stop separate from pausing future work. At Session limits, show the specific exhausted allowance and retain the plan/report rather than implying failure erased it. Native form answers continue the existing root while any independent automation pause remains visible. Restart preserves a paused continuation and the original unknown-work recovery action; no hidden automatic peer restart or generic approval banner is introduced.

Image preview is a native modal with previous/next, directional keys, bounded filmstrip, close/Escape and trigger focus return. It fits content without zoom/Fit/100% controls. Its 180ms slide/fade honors reduced motion. Recovery uses one compact card for affected Agents, with currently valid action and specific reason rather than stacked warnings or repeated safety paragraphs.

### Relay scheduling

Relay Settings retains its heading and intelligent-orchestration subtitle naming Decisions API,
independent enable and indicator preferences, Decisions API configuration, an encrypted
API-key field with Save/Replace/Remove and explicit status check, the usage notice and read-only
Scheduling activity. Saved keys appear as masked dots in the field. An inline Eye/EyeOff button
reveals or hides the saved key on explicit request; typing starts a replacement draft. Revealing
alone does not enable Replace. Leaving Settings or hiding the key clears the revealed value.
The settings surface stays opaque in translucent windows. Activity shows the scheduled action and its
outcome first, then time and Project/Session, plus only unresolved-work warnings; records carry no
filter, details, navigation, copy, export, retry or clearing actions.

Place the compact rectangular `Scheduling in background` indicator immediately above the current
Composer's upper-left edge. Show it only for that Session's real evaluation/check activity while
Relay and its indicator preference are on. Idle, other-Session activity, catalog probes, cleanup and
waiting for user input do not imply active scheduling. Reserve the settings button's space; Hover
and keyboard focus reveal it smoothly without moving the Composer or taking focus. Its accessible
name is `Open decision & scheduling settings`.

The indicator and Relay decision card share one soft highlight slowly travelling around the edge,
using theme-derived lavender, peach and mint. Keep their interiors and text stable in both themes.
Reduced motion uses a static colored edge; hidden/unmounted content stops its animation. This
bounded edge treatment is the exception to the general product-gradient rule. Native approvals
retain their existing styles and transcript position.

All admitted Relay decisions replace the Composer through the shared InputReplacement, which keeps
the mounted ordinary draft. Use a clear `Relay decision` heading, a short concrete action or
scheduling question and at most one necessary impact line, then one action-specific primary
confirmation beside a bordered secondary `Cancel`. Only a genuine
host-required scheduling field permits choices or text; ordinary business questions stay in the
Agent's form. Do not display protocol IDs, grants or hashes. Optional suggestions (extra
authorization or role reassignment) use the same replacement card with direct Skip/confirm actions.
Skip answers the decision, restores the default workflow and preserves genuine pauses, including a
genuine limit pause; the preserved draft returns to the Composer. While a card is unresolved the
ordinary input stays inert and the card keeps its existing error/receipt-check state.
Native permission/question/OAuth interactions come first, existing collaboration/recovery next, then
a freshly host-validated Relay request. Preserve ordinary drafts and attachments, unsubmitted answers,
queue semantics and focus. Showing a card, hiding it or answering another interaction grants no Relay
permission. Pending/uncertain confirmation uses its own receipt state and cannot become another Send.
Turning off the indicator does not hide a necessary decision. Latest Relay visual acceptance remains
pending; static CSS/build checks do not establish the visible effect.

At a Plan-review limit, a selected one-review recommendation uses the shared InputReplacement Relay decision card. Show the reviewer and exact Plan version, with **Skip** and **Add review**. Keep error, receipt-check and submission states. Skipping retains the limit pause. Confirmation grants one task-bound read-only review, not a Session setting or implementation permission.

A scoped Repair request names one repair and its fixed reviewer; its confirmation says `Allow
repair`, and Full access is stated when those are the current execution permissions. Never describe
that writing authorization as a read-only turn. A Rebuild request says `Rebuild context`, retains
warnings about old work continuing or earlier uncertain creation, and replaces only its matching
recovery row. Cancel preserves the underlying recovery facts. Activity distinguishes a rebuilt native
context from a completed business task, and displays historical model identity only for actual
inference. Suggestions, acceptance and real execution results remain separate readable facts.

### Session reminders

Show at most one compact raised Session reminder at a time, anchored at the bottom-right edge of the
workspace: above the Composer when a Conversation is visible, and at the bottom-right corner in
Settings, Runtime Preparation, or Needs attention so it never covers the Session header,
operation-error Toasts, or message input. It uses the neutral raised surface, hairline border, 14px
panel radius, and popover shadow, applying semantic status color strictly to the status icon
(`Reply`, `CircleAlert`, `CircleCheck`) alongside the plain-text bounded Session title, Agent and
one of Needs your input, Failed or Finished, with a quiet secondary `View Session` button (`Review`
or `View workspace` for overflow summaries) and a close button. Native system notifications use only
the Pact application identity and fixed Agent/status copy; they never contain Session/Project
titles, user content or dynamic errors. Unacknowledged background Session notifications show a numeric
count badge (`99+` above 99) on the macOS Dock icon with a gentle single informational bounce when the
count increases, and on Windows render a numeric taskbar overlay icon paired with an unfocused frame
flash; both clear when viewed, dismissed, focused/acknowledged in the foreground, or on exit.

Hover or keyboard focus pauses the eight-second in-app dismissal timer; moving away resumes it. When
multiple reminders queue in the foreground, a subtle motion-safe badge pop highlights the pending
count pill (`+N`) alongside the status icon entrance without stealing focus. The
reminder must not cover or replace operation-error Toasts or quit confirmations, and update notices
wait for the reminder channel to be idle. It remains visible when the target Session is not the
visible focused Conversation, and clears automatically when that Session becomes visible and focused.
Clicking `View Session` only opens the Session; it never answers, approves or continues work.
Reduced motion, light/dark, transparent-backed windows and minimum window sizes preserve the same
hierarchy, and status never relies on color alone.

In the bottom-left Project Navigation footer above **Settings**, Pact shows a compact **Usage**
icon trigger (`Gauge`) instead of permanently stacking metrics in the sidebar. Hovering or focusing
the trigger opens a lightweight compact popover showing available **Codex**, **Claude Code**, and **Antigravity** `5h` and `7d`
remaining quota bars with `tabular-nums` `% left` labels (omitting absent windows), concise pool-scope notes when multiple model pools exist (such as `Gemini Models quota`), semantic
low-quota thresholds (`20%` left warning ochre, `5%` left danger), silent loading bar placeholders, and
1–3 word status labels for non-window or unauthenticated logins without timestamps. Clicking pins a
detailed popover that adds per-window reset times and per-provider manual refresh buttons (respecting
the thirty-second cooldown and the two-probe App-wide concurrency ceiling), dismissible by clicking the trigger, clicking outside, or pressing
`Escape`.

Send keeps its **Send message** title; there is no separate question control beside it. A pure
question at a settled checkpoint uses the same ordinary Send; only a proven read-only reply
restores the frozen checkpoint without changing the task.

A valid `/plan`, `/build` or `/review` command carrying an explicit `@Agent` shows a quiet
caption naming who plans, implements and reviews code before Send.

Keep the current author's Repair action. Offer **Choose repairer** with the other active Agent's name
when they can repair the current findings. Both this choice and an eligible request from the
reviewer's reply use **Switch repair agent** in the existing InputReplacement. Keep the neutral border and raised surface with a static edge.
Name who repairs and who reviews for the rest of the task in one sentence. Use **Repair with Codex**, **Repair with Claude Code**, or **Repair with Antigravity**, and **Keep current roles**. State Full access when applicable.
Keep cancellation, focus, error and receipt behavior. The confirmation also appears with Relay off.

A future code-role change uses the same card and **Use suggested roles** action. Name the
proposed implementation and review recipients in one line, and state that implementation still
needs approval. Cancellation retains the existing pause semantics and button.
Activity records the saved arrangement separately from any later implementation result. Layout,
input replacement, focus, motion and indicator treatment remain unchanged.

An accepted Phase 1 Plan also offers **Swap implementer** beside a quiet line naming who implements
and who reviews code. Its confirmation reuses the task-replacement application dialog under the
title `Swap implementer?`: list both old-to-new code responsibilities, then state that
implementation still needs approval. **Keep current roles** takes initial focus; **Swap implementer**
confirms with `Swapping…` busy text; the close control is `Cancel role change`; Escape or cancel
returns focus to the Swap action. It saves only the next role version with a settled audit receipt:
no Run, scope, counter or pause change, and no implementation authorization. The control stays
available with Relay off and can supersede an unused Relay suggestion card. Sending `/review` over an
unfinished Open Mode `/plan` or `/build` task shows a quiet in-task review hint rather than a task
replacement confirmation.

**Revise plan** and **Keep current plan** reuse the task-replacement application dialog: raised
surface, static edge, a title question, Cancel left and the confirming action right, default focus
on Cancel, Escape cancel only, no backdrop dismissal, and busy blocking close. The revise body
names the fixed planner and states that independent review plus a new Implement approval follow;
the keep body states that only this exact revision request is dismissed while existing work stays
paused. Return focus to the triggering action and keep the same error/receipt semantics. A paused
task with unfinished authorized work and no pending revision names that continuation Resume
implementation or Resume repair; its action tooltip explains that it resumes the original scope
and later messages do not expand its authorization.

## Windows installer preview

The first Windows x64 installer is a native NSIS Modern UI extension. Its visual design is pending
user acceptance. The installer retains native window controls, directory selection, keyboard focus,
progress and completion controls. It presents welcome, directory, shortcut options, progress and
completion in that order. Setup does not perform provider installation or collect credentials; the
existing Runtime Preparation flow owns first use after launch.

The proposed Pact icon uses two rounded strokes to form a shared P on the Midnight Canvas
(`#0f1720`). One stroke uses Sky Canvas (`#ebf5ff`) and the other uses a muted mint (`#a9dfc3`). The
canonical [SVG](resources/icon.svg) supplies development PNG, multi-size Windows ICO and macOS ICNS
through one shared asset generator. Welcome/completion artwork uses Sky Canvas,
with the same mark; intermediate pages use a small header mark on white. Artwork is decorative.
Instructions, paths, options, progress and results remain native text and controls.

macOS Dock PNG and ICNS exports inset the shared artwork by 8% on each edge of the transparent
canvas, keeping its visible size aligned with neighboring app icons. Development and packaged
applications use the same margin. Windows exports and the separate menu-bar Template icon retain
their existing artwork bounds.

The installer preview has its own application identity, directory, shortcuts and package name. The
desktop shortcut is optional, the Start menu entry is retained, and Open Pact starts unchecked. The
installer owns application files and registration, while the existing application owners retain
projects, conversation data, migrations and provider configuration. Uninstall preserves user data.

The preview is English-only and does not establish signing, upgrade, DPI, accessibility or runtime
acceptance. Preserve the main-workspace design system while this native design is under review.
Shared macOS icon assets are available; their native appearance is not established by Windows evidence.

Native development windows identify themselves as `Pact - Development - Local`; locally distributed
production packages use `Pact - Production - Local`. Native window/taskbar names, installer names and
shortcuts retain the selected identity, while Pact remains the product brand. Future CI development
and official production have separate reserved identities; no CI release workflow is implied.
Windows development taskbar entries use the Pact icon and explicit development name rather than
Electron's executable branding. Their Session groups navigate the running repository instance;
fully exited development instances still start through `pnpm dev`. macOS development bundles register
the active checkout instance and exit ownerless cold launches without opening a bare Electron window.

## Resident window and native navigation

Complete startup uses 80% of the pointer display's available width and height, centered within that
work area. Retain a 720 by 520 minimum when it fits; smaller work areas cap the minimum and bounds.
Revealing the running workspace retains its geometry and native window state. If its title bar is
unreachable after a display change, recover the window into an available work area.

macOS and transparent-backed Windows workspace visibility uses a quiet 150 ms decelerating entrance and a faster 100 ms accelerating
departure, with no scale or position choreography. This is a brief whole-window opacity transition,
not a material setting. Stable visible and hidden windows retain native opacity 1. Repeated requests
reverse from the current opacity; an already visible workspace only receives focus. Reduced motion
or disabled system animations uses immediate visibility. Minimized/fullscreen windows and native
window-state changes use their system behavior without an additional fade; macOS retains native
fullscreen/Space transitions. Transparent Windows preserves its existing corner region and window
style, which may not support standard native scaling animation. Opaque Solid Windows windows use
system visibility, minimize, maximize and restore behavior without custom fades or opacity writes.

The tray mark derives from the shared Pact P. Windows uses
[monochrome artwork](resources/tray.svg) with pale and gray strokes on a charcoal square. macOS uses
the transparent [Template silhouette](resources/trayTemplate.svg) at normal and Retina density;
the operating system supplies contrast. Main owns native menu composition. Tray, Windows JumpList
and macOS Dock menus retain native typography, focus, selection and keyboard behavior.

Flat groups distinguish Needs attention, Running and Recent Sessions. Each entry identifies its
Session and Project; text state supplements icons without exposing bodies or paths. Starting uses
an Hourglass and remains distinct from Running. The full attention view uses the existing workspace
surfaces and typography, flat divided rows, unread cues, visible errors and five-row pagination.
Opening it preserves the selected Conversation and ordinary drafts.

Exit confirmation uses the Pact application dialog in both themes: compact title, plain consequence,
affected Session rows and Cancel/Exit Pact actions. Cancel receives initial focus. Pending cancellation
and physical shutdown keep progress and errors in place rather than closing the dialog optimistically.
Closing or unconfirmed shutdown disables dismissal and retains the workspace. Reduced motion,
forced colors and keyboard focus share the same composition. A system dialog is a fallback when the
Renderer is unavailable. This native module remains subject to actual platform inspection and user
visual acceptance before formal verification.

## Do's and Don'ts

### Do:

- **Do** use the four main-workspace references as the visual target set.
- **Do** implement appearance through semantic Tailwind utilities and per-surface CSS variables.
- **Do** preserve meaningful differences between solid/translucent and light/dark modes.
- **Do** keep text, icons, code, and focus indicators fully opaque.
- **Do** use Lucide React for common product controls and state icons.
- **Do** keep keyboard focus, forced-colors states, placeholders and status/Diff foregrounds readable in both themes; speaker alignment and labels supplement color.
- **Do** expose Project actions on Hover and keyboard focus together.
- **Do** fall back to the complete Solid theme when native material is unavailable or inappropriate.

### Don't:

- **Don't** use whole-window opacity to implement translucency.
- **Don't** draw Project-to-Session connector lines or show branch/Changes/path/count metadata by default.
- **Don't** add a persistent `Sessions` label under an already expanded Project.
- **Don't** use gradients outside Relay's specified edge treatment, 3D illustration, giant typography, or 32px marketing-card radii in product UI.
- **Don't** let wallpaper reduce Diff, terminal, permission, or body-text contrast.
- **Don't** treat Agent color as the only provenance cue.
- **Don't** draw one-off inline SVG icons when Lucide provides the control or state symbol.
