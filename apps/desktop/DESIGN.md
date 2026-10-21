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

Pact pairs an airy sky-tinted workspace with a midnight companion theme. The interface remains operational and precise, but soft lavender, peach, and mint message surfaces give User, Claude, and Codex an identity that is memorable without becoming noisy. Dense actions stay charcoal or pale inverse; Iris blue is rationed to focus, selection, and live state.

This is an Operate interface. Transcript, Diff, documents, permissions, and runtime activity must remain readable for hours. Translucency is optional material depth, not decoration: navigation may reveal more of the desktop environment, Chat reveals less, and code surfaces remain nearly opaque.

**Key Characteristics:**

- Pale sky canvas and bone-white work surfaces in light mode.
- Midnight-blue surfaces rather than generic black in dark mode.
- Lavender User messages on the right; peach Claude and mint Codex messages on the left.
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
- **Claude Peach** (`#fff2eb` / `#382923`): left-aligned Claude messages.
- **Codex Mint** (`#d3f6e3` / `#19372f`): left-aligned Codex messages and its inline activity rows.

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

Agent settings align Model and Effort, stacking in compact panels. Speed belongs in Composer: each Agent groups independent Permission and Speed buttons with a divider and the Project folder/branch surface treatment. Speed always shows its label and Native, Standard or Fast value. All dropdown arrows stay neutral; Full access warning color applies only to its icon and label. Speed opens its own upward popover with checked choices, descriptions and a Next run / This Session footer. Selection saves immediately; keyboard navigation, Escape and visibility/focus recovery follow existing Composer menus. Requested speed and native fallback remain distinct. Run headers show Native speed when a requested override was not applied and no effective speed was reported. Put the explanation behind a neutral info icon with a hover and keyboard-focus tooltip; keep long diagnostic prose out of the header. App defaults, Session settings and creation customization contain no Speed field.

Permission controls keep their existing layout and labels. Their tooltip and existing menu footer distinguish the next-task selection from the active Run's frozen choice and any project read-only duty. Full access does not display tool-approval cards; native-policy refusals do not become approvals, and questions/forms and plan implementation decisions retain their own interaction.

Fields use a dense local surface so their value remains stable over any native backdrop. Focus increases border contrast and adds the Iris focus outline. Disabled and error states retain readable values and recovery copy.

The Project name editor stays in its row: a 32px focused input group with 28px Check/X controls on the right, an Iris-tinted Save action and neutral Cancel. Select the current name on entry; Enter saves, Escape cancels, and blur keeps the draft. A failed save keeps the input and shows a local error; saving is visibly busy and cannot repeat. Names are trimmed, nonempty, single-line and limited to 120 UTF-16 units. The shell has no application fullscreen button or dedicated fullscreen Bridge.

### Navigation

Project ownership is expressed by disclosure, indentation, and grouping. Do not draw Project-to-Session connector lines. The selected Session uses a powder-blue or midnight-blue surface plus its title and state. Full path, branch, and repository status belong in a tooltip, context menu, or Project details—not the default tree.

### Transcript and Composer

User messages are right-aligned on lavender. Claude and Codex messages are left-aligned on peach and mint. Speaker labels remain visible, and ordinary messages avoid avatars that could be mistaken for account UI. Flow steps and runtime states may appear inline inside the responsible Agent message; global workflow timelines and `Plan approved` banners are not persistent Chat chrome.

The Composer is a stable dense surface at least two lines high. Native Skills and the selected route are atomic inline units; attached Comments are removable source chips above the input; native question answers stay in their live forms. Images show thumbnails, filename and state, with Add image below full-width text. Agent permissions, Speed, Project folder and branch stay on one row below the input. Project context shrinks first; labels truncate as space decreases while icons and dropdown controls remain visible. Full values remain available through accessible names, tooltips and menus. Send becomes Stop during a response. Enter queues one message, Shift+Enter inserts a newline; a disabled queue retains Enter as newline. Unsubmitted drafts never auto-send.

One compact raised message strip sits immediately above Composer, with a queue icon, recipient, readable preview and Steer, Remove and More actions. When the responding Agent differs from the queued recipient, an info icon beside disabled Steer explains both Agents on hover or keyboard focus. The menu contains Edit message and Disable queue; paused delivery offers Resume queue. State/reason and attachment counts wrap beneath the preview without displacing actions at narrow widths. Unknown or active delivery locks destructive/duplicate actions and offers Check status for its original Run. After a confirmed Rebuild retires that Run, Remove becomes available with copy explaining that only the Pact queue is cleared and delivery remains unconfirmed; Edit, Steer and Resume remain locked. An empty disabled queue still exposes Enable queue. Use the existing Composer popover treatment, keyboard menu navigation, Escape/focus return and both themes. Edit removes the item and returns its full content to the normal Composer, overwriting its draft; no Save/Cancel edit mode is introduced. A return receipt needing recovery uses a quiet Restore returned message action outside the queue.

Steer supplements divide one Run into full response snapshots. Preserve prior bubbles while responding; new output follows the latest supplement. Work Log stays at the Run's original output position while responding. Completion moves it into the final answer and resets it collapsed, even if previously expanded or being read; an explicit click can reopen it. Once normal completion and the complete canonical body are ready, automatically hide intermediate snapshots and leave all User inputs followed by the final answer. Do not add an Earlier responses or manual snapshot-collapse button. Exact Comment source navigation remains available through bounded history. Jump to latest appears only when newer history is available; snapshot preservation and expansion are not history gaps. Source synchronization and mounted context/body rows retain the existing transcript budgets.

Composer permission, Project-folder and branch popovers share one presentation: raised surface, neutral hairline border, one subtle shadow (6px downward offset, 18px blur, 18% black), 14px radius, 8px padding, 12px text, 8px action-row corners and the same Hover/focus treatment. Use a title, actions and a divided footer for supplementary context; complete selectable paths and branch names live in that footer. All use the permission menu's 160ms opening/110ms closing motion with reduced-motion support. Width and alignment follow the content and trigger; do not introduce a separate background or shadow treatment for these menus. The registered folder opens with `Open in Finder` on macOS and `Show in Explorer` on Windows. Keyboard navigation must retain the chosen item when the asynchronous popover toggle arrives. Native attention and exit confirmation hide composer popovers; returning restores the permission trigger focus. Suspended image previews and Fork dialogs retain their selected image, form state and focused control.

### Artifact, Diff, and Review

The right panel is contextual, resizable and closable. Diff uses dedicated add/remove tokens in both themes and becomes nearly opaque under translucency. Documents preserve comfortable prose measure; Comments retain a visible anchor without obscuring code.

The current full plan is read only in Context's Plan tab. Plan headers expose Expand/Restore beside Close. The Plan pane resizes within the available workspace without a percentage cap or document-width ceiling. In-app expansion keeps the same document, scroll position, Conversation owner and Comment state mounted; its Comment editor and attached drafts remain usable inside the expanded pane. Restoring returns them to the Composer without sending or discarding drafts. Chat preserves complete natural replies and review reports, with a compact footer for the native plan version, review state and next action. Avoid a second full plan or a separate structured-feedback disclosure. A native plan with no ordinary answer still has its compact source/footer and opens the saved plan document. Current Implement, Respond, Repair, Continue collaboration and failure actions remain visible independently of historical folding. Proposal actions do not include a Pause collaboration button.

The context pane contains Plan, files, Changes and Session settings; findings and author responses live in natural review reports. Native question, form and browser-authorization cards use the same InputReplacement location as workflow decisions, taking priority while their native operation is waiting. Their scrollable content keeps submission and cancellation reachable. Do not add a separate draft-retention caption or Stop row beneath the native card. Ordinary draft state stays mounted and inert until the native request clears, then the workflow decision or ordinary Composer resumes. Tool-approval cards retain their transcript placement. Native question forms present actual provider choices and free input, preserve keyboard/focus/cancellation behavior, and do not create shared task rows or persistent answer chips. Recommendations remain labels rather than submitted answers.

Historical plans and reports retain their exact source/version; unsupported old anchors show their saved quote and an unavailable reason without reopening removed workflow UI. Navigation waits for body readiness before alignment, restores exact source focus, and does not reset reading position on refresh. Internal UUIDs, hashes, JSON fields and transport instructions do not belong in visible product prose.

During authorized automatic collaboration, show the responsible Agent and concise current step. User Send immediately pauses later handoffs; the current root normally finishes, then the priority reply remains paused. When a completed reply requires a user decision, its question card replaces the ordinary Composer. Show each explicit prompt, unselected choices when supplied, and a labelled free-answer field; do not infer questions from report prose. Send answers submits only the card answers to the verified requesting Agent. Sent replies show the frozen @recipient beside You, a separate reply heading, and numbered question blocks with selected answers on their own lines. Stop interrupts the current response and pauses collaboration while preserving sent answers and ordinary drafts. Keep the ordinary message draft, images, Comments, Skills, route and returned-input receipts intact and unsent. The reusable InputReplacement component owns the shared input location, a 220ms height transition with a 140ms fade, focus handoff and inert inactive panels. Reduced motion removes height/movement and keeps a brief opacity cue. Its two panels, one ResizeObserver, one animation and one exit-retention timer are disposed on unmount. Processing keeps a compact answer status in this location with Stop and existing recovery/queue controls; ordinary message input returns only after the decision gate clears. Failed or uncertain work retains recovery and never silently opens a new-message path. When the current plan requires recovery, replace an existing decision form with a neutral Plan recovery required state. Keep its answers and ordinary drafts intact, and use the existing Proposal recovery action. Do not show question or answer-processing copy for this recovery state. Older requests retain an expandable original-text entry and a free-answer field inside the card. Result footers distinguish requests for input, processed replies and ordinary review responses using that Run's stored facts. Use a neutral muted surface, a thin neutral border and a monochrome conversation icon; routine input requests are not operational warnings. Successful Send dismisses this prompt immediately; failed Send preserves it. Queue/progress/recovery use their existing surfaces. Only a new decision request shows the prompt again. Hide Continue and the next-review suggestion until the reply is confirmed processed; then show Continue collaboration with its computed next step. Keep Stop separate from pausing future work. At Session limits, show the specific exhausted allowance and retain the plan/report rather than implying failure erased it. Native form answers continue the existing root while any independent automation pause remains visible. Restart preserves a paused continuation and the original unknown-work recovery action; no hidden automatic peer restart or generic approval banner is introduced.

Image preview is a native modal with previous/next, directional keys, bounded filmstrip, close/Escape and trigger focus return. It fits content without zoom/Fit/100% controls. Its 180ms slide/fade honors reduced motion. Recovery uses one compact card for affected Agents, with currently valid action and specific reason rather than stacked warnings or repeated safety paragraphs.

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
fully exited development instances still start through `pnpm dev`.

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
- **Don't** use gradients, 3D illustration, giant typography, or 32px marketing-card radii in product UI.
- **Don't** let wallpaper reduce Diff, terminal, permission, or body-text contrast.
- **Don't** treat Agent color as the only provenance cue.
- **Don't** draw one-off inline SVG icons when Lucide provides the control or state symbol.
