# Experience and visual system

Use this reference for product/UI design, prototypes, front-end implementation, or visual review. Preserve the workbench grammar while naming every module and action from the target product brief.

## Product posture

The target is a dense, desktop-class workbench: dark-first, flat, fast, information-rich, and calm. It is not a card-heavy admin dashboard or a marketing site.

- Fill the application window and keep scrolling inside panes; avoid page-level scrolling.
- Compose continuous panes with 1 px dividers. Do not use gradients, oversized whitespace, decorative illustration cards, or shadows on ordinary workspace surfaces.
- Use a quiet blue for focus, selection, and primary actions. Reserve stronger semantic colors for status.
- Keep frequent actions visible and compact. Reveal secondary row actions on `hover` and `focus-within`.
- Let users resize important panes, clamp unsafe sizes, and persist the result.

## Workbench shell

Start with these measurements when the brief does not require another layout. Treat them as a coherent baseline, not arbitrary independent constants.

| Region | Baseline | Behavior |
| --- | ---: | --- |
| Custom title/context bar | 40 px | Brand/product context, window drag area, global controls |
| Primary action bar | 40 px | Compact, task-oriented actions and filters |
| Left navigation/tree | 240 px | Resizable from 180 px to 40% of the window |
| Main upper pane | 45% height | Primary overview/data surface; minimum about 160 px |
| Main lower pane | Remaining height | Detail, inspection, or editing; minimum about 260 px |
| Lower work column | 384 px | Resizable task/editor column beside a flexible detail pane |
| Compact editor within that column | 176 px high | Resizable and removable when the target flow does not need it |
| Optional bottom console/activity pane | 240 px | Resizable from 96 px to 65% of the window |
| Status bar | 24 px | Persistent global state and compact diagnostics |

Use a default desktop window near 1280 x 800 with a minimum near 900 x 600. Verify the finished UI at 1440 x 900. A new product may use fewer or differently named panes, but preserve the grammar `navigation + primary workspace + contextual detail + optional activity console + status bar` when it fits the brief.

Separators are 1 px in the border color with a 7 px effective hit target. On hover or drag they become `primary` at about 75% opacity. Add `role="separator"`, orientation, keyboard support where practical, and suppress text selection only during dragging. Store sizes under the new product's own keys.

For a multi-pane workbench, prefer a single persistent shell and conditional domain panels. Add routing only when the product truly has distinct destinations with independent URLs or navigation history.

## Semantic color tokens

Expose tokens as CSS custom properties and map Tailwind utilities to them. Components should consume semantic names rather than literal brand colors.

Dark baseline:

```css
:root {
  --background: 220 13% 9%;
  --foreground: 220 18% 89%;
  --card: 220 13% 12%;
  --card-foreground: 220 18% 89%;
  --popover: 220 13% 14%;
  --popover-foreground: 220 18% 89%;
  --primary: 217 91% 60%;
  --primary-foreground: 220 20% 98%;
  --secondary: 220 12% 16%;
  --secondary-foreground: 220 18% 89%;
  --muted: 220 12% 15%;
  --muted-foreground: 220 8% 62%;
  --accent: 220 12% 19%;
  --accent-foreground: 220 18% 94%;
  --destructive: 0 63% 55%;
  --destructive-foreground: 220 20% 98%;
  --border: 220 10% 23%;
  --input: 220 10% 25%;
  --ring: 217 91% 60%;
  --radius: 0.3rem;
}
```

Light baseline:

```css
.light {
  --background: 220 18% 97%;
  --foreground: 220 18% 16%;
  --card: 0 0% 100%;
  --card-foreground: 220 18% 16%;
  --popover: 0 0% 100%;
  --popover-foreground: 220 18% 16%;
  --primary: 217 83% 53%;
  --primary-foreground: 0 0% 100%;
  --secondary: 220 16% 94%;
  --secondary-foreground: 220 18% 20%;
  --muted: 220 16% 95%;
  --muted-foreground: 220 8% 47%;
  --accent: 220 16% 91%;
  --accent-foreground: 220 18% 18%;
  --destructive: 0 72% 51%;
  --destructive-foreground: 0 0% 100%;
  --border: 220 14% 87%;
  --input: 220 14% 84%;
  --ring: 217 83% 53%;
}
```

Apply semantic status consistently:

- `primary` blue: selection, focus, active filters, and the main CTA.
- `emerald`: success, availability, addition, or positive direction.
- `rose`/`destructive`: errors, destructive actions, removal, or negative direction.
- `amber`: warnings, unsaved state, attention, or pending work.
- `muted`: metadata, secondary copy, inactive actions.
- Purple, violet, sky, or teal may distinguish categories, but must not redefine success or failure.

When a new brand supplies a palette, remap these semantic roles and verify contrast in both themes. Do not replace role names with arbitrary color names.

## Typography and density

- Default UI font: Inter followed by platform and CJK sans-serif fallbacks.
- Separate monospace stack for code, paths, identifiers, logs, and machine-readable values.
- Base UI size: 12 px. Most dense labels use 10, 11, or 12 px.
- Section heading: 10 px, weight 700, `0.06em` tracking, uppercase where the locale supports it.
- Pane heading and toolbar label: usually 11 px. Toolbar button height: 26 px. Icon button: 24 x 24 px.
- Common spacing: 4, 6, 8, 12, and 16 px. Use larger spacing only for real hierarchy.
- Support a user font-size range near 11-20 px. Scale rem-based and fixed 9/10/11/12 px utilities together so compact labels do not ignore the setting.
- Apply the stored font, size, and theme before mounting the UI to avoid a flash of incorrect styling.

## Component language

### Surfaces and controls

- Use flat `background`, `card`, and `muted` panes separated by borders. Remove ordinary box shadows from the workspace.
- Normal buttons, inputs, and textareas use about 3 px radius. Dialogs and popovers may use a larger radius because they are true floating layers.
- Use Lucide-style outline icons, normally 12-16 px. Every icon-only action needs a tooltip or accessible label.
- Hover uses `accent` or `secondary`; pressed may use a subtle `scale(0.95)`; disabled uses 40-50% opacity and blocks input.
- Use a clear 1 px `primary` focus ring. Never remove focus indication without an equivalent.

### Lists, trees, and tables

- Selected rows use `primary` at 10-15% opacity plus primary text, optionally with a 2 px leading marker.
- Long labels use `min-width: 0` and truncation; status icons and row actions do not shrink.
- Reveal secondary row actions on hover and focus-within, not hover alone.
- Keep row heights compact and consistent. Use indentation, disclosure icons, and separators rather than nested cards.
- Center an empty-state message in muted text. Add an action only when there is a clear next step; do not add decorative illustrations by default.

### Tabs, filters, and mode switches

- Tabs use compact labels with a 2 px primary bottom indicator.
- A small mode switch uses a low-contrast container with adjacent buttons; the active option raises background and foreground contrast.
- Loading belongs inside the triggering control when possible: replace its icon or label and disable duplicate submission.

### Dialogs and popovers

Use one dialog shell:

- Viewport overlay: black at roughly 60% plus a light backdrop blur.
- Dialog: `card` background, 1 px border, larger radius, bounded width and height.
- Header: about 44 px; scrollable body; footer: about 48 px with actions aligned to the logical end.
- Cancel is muted/ghost, primary submit is blue, destructive submit is rose.
- Close on Escape unless an irreversible operation is already committing. Trap focus, restore it to the opener, and add `role="dialog"`, `aria-modal="true"`, a labelled title, and accessible close control.
- Destructive or high-risk operations use the shared confirmation dialog; do not create bespoke warning markup in every feature.

### Forms and feedback

- Labels are 10-11 px, semibold, and muted. Inputs use the background surface, 1 px border, 6-8 px padding, and a primary focus ring.
- Use a two-column or fixed-label/flexible-field layout for related compact settings. Avoid a stack of large form cards.
- Toasts appear at the upper right with status icon, title, and optional detail. Errors use an assertive live region; ordinary status uses polite announcements.
- Important state must combine icon, text, and color. Provide inline validation near the field and a global error summary only when the scope warrants it.

## Internationalization and accessibility

Internationalization is part of the first implementation slice, not a cleanup task. GITBX's reference locale set is English, Japanese, German, Spanish, Simplified Chinese, Traditional Chinese, French, and Arabic, with English as fallback. Honor a narrower or different locale set from the target brief; use the full reference set only when the user asks for parity or leaves locale scope open. Keep the registry extensible and split messages by locale/domain instead of growing one giant file.

- All visible copy passes through the translation layer; no hard-coded fallback strings in components.
- Set document `lang` and `dir`. Arabic switches the whole shell to RTL; use logical CSS properties and logical action order.
- Provide locale-aware font fallbacks and verify truncation with long German, CJK, and Arabic strings.
- Custom clickable rows support Tab, Enter, and Space. Menus support arrow-key navigation where relevant.
- Dialogs manage focus. Separators expose orientation. Live updates announce meaningfully without flooding assistive technology.
- Do not rely on color alone, and respect reduced-motion settings.

## Visual acceptance matrix

Inspect at least one representative workflow at 1440 x 900 and at the minimum window size. Cover:

- Dark and light themes.
- LTR and Arabic RTL.
- Default and enlarged font size.
- Keyboard-only traversal, visible focus, dialog focus trap, and Escape behavior.
- Loading, empty, populated, warning, error, disabled, selected, hover, and focus states.
- Long labels and identifiers, narrow panes, resized panes, restart/persistence, and optional console open/closed.
- Zero page errors, failed resource requests, and severe console errors during the inspected flow.


