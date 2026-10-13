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
- **Warning Ochre** (`#946200` / `#e6b84a`): recoverable risk and pending decisions.
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

Translucent uses explicit transparent window backing and per-surface color overlays on macOS and supported Windows. macOS has no Vibrancy blur; Windows disables native backdrop material rather than using Mica. Do not set whole-window opacity. The UI shows a 0–100 **Transparency strength** scale (default 50, higher is more see-through), not a literal window-opacity percentage. It maps to stored `materialOpacity` 100–70 (default 85) and then to separate surface Alpha ranges:

- Sidebar: 55–90% in dark mode; light translucency uses a brighter ice-blue overlay fixed seven percentage points below Chat (65–90%) so it remains part of the same environment instead of turning gray or becoming fully opaque.
- Chat: 72–97%.
- Diff, terminal, and code: 94–99%.
- Message surfaces: 86–96%.
- Text, icons, code, and focus rings: always 100%.

macOS uses `transparent: true` with `#00000000` backing and no Vibrancy. Windows build 22621 or newer uses a frameless transparent window, native Window Controls Overlay and the same semantic Alpha layers, with background material set to `none`. Solid restores opaque theme backing. Unsupported platforms/builds, reduced transparency, high contrast/forced colors or observable initialization failure fall back to the complete Solid theme. Retain the requested preference and show a concise effective fallback reason. Renderer Alpha and successful API calls are not desktop-compositor evidence; inspect actual effects on each target platform. Verification is described in [Contributing](../../CONTRIBUTING.md#testing).

**The Legibility-before-Material Rule.** If desktop content competes with UI content, increase the local surface Alpha before adding blur, outline, or shadow.

## Shapes

Inputs, icon buttons, and code-adjacent controls use 8px. Message surfaces use 12px. The translucent outer window and genuinely detached panels may use 14px. Pills are reserved for short recipient and attachment chips; normal toolbar actions are not pills.

## Components

### Buttons

- **Primary:** charcoal with white text in light mode; pale inverse with dark text in dark mode.
- **Project actions:** New Session, Rename and Archive controls are hidden at rest and appear together on Project header Hover or `:focus-within`. Rename uses a 14px Pencil beside Archive. Session Archive also appears on Hover/focus. Archive uses a 14px icon inside a 28px hit area and acts directly; the existing Undo notice restores an archived item.
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

Fields use a dense local surface so their value remains stable over any native backdrop. Focus increases border contrast and adds the Iris focus outline. Disabled and error states retain readable values and recovery copy.

The Project name editor stays in its row: a 32px focused input group with 28px Check/X controls on the right, an Iris-tinted Save action and neutral Cancel. Select the current name on entry; Enter saves, Escape cancels, and blur keeps the draft. A failed save keeps the input and shows a local error; saving is visibly busy and cannot repeat. Names are trimmed, nonempty, single-line and limited to 120 UTF-16 units. The shell has no application fullscreen button or dedicated fullscreen Bridge.

### Navigation

Project ownership is expressed by disclosure, indentation, and grouping. Do not draw Project-to-Session connector lines. The selected Session uses a powder-blue or midnight-blue surface plus its title and state. Full path, branch, and repository status belong in a tooltip, context menu, or Project details—not the default tree.

### Transcript and Composer

User messages are right-aligned on lavender. Claude and Codex messages are left-aligned on peach and mint. Speaker labels remain visible, and ordinary messages avoid avatars that could be mistaken for account UI. Flow steps and runtime states may appear inline inside the responsible Agent message; global workflow timelines and `Plan approved` banners are not persistent Chat chrome.

The Composer is a stable dense surface at least two lines high. Native Skills and the selected route are atomic inline units; attached Comments and answers are removable source chips above the input. Images show thumbnails, filename and state, with Add image below full-width text. Send is the local action anchor and becomes Stop during an observed response, while editing the next draft remains available under normal gates. Do not auto-send that draft when the response ends.

### Artifact, Diff, and Review

The right panel is contextual, resizable and closable. Diff uses dedicated add/remove tokens in both themes and becomes nearly opaque under translucency. Documents preserve comfortable prose measure; Comments retain a visible anchor without obscuring code.

The current full plan is read only in Context's Plan tab. Transcript uses compact opaque version/review cards: title, total feedback count and one disclosure on a single header. Historical cards start closed; necessary Proposal, Resume and errors stay visible outside folded content. Do not duplicate the complete plan in Chat or add another nested Feedback disclosure.

Context's Todos tab shows Pending and Done with ordinary unboxed rows. One short state label distinguishes Open, Awaiting review and Done. A tick is status, not a user-editable checkbox; an accessible info control explains a Done disposition. Detail progressively reveals issue, impact, suggestion, evidence and handling. Questions/Comments use Add to comment/Cancel; all sending occurs through the Composer, without To selector or per-Todo Send. Recommendation is a separate label, never a submitted answer.

Historical sources show then-state and known current state without changing counts or exposing an answer entry for an old question. Navigation waits for body readiness before alignment, restores exact source focus, and does not reset reading position on refresh. Internal UUIDs, hashes, JSON fields and transport instructions do not belong in visible product prose.

Image preview is a native modal with previous/next, directional keys, bounded filmstrip, close/Escape and trigger focus return. It fits content without zoom/Fit/100% controls. Its 180ms slide/fade honors reduced motion. Recovery uses one compact card for affected Agents, with currently valid action and specific reason rather than stacked warnings or repeated safety paragraphs.

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
