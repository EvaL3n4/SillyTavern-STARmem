# Phase 16 T4 — deferred follow-ups

T4 (visual identity pass) shipped at commit `3450916` on 2026-04-30 after four
iteration rounds. Eva approved the commit but flagged two cosmetic gaps that
are out of scope for T4 and should be addressed in later Phase 16 tasks or
deferred to a Phase 17 polish pass.

## 1. Settings panel is unstyled

The Quiet Library token system was applied to the Memory Viewer shell, but the
settings panel (`#starmem-settings-container`, mounted in
`#extensions_settings2`) still uses Phase 15 styling — none of the new tokens
(`--starmem-font-display`, `--starmem-space-*`, `--starmem-elev-*`,
`--starmem-radius-*`) reached it.

**Root cause:** T4's scope was deliberately limited to viewer-shell rules
(plan lines 1505–1514). The settings panel was tagged for **T7** in the
original plan: "T7 successor — settings panel layout."

**What needs doing:**
- Apply the same token surface to `.starmem-settings-*` rules in `style.css`
- Specificity bump if needed (the settings panel mounts inside ST's
  `.drawer-content`, which has its own cascade context — check before
  prefixing with `.starmem-settings-container .starmem-settings-X`)
- The form-control reset done in T4 round 3 was scoped to `.starmem-viewer`
  only; settings panel form fields will need an analogous block (see
  `sillytavern-extension-popup-css-cascade` skill, Trap 5)

**Where it lives:** Phase 16 T7 (already on the roadmap).

## 2. Uneven Memory Viewer tab layouts

The five tabs (Working, Episodic, Persona, Graph, Traces) render with
inconsistent heights and spacing inside the viewer body:

- **Working** uses `<ol class="starmem-viewer-working-list">` with
  `.starmem-viewer-working-item` rows
- **Episodic** uses a different list structure (per `tabs/episodic.js`)
- **Persona** uses `.starmem-viewer-empty` placeholder + rebuild form
- **Graph** uses `.starmem-viewer-graph-canvas` with fixed dimensions
- **Traces** uses `.starmem-viewer-trace` rows with expandable details

T4 normalized the **shell** (header, tabs, filter row, body container) but
each tab's internal layout remains ad-hoc from earlier phases. Visible
differences in row heights, vertical spacing between entries, and
top-of-tab padding when switching tabs.

**What needs doing:**
- Define a shared layout primitive (e.g. `.starmem-viewer-row` with
  consistent `padding: var(--starmem-space-3) var(--starmem-space-4)` and
  `border-bottom: 1px solid var(--starmem-border-faint)`)
- Audit each tab's content rendering and migrate to the shared primitive
- Pin a Playwright assertion that switching tabs doesn't shift the body's
  scroll position or content top by more than ±N px

**Where it lives:** Could be folded into T6 (episodic tab visual treatment)
as a normalization pass, or split off as a new T6.5 / Phase 17 item.
Recommend: deferring to a Phase 17 polish pass since each existing tab
task (T5/T6/T7) is already scoped to one surface.

## Deferred to:

- Phase 16 T7 — settings panel layout (item 1)
- Phase 17 polish pass or T6 normalization scope — tab layout consistency (item 2)

These notes also belong in the Phase 16 retro at T10. Re-surface there.
