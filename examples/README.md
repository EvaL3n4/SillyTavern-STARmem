# examples/

Standalone HTML documents for design reference. Not loaded by the
extension at runtime. Open in a browser to view.

| File | Purpose |
|---|---|
| `identity-mockup.html` | Phase 16 visual identity reference ("Quiet Library"). Renders viewer × episodic, viewer × traces, settings, indicator at target visual fidelity. Eyeball gate for cosmetic tasks. |

## Viewing notes

- Open `identity-mockup.html` directly in any modern browser
  (`file:///path/to/identity-mockup.html` works—no server needed).
- The viewer in the first section auto-plays its entrance reveal on
  load (~600ms staged: header fade-up → tab underline draw → body
  fade-in). **Wait for it to settle before judging visual fidelity**;
  during the reveal the body intentionally starts at `opacity: 0`.
- Click `↻ replay reveal` next to the page header to re-trigger the
  animation.
- To verify reduced-motion respect, enable
  `prefers-reduced-motion: reduce` in your browser's accessibility
  settings and reload—the reveal animation and indicator pulse should
  both stop.

