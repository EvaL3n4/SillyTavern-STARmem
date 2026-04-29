# Phase 16—Public Ship: UI/UX Identity + Structural Survivors

> **For Hermes:** Use `subagent-driven-development` for tasks tagged `[structural]`.
> Controller-only for `[doc]`, `[gate]`, `[public-ship]`.
> Hybrid (controller drafts, subagent dispatches one-at-a-time, **strict serial**) for `[cosmetic]`.

**Goal:** Ship STARmem v2.0 publicly with a designed UI, the structural survivors from the Phase 15 rescope (T4 trace events, T5 tier label honesty, T9 viewer ARIA), and complete public-ship hygiene (README, CHANGELOG, install doc, repo metadata).

**Architecture:**
- Visual identity is drafted **once** as an HTML mockup (Task 1) under the `frontend-design` skill's "pick one and execute" rule. Eva eyeballs the mockup as a **gate** (per Phase 15 lesson 3.2). Per-component cosmetic tasks land against the approved mockup—no exploratory cosmetic work after the gate fires.
- Per-task acceptance criteria are tagged `[structural] / [cosmetic] / [doc] / [gate] / [public-ship]`. Structural tasks ship on tests-pass. Cosmetic tasks ship on eyeball + Playwright smoke. Independent verdicts.
- Tokens: STARmem inherits ST color tokens (`var(--SmartTheme*)`) but **defines its own** spacing, typography, elevation, radius, and motion tokens. Layout/density/rhythm is ours; user theme picks (Catppuccin etc.) still reach color.

**Tech Stack:** ES2022 modules, vanilla CSS (no preprocessor), Playwright for cosmetic smoke, jest + tsc + eslint for structural guards. No new runtime deps. Devdep additions: none planned.

---

## Decisions locked before writing this plan (conversation 2026-04-29)

1. **Phase scope.** All six survivors (T4 / T5 / T6 / T7 / T8 / T9) **plus** a custom visual identity pass and a public-ship pass. Phase 15 retro's "do not re-attempt T6/T7/T8" lesson is amended (Task 0): valid for an internal-use extension; reversed for a public-ship one.
2. **Visual direction: "Quiet Library."** Editorial-leaning literary archive aesthetic. STARmem is where a roleplay's memories live; the surface feels like a careful reading room, not a control panel. Serif display face for headers/tab labels/episodic subjects/section titles; inherited body font for content; monospace for tier badges + raw JSON. One memorable moment: 600ms staged viewer-open reveal (header → tab underline draw → body fade). Otherwise quiet.
3. **Eyeball-as-gate (not smoke).** Task 1 produces an HTML mockup at `examples/identity-mockup.html` showing all four major surfaces (viewer × 3 tabs, settings, indicator). Eva verdicts before any per-component cosmetic task is dispatched. Plan revisions after the verdict are cheap; cosmetic-task collapse mid-phase is expensive (Phase 15).
4. **Per-task tags + independent acceptance.** `[structural]` ships on green tests. `[cosmetic]` ships on Eva approve + Playwright smoke green. `[doc] / [public-ship]` ship on Eva approve. A cosmetic-task failure cannot block a structural ship.
5. **Token strategy.** Color: inherit ST tokens via `var(--SmartTheme*, fallback)` (unchanged). Spacing / typography / elevation / radius / motion: define our own under `--starmem-*` namespace. Phase 15 already laid `--starmem-overlay`, `--starmem-bg-elevated`, `--starmem-danger`; Phase 16 expands this token surface meaningfully.
6. **Public-ship pass with reference clone.** Task 0.5 clones MoonlitEchoes (or a comparable popular ST extension) into `/tmp/` for reference, files `docs/research/extension-install-conventions.md` capturing the install/README shape; Task 9 calibrates ours against it. Manifest + package.json bump from `2.0.0-dev` to `2.0.0`. README rewrite. CHANGELOG from scratch. `docs/install.md`. One screenshot in repo. GitHub repo description + topics (Eva runs the gh commands; plan provides the exact text).
7. **Playwright assertion per cosmetic task.** Each cosmetic task adds 1–2 sanity assertions (presence, ARIA role, computed property like `.classList.contains('starmem-X')`, `.style.borderRadius` non-empty)—never pixel snapshots. Keeps the harness compounding without flake.
8. **Plan size + execution mode.** Target ~1800 lines, 11 tasks. Strict serial dispatch—**no parallel subagent work**. Controller drives `[doc]`, `[gate]`, `[public-ship]`; subagents drive `[structural]`; controller drafts then subagent-dispatches `[cosmetic]` one task at a time, with eyeball verdict between each. Eva owns Task 1 mockup verdict and Task 9 GitHub repo metadata commands.
9. **Out-of-scope restated.** Not in this phase: pixel-perfect snapshot tests (deferred to v2.1 if appetite); Storybook or component playground (overkill for 4 surfaces); custom font loading from CDN (use system serif stack); animated SVG illustrations (scope creep); v1-to-v2 migration (already cut by spec §11); analytics/telemetry of any kind.

---

## Task overview

| # | Tag | File(s) | What |
|---|---|---|---|
| 0 | `[doc]` | `docs/plans/phase-15-retro.md`, `docs/plans/ROADMAP.md`, this file | Retro amendment + ROADMAP forward pointer + Phase 16 plan commit |
| 0.5 | `[doc]` | `docs/research/extension-install-conventions.md`, `/tmp/MoonlitEchoes` (transient) | Clone reference extension; capture install/README conventions |
| 1 | `[gate]` | `examples/identity-mockup.html` | Visual identity mockup ("Quiet Library") → Eva verdicts |
| 2 | `[structural]` | `src/consolidation/consolidate.js`, `src/integration/viewer/tabs/traces.js`, tests | T4: Traces consolidation events |
| 3 | `[structural]` | `src/integration/viewer/tabs/traces.js`, tests | T5: Tier label honesty (post-Phase-14 ladder is `0/1/3/Floor`) |
| 4 | `[cosmetic]` | `style.css`, `src/integration/viewer/mount.js`, e2e | Visual identity pass—token system + viewer shell |
| 5 | `[cosmetic]` | `src/integration/indicator.js`, `style.css`, e2e | T6 successor: consolidation indicator |
| 6 | `[cosmetic]` | `src/integration/viewer/tabs/episodic.js`, `style.css`, e2e | T7 successor: episodic tab visual treatment |
| 7 | `[cosmetic]` | `src/integration/settingsPanel.js`, `style.css`, e2e | T8 successor: settings panel layout |
| 8 | `[structural]` | `src/integration/viewer/mount.js`, tests, e2e | T9: ARIA roles + keyboard navigation |
| 9 | `[public-ship]` | `manifest.json`, `package.json`, `README.md`, `CHANGELOG.md`, `docs/install.md`, `docs/screenshots/viewer.png` | Version bump + docs rewrite + screenshot + repo metadata |
| 10 | `[doc]` | `docs/plans/phase-16-retro.md`, `docs/plans/ROADMAP.md` | Retro + ROADMAP entry |

---

## Pre-flight (run once, before Task 0)

Per `phased-project-planning` Pitfall 8 (preflight signature audit on session resume):

```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
git status -sb                                  # Expected: ## main...origin/main, clean
git log --oneline -3                            # Expected top commit: 351561a docs(plans): close phase 15 early
npm test 2>&1 | grep -E "^Test Suites|^Tests:" # Baseline: 98 suites / 974 tests
npm run lint 2>&1 | tail -5                     # Baseline: clean
npm run typecheck 2>&1 | tail -5                # Baseline: clean
```

If any of those are off, stop and resync before starting.

---

## Task 0: Plan commit + Phase 15 retro amendment + ROADMAP forward pointer

**Tag:** `[doc]`—controller-only.

**Objective:** Lock the reframe: Phase 15's "host visual ceiling = corncob" verdict was correct under internal-use constraints; public ship inverts the calculus. Land the amendment + plan + ROADMAP forward pointer in a single commit so future readers see the reframe before stumbling on the dropped-T6/T7/T8 verdict.

**Files:**
- Create: `docs/plans/phase-16-public-ship.md` (this file, already drafted)
- Modify: `docs/plans/phase-15-retro.md` (append amendment subsection)
- Modify: `docs/plans/ROADMAP.md` (append forward-pointer to Phase 15 entry; do NOT rewrite history—layer the reframe)

**Step 1: Append amendment to `phase-15-retro.md`**

After §5 ("v2.1 candidates filed from Phase 15"), before "**End of retro.**", insert:

```markdown
---

## 6. Amendment 2026-04-29—host-ceiling lesson is conditional on use mode

The §3.3 lesson ("Visual ceilings are real and host-imposed") and the §4
prohibition ("Do not re-attempt T6/T7/T8") were correct under the framing
in effect when this retro was written: STARmem as a private internal tool,
where polish-fighting-host-ceiling is corncob work because no one outside
the author sees the result.

**Public ship inverts the calculus.** The extension installer experiences
STARmem's surface *as the product*, not as "ST with a corner that doesn't
matter." First impressions of a public release weight visual quality high
enough that the ceiling argument no longer dominates. Phase 16 (`docs/plans/phase-16-public-ship.md`)
re-opens T6/T7/T8 as cosmetic tasks under a custom visual identity ("Quiet
Library") and ships the public-readiness pass alongside.

**The amended lesson.** *Visual ceilings are real and host-imposed—
**conditional on whether the extension's surface is part of its product**.
For internal-use extensions, default to inheriting and skip cosmetic work.
For public-ship extensions, the cosmetic acceptance criterion is part of
the product, not corncob.* The Phase 15 plan was right to drop the work
**at the time it was drafted**. The Phase 16 plan is right to revive it
**under the new framing**.

The structural deliverables Phase 15 shipped (Playwright harness, JS color
guard, CSS token audit) remain load-bearing for Phase 16: the harness
extends with cosmetic-task assertions; the guard prevents regressions
during identity work; the token discipline scales to spacing/type/motion.

The §3.1 lesson ("Don't bundle structural work with cosmetic work as a
single phase") still holds and is enforced more rigorously in Phase 16
via per-task `[structural] / [cosmetic] / [doc] / [gate] / [public-ship]`
tags with independent acceptance criteria.

**End of amendment.**
```

**Step 2: Append forward-pointer to ROADMAP Phase 15 entry**

In `docs/plans/ROADMAP.md`, after the Phase 15 closing line (`**Phase 15 closes as honest structural work.** Phase 16+ inherits the test substrate and theme-contract discipline this phase laid down.`) and before the `---` separator, insert:

```markdown

**Forward note (2026-04-29):** Public-ship reframe—T6/T7/T8 reopened under custom visual identity in Phase 16 (`docs/plans/phase-16-public-ship.md`). Host-ceiling lesson amended as conditional on internal-vs-public use mode. See `phase-15-retro.md` §6.
```

**Step 3: Verify counts**

```bash
wc -l docs/plans/phase-16-public-ship.md       # Expected: ~1800 (allow ±200)
grep -c "^## Task " docs/plans/phase-16-public-ship.md  # Expected: 11 (Task 0 through Task 10)
grep -n "## 6. Amendment" docs/plans/phase-15-retro.md   # Expected: one hit
grep -n "Forward note" docs/plans/ROADMAP.md             # Expected: one hit
```

**Step 4: Commit**

```bash
git add docs/plans/phase-16-public-ship.md docs/plans/phase-15-retro.md docs/plans/ROADMAP.md
git commit -m "docs(plans): phase 16 plan + phase 15 retro amendment (P16 T0)

Public-ship reframe: T6/T7/T8 reopened under custom visual identity.
Phase 15's host-ceiling lesson amended as conditional on internal-vs-public
use mode. Plan covers identity pass, six survivors (T4/T5/T6/T7/T8/T9),
and public-ship hygiene (manifest bump, README, CHANGELOG, install doc)."
```

**Done-when:**
- [ ] `docs/plans/phase-16-public-ship.md` committed at this repo root
- [ ] `phase-15-retro.md` §6 amendment landed
- [ ] ROADMAP Phase 15 entry has forward-note line
- [ ] `git log --oneline -1` shows the P16 T0 commit
- [ ] Working tree clean

---

## Task 0.5: Reference-extension clone + install conventions doc

**Tag:** `[doc]`—controller-only.

**Objective:** Capture how popular ST extensions structure their install instructions, README, and repo metadata, so Task 9's public-ship pass calibrates against community norms instead of inventing them. MoonlitEchoes by RivelleDays is the canonical reference (Eva's pick); fall back to whatever has high install counts on the ST extension list if that one is unreachable.

**Files:**
- Transient: `/tmp/extension-references/MoonlitEchoes/` (clone, do not commit)
- Create: `docs/research/extension-install-conventions.md`

**Step 1: Clone the reference**

```bash
mkdir -p /tmp/extension-references
cd /tmp/extension-references
git clone --depth 1 https://github.com/RivelleDays/SillyTavern-MoonlitEchoesTheme.git MoonlitEchoesTheme 2>&1 | tail -3
# If that URL 404s, try:
#   git clone --depth 1 https://github.com/RivelleDays/MoonlitEchoes.git MoonlitEchoes
# If still 404, fall back to a search on the ST extension list and pick a top-installed one.
```

**Step 2: Inspect the structure**

```bash
cd /tmp/extension-references/MoonlitEchoes
ls -la
cat README.md 2>/dev/null | head -100
cat manifest.json 2>/dev/null
test -f CHANGELOG.md && head -40 CHANGELOG.md
test -d docs && ls docs/
test -d screenshots && ls screenshots/ || (test -d assets && ls assets/)
```

Capture: README structure (sections, headings, screenshot placement, install block shape), manifest.json fields (especially `version`, `requires`, `homePage`, `auther`/`author` typo conventions ST sometimes accepts), CHANGELOG format if present, screenshot directory convention, license file, badge usage.

**Step 3: File the conventions doc**

Create `docs/research/extension-install-conventions.md` with sections:

```markdown
# SillyTavern Extension Install Conventions

> Reference notes for STARmem's public-ship pass (Phase 16 Task 9). Captured
> from MoonlitEchoes (RivelleDays) and other community extensions on
> 2026-04-29. Not normative—STARmem deviates where the deviation is honest
> (e.g. our 8K+ LOC + benchmarking surface justifies a richer docs/ tree
> than a typical UI-only extension).

## 1. Reference extension

- **Name:** MoonlitEchoes
- **Author:** RivelleDays
- **URL:** <captured>
- **Install count signal:** <screenshot-of-popularity-or-skip>

## 2. README anatomy

| Section | MoonlitEchoes | STARmem default | Action for Task 9 |
|---|---|---|---|
| Hero / banner | ... | absent | adopt or skip |
| One-line description | ... | present | keep |
| Screenshot | ... | absent | **add** |
| Install instructions | ... | absent | **add** |
| Features / capabilities | ... | partial | expand |
| Configuration | ... | absent | **add** if non-trivial |
| Compatibility / requires | ... | absent | **add** (we're an interceptor + viewer; ST version matters) |
| FAQ / troubleshooting | ... | absent | skip in v2.0 |
| License | present | present | keep |
| Credits / citations | absent | present | keep (we cite papers—that's our identity) |

## 3. Install instructions shape

The community-standard install block looks like:

```
1. In SillyTavern, click the Extensions icon (puzzle piece).
2. Click "Install Extension" at the top right.
3. Paste this URL: https://github.com/EvaL3n4/SillyTavern-STARmem
4. Click "Install".
```

(Adjust to match the actual reference once captured. Some extensions
include a "from local source" path with `git clone` into
`public/scripts/extensions/third-party/`. Phase 16 will include both since
STARmem's per-AGENTS.md install discipline is git-clone-based.)

## 4. manifest.json conventions

Fields observed across reference extensions:

- `display_name`—human-readable, can include emoji
- `loading_order`—integer, default 100
- `requires`—array of feature flags ST exposes
- `optional`—array of soft requirements
- `version`—semver, no `-dev` suffix on shipped releases
- `homePage`—repo URL
- `author`—string

Our manifest.json: <pull current state, list what we have vs reference>.

## 5. CHANGELOG conventions

Most ST extensions don't ship CHANGELOGs. We're choosing to because:
- v2 is a clean break from v1 (per spec §11)
- Phases 0–15 represent ~6 weeks of substantive work the public release
  should narrate at a high level
- Future releases benefit from a structured changelog from day one

Format: Keep a Changelog 1.1.0 conventions, semver headings, ISO dates.

## 6. Screenshot conventions

- **Location:** `docs/screenshots/` (our convention; ST extensions vary)
- **Format:** PNG, ~1200px wide max
- **Subject:** the most-distinctive surface (Memory Viewer, since that's
  where the design work concentrates)
- **Linked from:** README hero area
- **Capture method:** Playwright `page.screenshot()` against a fixture
  state with realistic-looking data (not "Loading…")

## 7. Repo metadata (gh CLI)

```bash
gh repo edit EvaL3n4/SillyTavern-STARmem --description "<one-line description>"
gh repo edit EvaL3n4/SillyTavern-STARmem --add-topic sillytavern
gh repo edit EvaL3n4/SillyTavern-STARmem --add-topic memory
gh repo edit EvaL3n4/SillyTavern-STARmem --add-topic roleplay
gh repo edit EvaL3n4/SillyTavern-STARmem --add-topic llm
gh repo edit EvaL3n4/SillyTavern-STARmem --add-topic extension
```

Eva runs these (Task 9). Plan provides the exact strings.

## 8. Deviations from convention STARmem will keep

- **Citation-heavy README.** Most ST extensions don't cite papers; we do
  because the project's identity is academic-grounded. Keep.
- **`docs/specs/` and `docs/wiki/`.** Most extensions don't have these.
  We do because spec compliance is structurally enforced. Keep.
- **`docs/plans/` and `docs/bench/`.** Most extensions don't ship dev
  process artifacts. We do because the phased plan + benchmark substrate
  is part of the project's discipline. Keep—they're a feature, not
  noise, for technically-curious installers.

## 9. Deviations from convention STARmem will adopt

- **Screenshot in README.** We don't have one. Most polished extensions
  do. Adopt in Task 9.
- **Explicit install block.** Currently absent from our README. Adopt.
- **Version without `-dev` suffix on release.** Currently `2.0.0-dev`.
  Bump to `2.0.0` in Task 9.
```

**Step 4: Commit + cleanup**

```bash
git add docs/research/extension-install-conventions.md
git commit -m "docs(research): extension install conventions reference (P16 T0.5)

Capture how popular ST extensions structure README, install instructions,
manifest, and repo metadata. Reference: MoonlitEchoes (RivelleDays).
Phase 16 Task 9 calibrates STARmem's public-ship pass against this doc."

# Clean up the transient clone (don't commit it)
rm -rf /tmp/extension-references
```

**Done-when:**
- [ ] `docs/research/extension-install-conventions.md` exists, has all 9 sections, references real captured data (not placeholders)
- [ ] `/tmp/extension-references/` cleaned up
- [ ] Commit landed on main
- [ ] Working tree clean

---

## Task 1: Visual identity mockup—"Quiet Library" (eyeball gate)

**Tag:** `[gate]`—controller-only. **Eva verdicts before any cosmetic task is dispatched.**

**Objective:** Produce one self-contained HTML file rendering all four cosmetic surfaces (viewer × 3 representative tabs, settings panel, indicator) at the target visual fidelity. Eva opens it in a browser, judges it, and either approves (cosmetic tasks proceed) or sends it back for revision (cheap to redraw at this stage; expensive to rewrite per-component cosmetic work later).

This is the lesson 3.2 fix: schedule the eyeball as a **gate** at Task 1, not a smoke at Task N.

**Visual direction recap:**

> **"Quiet Library."** Editorial-leaning literary archive aesthetic. STARmem is where a roleplay's memories live; the surface feels like a careful reading room, not a control panel. Serif display face for headers/tab labels/episodic subjects/section titles; inherited body font for content; monospace for tier badges + raw JSON. One memorable moment: 600ms staged viewer-open reveal (header → tab underline draw → body fade). Otherwise quiet. Color palette inherits ST tokens via `var(--SmartTheme*)` so user themes still reach color; spacing/type/elevation/radius/motion are STARmem's own.

**Frontend-design skill checkpoints:**
- ✅ Direction picked and committed to (editorial; not mixed with playful or industrial)
- ✅ Visual system planned: type hierarchy, color via inheritance, spacing rhythm, layout logic, motion (one memorable moment, otherwise quiet), surface treatment (subtle shadow + paper-like elevation, not heavy)
- ✅ Composition: viewer uses asymmetry (subject filter aligns left, tab strip aligns right; episodic subjects break the grid via hanging indents)
- ✅ Anti-patterns avoided: no SaaS hero pattern, no card grid pile, no random accent colors, motion serves hierarchy not decoration

**Files:**
- Create: `examples/identity-mockup.html` (self-contained—no external deps, no JS framework, vanilla everything)
- Create: `examples/.gitignore` (empty placeholder if needed)—actually, examples/ is committed
- Create: `examples/README.md` (one paragraph: what this is, how to view it)

**Step 1: Author the mockup HTML**

Create `examples/identity-mockup.html` with:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>STARmem—Quiet Library identity mockup</title>
  <style>
    /* --- ST token simulation (eyeball-mode only; real install inherits from ST) --- */
    :root {
      --SmartThemeBodyColor: #e8e6df;
      --SmartThemeEmColor: #a8a59a;
      --SmartThemeBlurTintColor: #1c1b18;
      --SmartThemeBorderColor: #3a3833;
      --SmartThemeQuoteColor: #c4a87c;
      --SmartThemeShadowColor: rgba(0, 0, 0, 0.4);
    }

    /* --- STARmem tokens (Phase 16 surface; Task 4 lands the real ones in style.css) --- */
    :root {
      /* Color (inherited from ST, with literary-reading fallbacks) */
      --starmem-fg: var(--SmartThemeBodyColor, #e8e6df);
      --starmem-fg-muted: var(--SmartThemeEmColor, #a8a59a);
      --starmem-bg: var(--SmartThemeBlurTintColor, #1c1b18);
      --starmem-bg-elevated: color-mix(in srgb, var(--SmartThemeBodyColor) 5%, var(--SmartThemeBlurTintColor));
      --starmem-bg-paper: color-mix(in srgb, var(--SmartThemeBodyColor) 8%, var(--SmartThemeBlurTintColor));
      --starmem-border: var(--SmartThemeBorderColor, #3a3833);
      --starmem-border-faint: color-mix(in srgb, var(--SmartThemeBorderColor) 50%, transparent);
      --starmem-accent: var(--SmartThemeQuoteColor, #c4a87c);
      --starmem-overlay: rgba(0, 0, 0, 0.55);
      --starmem-danger: #c66c5a;

      /* Typography—Quiet Library: serif display, inherited body, monospace for data */
      --starmem-font-display: 'Iowan Old Style', 'Palatino Linotype', 'Palatino', 'URW Palladio L', 'Book Antiqua', Georgia, serif;
      --starmem-font-body: inherit; /* body inherits ST's font choice */
      --starmem-font-mono: ui-monospace, 'JetBrains Mono', 'Cascadia Code', Menlo, Consolas, monospace;
      --starmem-fs-display-1: 1.5rem;   /* viewer title */
      --starmem-fs-display-2: 1.125rem; /* section / subject heading */
      --starmem-fs-body: 0.9375rem;     /* 15px reading body */
      --starmem-fs-meta: 0.8125rem;     /* 13px metadata, badges */
      --starmem-fs-mono: 0.8125rem;     /* match meta size for alignment */
      --starmem-lh-tight: 1.25;
      --starmem-lh-reading: 1.55;       /* generous body leading; reading room feel */
      --starmem-tracking-display: -0.005em; /* subtle tightening on serif display */
      --starmem-tracking-meta: 0.04em;       /* slight track-out on small caps / labels */

      /* Spacing rhythm—4px base, 1.5× ratio for major steps */
      --starmem-space-1: 0.25rem;
      --starmem-space-2: 0.5rem;
      --starmem-space-3: 0.75rem;
      --starmem-space-4: 1rem;
      --starmem-space-5: 1.5rem;
      --starmem-space-6: 2.25rem;
      --starmem-space-7: 3.5rem;

      /* Elevation—paper-like, never glossy */
      --starmem-elev-0: none;
      --starmem-elev-1: 0 1px 0 var(--starmem-border-faint);
      --starmem-elev-2: 0 1px 2px rgba(0, 0, 0, 0.18), 0 0 0 1px var(--starmem-border-faint);
      --starmem-elev-3: 0 6px 24px rgba(0, 0, 0, 0.28), 0 0 0 1px var(--starmem-border);

      /* Radius—restrained; serif identity wants modest curves */
      --starmem-radius-1: 2px;
      --starmem-radius-2: 4px;
      --starmem-radius-3: 6px;

      /* Motion */
      --starmem-ease: cubic-bezier(0.2, 0, 0.1, 1);
      --starmem-dur-fast: 120ms;
      --starmem-dur-med: 280ms;
      --starmem-dur-slow: 600ms;
    }

    /* Reset for the mockup's own demo frame; STARmem itself doesn't reset globals */
    body {
      background: var(--starmem-bg);
      color: var(--starmem-fg);
      font-family: var(--starmem-font-body), system-ui, sans-serif;
      font-size: var(--starmem-fs-body);
      line-height: var(--starmem-lh-reading);
      margin: 0;
      padding: var(--starmem-space-6);
    }

    .demo-frame {
      max-width: 980px;
      margin: 0 auto;
      display: grid;
      gap: var(--starmem-space-7);
    }

    .demo-section-label {
      font-family: var(--starmem-font-display);
      font-size: var(--starmem-fs-meta);
      letter-spacing: var(--starmem-tracking-meta);
      text-transform: uppercase;
      color: var(--starmem-fg-muted);
      border-bottom: 1px solid var(--starmem-border-faint);
      padding-bottom: var(--starmem-space-2);
      margin-bottom: var(--starmem-space-4);
    }

    /* === STARmem viewer surface === */
    .starmem-viewer {
      background: var(--starmem-bg-elevated);
      border-radius: var(--starmem-radius-3);
      box-shadow: var(--starmem-elev-3);
      overflow: hidden;
    }

    .starmem-viewer-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      padding: var(--starmem-space-5) var(--starmem-space-6) var(--starmem-space-3);
      border-bottom: 1px solid var(--starmem-border-faint);
    }

    .starmem-viewer-title {
      font-family: var(--starmem-font-display);
      font-size: var(--starmem-fs-display-1);
      font-weight: 400;
      letter-spacing: var(--starmem-tracking-display);
      margin: 0;
      color: var(--starmem-fg);
    }

    .starmem-viewer-close {
      background: none;
      border: none;
      color: var(--starmem-fg-muted);
      font-size: 1.25rem;
      cursor: pointer;
      padding: var(--starmem-space-1) var(--starmem-space-2);
      transition: color var(--starmem-dur-fast) var(--starmem-ease);
    }
    .starmem-viewer-close:hover { color: var(--starmem-fg); }

    .starmem-viewer-filter-row {
      padding: var(--starmem-space-3) var(--starmem-space-6);
      border-bottom: 1px solid var(--starmem-border-faint);
      display: flex;
      align-items: center;
      gap: var(--starmem-space-3);
    }
    .starmem-viewer-filter-row label {
      font-size: var(--starmem-fs-meta);
      color: var(--starmem-fg-muted);
      letter-spacing: var(--starmem-tracking-meta);
      text-transform: uppercase;
    }
    .starmem-viewer-subject-input {
      background: var(--starmem-bg);
      border: 1px solid var(--starmem-border-faint);
      border-radius: var(--starmem-radius-1);
      color: var(--starmem-fg);
      padding: var(--starmem-space-2) var(--starmem-space-3);
      font: inherit;
      flex: 1;
      max-width: 320px;
      transition: border-color var(--starmem-dur-fast) var(--starmem-ease);
    }
    .starmem-viewer-subject-input:focus {
      outline: none;
      border-color: var(--starmem-accent);
    }

    .starmem-viewer-tabs {
      display: flex;
      gap: 0;
      padding: 0 var(--starmem-space-6);
      border-bottom: 1px solid var(--starmem-border-faint);
      background: var(--starmem-bg);
    }
    .starmem-viewer-tab {
      background: none;
      border: none;
      color: var(--starmem-fg-muted);
      font-family: var(--starmem-font-display);
      font-size: var(--starmem-fs-body);
      letter-spacing: var(--starmem-tracking-meta);
      padding: var(--starmem-space-3) var(--starmem-space-4);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: color var(--starmem-dur-fast) var(--starmem-ease),
                  border-color var(--starmem-dur-med) var(--starmem-ease);
    }
    .starmem-viewer-tab:hover { color: var(--starmem-fg); }
    .starmem-viewer-tab-active {
      color: var(--starmem-fg);
      border-bottom-color: var(--starmem-accent);
    }

    .starmem-viewer-body {
      padding: var(--starmem-space-5) var(--starmem-space-6);
      min-height: 280px;
    }

    /* === Episodic tab content (representative—Task 6 successor) === */
    .starmem-viewer-episodic {
      display: grid;
      gap: var(--starmem-space-5);
    }
    .starmem-viewer-episodic-subject-group {
      border-left: 2px solid var(--starmem-border-faint);
      padding-left: var(--starmem-space-4);
    }
    .starmem-viewer-episodic-subject {
      font-family: var(--starmem-font-display);
      font-size: var(--starmem-fs-display-2);
      font-weight: 400;
      color: var(--starmem-fg);
      margin: 0 0 var(--starmem-space-2);
      letter-spacing: var(--starmem-tracking-display);
    }
    .starmem-viewer-episodic-entry {
      padding: var(--starmem-space-2) 0;
      border-bottom: 1px dotted var(--starmem-border-faint);
      display: grid;
      grid-template-columns: 1fr auto;
      gap: var(--starmem-space-3);
      align-items: baseline;
    }
    .starmem-viewer-episodic-entry:last-child { border-bottom: none; }
    .starmem-viewer-episodic-content {
      font-size: var(--starmem-fs-body);
      line-height: var(--starmem-lh-reading);
    }
    .starmem-viewer-episodic-meta {
      font-family: var(--starmem-font-mono);
      font-size: var(--starmem-fs-mono);
      color: var(--starmem-fg-muted);
      white-space: nowrap;
    }

    /* === Traces tab content (representative—Task 2 + Task 3) === */
    .starmem-viewer-traces-list { list-style: none; padding: 0; margin: 0; }
    .starmem-viewer-traces-item {
      padding: var(--starmem-space-3) 0;
      border-bottom: 1px solid var(--starmem-border-faint);
    }
    .starmem-viewer-traces-summary {
      font-family: var(--starmem-font-mono);
      font-size: var(--starmem-fs-mono);
      color: var(--starmem-fg);
      line-height: var(--starmem-lh-tight);
    }
    .starmem-tier-badge {
      display: inline-block;
      padding: 0 var(--starmem-space-2);
      border: 1px solid var(--starmem-border-faint);
      border-radius: var(--starmem-radius-1);
      font-family: var(--starmem-font-mono);
      font-size: var(--starmem-fs-meta);
      color: var(--starmem-accent);
      margin-right: var(--starmem-space-2);
    }
    .starmem-tier-badge-event {
      color: var(--starmem-fg-muted);
      border-style: dashed;
    }

    /* === Settings panel (representative—Task 7 successor) === */
    .starmem-settings {
      background: var(--starmem-bg-elevated);
      border-radius: var(--starmem-radius-3);
      box-shadow: var(--starmem-elev-2);
      padding: var(--starmem-space-5) var(--starmem-space-6);
    }
    .starmem-settings-section {
      margin-bottom: var(--starmem-space-6);
    }
    .starmem-settings-section:last-child { margin-bottom: 0; }
    .starmem-settings-section-title {
      font-family: var(--starmem-font-display);
      font-size: var(--starmem-fs-display-2);
      font-weight: 400;
      margin: 0 0 var(--starmem-space-3);
      padding-bottom: var(--starmem-space-2);
      border-bottom: 1px solid var(--starmem-border-faint);
      letter-spacing: var(--starmem-tracking-display);
    }
    .starmem-settings-field {
      display: grid;
      grid-template-columns: 220px 1fr;
      gap: var(--starmem-space-4);
      align-items: center;
      padding: var(--starmem-space-2) 0;
    }
    .starmem-settings-label {
      font-size: var(--starmem-fs-body);
      color: var(--starmem-fg);
    }
    .starmem-settings-help {
      grid-column: 2;
      font-size: var(--starmem-fs-meta);
      color: var(--starmem-fg-muted);
      margin-top: var(--starmem-space-1);
      font-style: italic;
    }
    .starmem-settings-field input[type="number"],
    .starmem-settings-field select {
      background: var(--starmem-bg);
      border: 1px solid var(--starmem-border-faint);
      border-radius: var(--starmem-radius-1);
      color: var(--starmem-fg);
      padding: var(--starmem-space-2) var(--starmem-space-3);
      font: inherit;
      max-width: 200px;
    }

    /* === Indicator (Task 5 successor) === */
    .starmem-indicator-mockup-row {
      display: flex;
      align-items: center;
      gap: var(--starmem-space-4);
      padding: var(--starmem-space-4);
      background: var(--starmem-bg-elevated);
      border-radius: var(--starmem-radius-2);
      box-shadow: var(--starmem-elev-1);
    }
    .starmem-indicator {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
    }
    .starmem-indicator-idle {
      background: var(--starmem-fg-muted);
      opacity: 0.4;
    }
    .starmem-indicator-busy {
      background: var(--starmem-accent);
      animation: starmem-indicator-pulse 1.4s var(--starmem-ease) infinite;
    }
    @keyframes starmem-indicator-pulse {
      0%, 100% { opacity: 0.4; transform: scale(1); }
      50% { opacity: 1; transform: scale(1.25); }
    }
    .indicator-label {
      font-family: var(--starmem-font-mono);
      font-size: var(--starmem-fs-meta);
      color: var(--starmem-fg-muted);
    }

    /* === Memorable moment: viewer entrance reveal === */
    .reveal-trigger {
      cursor: pointer;
      color: var(--starmem-accent);
      font-family: var(--starmem-font-mono);
      font-size: var(--starmem-fs-meta);
    }
    .starmem-viewer.is-revealing .starmem-viewer-header {
      animation: starmem-fade-up var(--starmem-dur-med) var(--starmem-ease) both;
    }
    .starmem-viewer.is-revealing .starmem-viewer-tab-active {
      animation: starmem-underline-draw var(--starmem-dur-slow) var(--starmem-ease) 280ms both;
    }
    .starmem-viewer.is-revealing .starmem-viewer-body {
      animation: starmem-fade-in var(--starmem-dur-med) var(--starmem-ease) 320ms both;
    }
    @keyframes starmem-fade-up {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes starmem-fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes starmem-underline-draw {
      from { border-image: linear-gradient(to right, var(--starmem-accent) 0%, transparent 0%) 1; border-bottom-color: transparent; }
      to { border-bottom-color: var(--starmem-accent); }
    }

    /* Reduced-motion respect (a11y default) */
    @media (prefers-reduced-motion: reduce) {
      .starmem-viewer.is-revealing .starmem-viewer-header,
      .starmem-viewer.is-revealing .starmem-viewer-tab-active,
      .starmem-viewer.is-revealing .starmem-viewer-body {
        animation: none;
      }
      .starmem-indicator-busy { animation: none; opacity: 1; }
    }
  </style>
</head>
<body>
<div class="demo-frame">

  <header>
    <h1 class="starmem-viewer-title" style="margin-bottom: var(--starmem-space-2)">STARmem—Quiet Library</h1>
    <p style="color: var(--starmem-fg-muted); margin: 0;">Visual identity mockup for Phase 16. Open this file in a browser; click <span class="reveal-trigger" id="replay">↻ replay reveal</span> to see the entrance animation.</p>
  </header>

  <section>
    <div class="demo-section-label">Memory Viewer · Episodic tab</div>
    <div class="starmem-viewer" id="viewer-mockup">
      <div class="starmem-viewer-header">
        <h2 class="starmem-viewer-title">Memory Viewer</h2>
        <button class="starmem-viewer-close" aria-label="Close">✕</button>
      </div>
      <div class="starmem-viewer-filter-row">
        <label for="subject-input">Subject</label>
        <input id="subject-input" class="starmem-viewer-subject-input" placeholder="(all subjects)" />
      </div>
      <nav class="starmem-viewer-tabs">
        <button class="starmem-viewer-tab">Working</button>
        <button class="starmem-viewer-tab starmem-viewer-tab-active">Episodic</button>
        <button class="starmem-viewer-tab">Persona</button>
        <button class="starmem-viewer-tab">Graph</button>
        <button class="starmem-viewer-tab">Traces</button>
      </nav>
      <div class="starmem-viewer-body">
        <div class="starmem-viewer-episodic">
          <div class="starmem-viewer-episodic-subject-group">
            <h3 class="starmem-viewer-episodic-subject">Alanis</h3>
            <div class="starmem-viewer-episodic-entry">
              <div class="starmem-viewer-episodic-content">Has a younger brother named Theo who is studying classical guitar in Vienna.</div>
              <div class="starmem-viewer-episodic-meta">imp·72 · 3d</div>
            </div>
            <div class="starmem-viewer-episodic-entry">
              <div class="starmem-viewer-episodic-content">Drinks black coffee in the morning, never after noon. Allergic to white rabbits in odd ways.</div>
              <div class="starmem-viewer-episodic-meta">imp·58 · 5d</div>
            </div>
            <div class="starmem-viewer-episodic-entry">
              <div class="starmem-viewer-episodic-content">Met the narrator at a bookstore on Reumannplatz, Vienna, in late autumn.</div>
              <div class="starmem-viewer-episodic-meta">imp·81 · 12d</div>
            </div>
          </div>
          <div class="starmem-viewer-episodic-subject-group">
            <h3 class="starmem-viewer-episodic-subject">Theo</h3>
            <div class="starmem-viewer-episodic-entry">
              <div class="starmem-viewer-episodic-content">Studies classical guitar at the Konservatorium. Currently learning Villa-Lobos études.</div>
              <div class="starmem-viewer-episodic-meta">imp·45 · 2d</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section>
    <div class="demo-section-label">Memory Viewer · Traces tab—with consolidation events (T4) and tier 0/1/3/Floor labels (T5)</div>
    <div class="starmem-viewer">
      <div class="starmem-viewer-header">
        <h2 class="starmem-viewer-title">Memory Viewer</h2>
        <button class="starmem-viewer-close" aria-label="Close">✕</button>
      </div>
      <div class="starmem-viewer-tabs">
        <button class="starmem-viewer-tab">Working</button>
        <button class="starmem-viewer-tab">Episodic</button>
        <button class="starmem-viewer-tab">Persona</button>
        <button class="starmem-viewer-tab">Graph</button>
        <button class="starmem-viewer-tab starmem-viewer-tab-active">Traces</button>
      </div>
      <div class="starmem-viewer-body">
        <ol class="starmem-viewer-traces-list">
          <li class="starmem-viewer-traces-item">
            <div class="starmem-viewer-traces-summary"><span class="starmem-tier-badge starmem-tier-badge-event">consolidate</span>13:47:02Z · 7 facts · 412ms · gpt-4o-mini</div>
          </li>
          <li class="starmem-viewer-traces-item">
            <div class="starmem-viewer-traces-summary"><span class="starmem-tier-badge">T3</span>13:46:55Z · relational · top=0.74 · "what does theo study"</div>
          </li>
          <li class="starmem-viewer-traces-item">
            <div class="starmem-viewer-traces-summary"><span class="starmem-tier-badge">T1</span>13:46:51Z · factual · top=0.91 · "alanis brother"</div>
          </li>
          <li class="starmem-viewer-traces-item">
            <div class="starmem-viewer-traces-summary"><span class="starmem-tier-badge">T0</span>13:46:50Z · factual · top=1.00 · "alanis brother"</div>
          </li>
          <li class="starmem-viewer-traces-item">
            <div class="starmem-viewer-traces-summary"><span class="starmem-tier-badge">Floor</span>13:42:11Z ·—· top=n/a · "(empty corpus)"</div>
          </li>
        </ol>
      </div>
    </div>
  </section>

  <section>
    <div class="demo-section-label">Settings panel</div>
    <div class="starmem-settings">
      <div class="starmem-settings-section">
        <h3 class="starmem-settings-section-title">Consolidation</h3>
        <div class="starmem-settings-field">
          <label class="starmem-settings-label" for="ext-buffer">Buffer size</label>
          <input id="ext-buffer" type="number" value="10" min="1" max="100">
          <p class="starmem-settings-help">Working buffer fills up before consolidation runs.</p>
        </div>
        <div class="starmem-settings-field">
          <label class="starmem-settings-label" for="ext-idle">Idle timeout (s)</label>
          <input id="ext-idle" type="number" value="60" min="10" max="600">
          <p class="starmem-settings-help">Consolidation also fires after this many seconds of silence.</p>
        </div>
      </div>
      <div class="starmem-settings-section">
        <h3 class="starmem-settings-section-title">Extraction model</h3>
        <div class="starmem-settings-field">
          <label class="starmem-settings-label" for="ext-profile">Connection profile</label>
          <select id="ext-profile"><option>OpenAI · gpt-4o-mini</option><option>Anthropic · claude-haiku</option></select>
          <p class="starmem-settings-help">Used during write-time fact extraction. Never on the query path.</p>
        </div>
      </div>
    </div>
  </section>

  <section>
    <div class="demo-section-label">Consolidation indicator</div>
    <div style="display: grid; gap: var(--starmem-space-3);">
      <div class="starmem-indicator-mockup-row">
        <span class="starmem-indicator starmem-indicator-idle"></span>
        <span class="indicator-label">starmem · idle</span>
      </div>
      <div class="starmem-indicator-mockup-row">
        <span class="starmem-indicator starmem-indicator-busy"></span>
        <span class="indicator-label">starmem · consolidating · last 13:47:02Z</span>
      </div>
    </div>
  </section>

</div>
<script>
  // Memorable moment: replay the entrance reveal on demand
  const viewer = document.getElementById('viewer-mockup');
  const replay = document.getElementById('replay');
  function reveal() {
    viewer.classList.remove('is-revealing');
    void viewer.offsetWidth;  // restart animation
    viewer.classList.add('is-revealing');
  }
  replay.addEventListener('click', reveal);
  // Auto-play once on first paint
  requestAnimationFrame(() => requestAnimationFrame(reveal));
</script>
</body>
</html>
```

**Step 2: Author the examples README**

```markdown
# examples/

Standalone HTML documents for design reference. Not loaded by the
extension at runtime. Open in a browser to view.

| File | Purpose |
|---|---|
| `identity-mockup.html` | Phase 16 visual identity reference ("Quiet Library"). Renders viewer × episodic, viewer × traces, settings, indicator at target visual fidelity. Eyeball gate for cosmetic tasks. |
```

**Step 3: Eva's eyeball verdict**

Open `examples/identity-mockup.html` in any modern browser. Verdict options:

- **Approve**—cosmetic tasks (4–7) proceed against this mockup. Token values, fonts, motion, spacing land into `style.css` in Task 4. Subsequent cosmetic tasks reuse them.
- **Approve with notes**—list specific changes (e.g. "subject heading too large", "indicator pulse too slow", "tab underline too thin"). Plan author patches the mockup, Eva re-verdicts, then proceeds.
- **Reject**—direction is wrong. Discuss alternative direction; redraft mockup; re-verdict. Cosmetic tasks blocked until approval.

**Step 4: Commit**

```bash
git add examples/identity-mockup.html examples/README.md
git commit -m "docs(examples): identity mockup—Quiet Library (P16 T1)

Visual identity gate for Phase 16 cosmetic tasks. Editorial-leaning
literary archive aesthetic; serif display, inherited body, monospace for
data; one memorable moment (staged viewer reveal); ST color tokens
inherited, spacing/type/elevation/radius/motion are STARmem's own.

Eva eyeballs this before any cosmetic task is dispatched."
```

**Done-when:**
- [ ] `examples/identity-mockup.html` renders in a browser without errors (devtools console clean)
- [ ] All four surfaces visible: viewer × episodic, viewer × traces (with consolidation event row + tier 0/1/3/Floor labels), settings panel, indicator (idle + busy)
- [ ] Memorable moment plays on load and on replay click
- [ ] `prefers-reduced-motion` honored (manual: enable in browser, reload, verify no animation)
- [ ] Eva eyeball verdict logged (approved / approved-with-notes / rejected)
- [ ] If approved-with-notes: notes patched into mockup before commit
- [ ] If rejected: this task does NOT commit; redraft and re-verdict
- [ ] Commit landed only after approval

---

## Task 2: T4—Memory Viewer Traces consolidation events

**Tag:** `[structural]`—subagent-friendly. Ships on green tests.

**Objective:** Surface consolidation runs in the Traces tab as a distinct row type. The trace shape was pre-scoped in Phase 15 plan Task 4: `{kind: 'consolidate', timestamp, chatId, summary: { factCount, scope }, durationMs, extractor}`. Wire `consolidate()` to push this entry onto `state.runtime.traces`; render it in `traces.js` with a distinguishing badge.

**Why this survives the rescope:** Real value for debugging consolidation issues—the user-facing artifact pairs retrievals and writes on a single timeline, makes "did consolidation run after that turn?" answerable in two glances.

**Files:**
- Modify: `src/consolidation/consolidate.js`—append a trace entry on success and on failure
- Modify: `src/integration/viewer/tabs/traces.js`—render `kind === 'consolidate'` rows distinctly
- Create: `tests/unit/consolidation/consolidate-trace.test.js`—pin trace-emission shape
- Create: `tests/unit/integration/viewer/traces-consolidation.test.js`—pin render shape
- Modify: `tests/integration/viewer/traces.test.js` if existing—extend mixed-kind ordering test

**Pre-flight (subagent runs first):**

```bash
# Verify the consolidate.js entry symbol still has the shape we plan against
mcp_jcodemunch_get_file_outline repo=local-SillyTavern-STARmem-036d3fcc file_path=src/consolidation/consolidate.js
mcp_jcodemunch_search_symbols repo=local-SillyTavern-STARmem-036d3fcc query="consolidate" detail_level=compact
mcp_jcodemunch_get_symbol_source repo=local-SillyTavern-STARmem-036d3fcc symbol_id="src/consolidation/consolidate.js::consolidate#function"
# Verify state.runtime.traces is the live shape
mcp_jcodemunch_search_text repo=local-SillyTavern-STARmem-036d3fcc query="runtime.traces" file_pattern="src/**/*.js"
# Verify tests/unit/integration/viewer/ structure exists
ls tests/unit/integration/viewer/ 2>&1
```

If `consolidate()`'s signature differs from `consolidate(chatId): Promise<void>`, stop and patch the plan first.

**Step 1: Trace shape—write the schema test first**

Create `tests/unit/consolidation/consolidate-trace.test.js`:

```javascript
import { jest } from '@jest/globals';
import { consolidate } from '../../../src/consolidation/consolidate.js';
import { loadState, persistState } from '../../../src/core/state.js';
// Mock the extractor: deterministic 2-fact return.
jest.unstable_mockModule('../../../src/consolidation/extractFacts.js', () => ({
    extractFacts: jest.fn(async () => [
        { content: 'fact A', subject: 'X', tags: [] },
        { content: 'fact B', subject: 'Y', tags: [] },
    ]),
}));

describe('consolidate emits trace entry', () => {
    const chatId = 'test-chat-trace';

    beforeEach(async () => {
        await persistState(chatId, {
            entries: [], edges: [],
            runtime: {
                traces: [],
                workingBuffer: [
                    { role: 'user', content: 'a', index: 0 },
                    { role: 'assistant', content: 'b', index: 1 },
                ],
                lastConsolidation: null,
                consolidating: false,
            },
        });
    });

    test('appends a {kind: "consolidate"} trace on success', async () => {
        await consolidate(chatId);
        const state = await loadState(chatId);
        const consolidateTraces = state.runtime.traces.filter(t => t.kind === 'consolidate');
        expect(consolidateTraces).toHaveLength(1);
        const t = consolidateTraces[0];
        expect(t).toMatchObject({
            kind: 'consolidate',
            chatId,
            timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
            summary: expect.objectContaining({ factCount: 2 }),
            durationMs: expect.any(Number),
            extractor: expect.any(String),
        });
        expect(t.durationMs).toBeGreaterThanOrEqual(0);
    });

    test('does not corrupt existing retrieval traces (interleaved order preserved)', async () => {
        const state = await loadState(chatId);
        state.runtime.traces.push({ kind: 'retrieve', timestamp: '2026-04-29T12:00:00Z', tierResolved: 0, query: 'pre-existing' });
        await persistState(chatId, state);
        await consolidate(chatId);
        const after = await loadState(chatId);
        expect(after.runtime.traces).toHaveLength(2);
        expect(after.runtime.traces[0].kind).toBe('retrieve');
        expect(after.runtime.traces[1].kind).toBe('consolidate');
    });

    test('respects ring-buffer cap (assumes existing logTrace cap)', async () => {
        const state = await loadState(chatId);
        // Fill near-cap
        for (let i = 0; i < 100; i++) {
            state.runtime.traces.push({ kind: 'retrieve', timestamp: new Date(Date.now() - i * 1000).toISOString(), tierResolved: 2, query: `q${i}` });
        }
        await persistState(chatId, state);
        await consolidate(chatId);
        const after = await loadState(chatId);
        expect(after.runtime.traces.length).toBeLessThanOrEqual(100);
        // Newest entry must be the consolidate trace
        expect(after.runtime.traces[after.runtime.traces.length - 1].kind).toBe('consolidate');
    });
});
```

**Step 2: Run—expect failure**

```bash
npm test -- tests/unit/consolidation/consolidate-trace.test.js 2>&1 | tail -20
# Expected: FAIL—no trace entry appended (or wrong shape)
```

**Step 3: Implement in `consolidate.js`**

Open `src/consolidation/consolidate.js`. Inside the `consolidate(chatId)` write-lock body, after the successful Working → Episodic write but before lock release, append:

```javascript
const startedAt = Date.now();
// ... existing logic that produces `extractedFacts` and uses `extractor` model name ...
// (append RIGHT BEFORE the function returns; the failure path appends in the catch)
const trace = {
    kind: 'consolidate',
    timestamp: new Date().toISOString(),
    chatId,
    summary: { factCount: extractedFacts.length, scope: 'episodic' },
    durationMs: Date.now() - startedAt,
    extractor: extractorName,
};
state.runtime.traces = state.runtime.traces || [];
state.runtime.traces.push(trace);
// Ring-buffer cap: enforce the existing TRACE_RING_CAP from constants if it exists,
// else cap at 100 (matches Phase 4 trace logger spec §9.1).
const cap = TRACE_RING_CAP ?? 100;
if (state.runtime.traces.length > cap) {
    state.runtime.traces.splice(0, state.runtime.traces.length - cap);
}
```

(Subagent: locate `extractorName` from the existing extractor invocation; if not named, derive from `connectionProfile?.name` or the equivalent shape used in this file. Do NOT hardcode a string.)

For the failure path: on caught error inside `consolidate()`, append a trace with `summary: { factCount: 0, scope: 'episodic', error: err.message }` before re-throwing or logging. Adjust the test if the failure-path shape differs from this proposal.

**Step 4: Run unit test—expect pass**

```bash
npm test -- tests/unit/consolidation/consolidate-trace.test.js 2>&1 | tail -10
# Expected: 3 passed
```

**Step 5: Render the new row type in `traces.js`**

Modify `src/integration/viewer/tabs/traces.js::buildTraceItem` to branch on `trace.kind`:

```javascript
function buildTraceItem(trace) {
    const li = document.createElement('li');
    li.className = `${CSS_PREFIX}-viewer-traces-item`;

    const summary = document.createElement('div');
    summary.className = `${CSS_PREFIX}-viewer-traces-summary`;

    if (trace.kind === 'consolidate') {
        const ts = trace.timestamp ? formatTimestamp(trace.timestamp) : '(no ts)';
        const facts = trace.summary?.factCount ?? '?';
        const dur = typeof trace.durationMs === 'number' ? `${trace.durationMs}ms` : '?';
        const ext = trace.extractor ?? '?';
        const errMark = trace.summary?.error ? ' · failed' : '';
        const badge = document.createElement('span');
        badge.className = `${CSS_PREFIX}-tier-badge ${CSS_PREFIX}-tier-badge-event`;
        badge.textContent = 'consolidate';
        summary.appendChild(badge);
        const text = document.createTextNode(`${ts} · ${facts} facts · ${dur} · ${ext}${errMark}`);
        summary.appendChild(text);
        li.appendChild(summary);

        // Raw details still available
        const details = document.createElement('details');
        details.className = `${CSS_PREFIX}-viewer-traces-details`;
        const sumEl = document.createElement('summary');
        sumEl.textContent = 'raw';
        details.appendChild(sumEl);
        const pre = document.createElement('pre');
        pre.className = `${CSS_PREFIX}-viewer-traces-raw`;
        pre.textContent = JSON.stringify(trace, null, 2);
        details.appendChild(pre);
        li.appendChild(details);
        return li;
    }

    // Retrieve (existing path)—note the badge addition for parity with Task 3
    const ts = trace.timestamp ? formatTimestamp(trace.timestamp) : '(no ts)';
    const cls = trace.classifier ?? '?';
    const tier = trace.tierResolved ?? '?';
    const top = getTopScore(trace);
    const query = truncate(trace.query ?? '', 60);
    const badge = document.createElement('span');
    badge.className = `${CSS_PREFIX}-tier-badge`;
    badge.textContent = formatTierLabel(tier);  // Task 3 introduces this helper
    summary.appendChild(badge);
    const text = document.createTextNode(`${ts} · ${cls} · top=${top !== null ? top.toFixed(2) : 'n/a'} · "${query}"`);
    summary.appendChild(text);
    li.appendChild(summary);

    const details = document.createElement('details');
    details.className = `${CSS_PREFIX}-viewer-traces-details`;
    const sumEl = document.createElement('summary');
    sumEl.textContent = 'raw';
    details.appendChild(sumEl);
    const pre = document.createElement('pre');
    pre.className = `${CSS_PREFIX}-viewer-traces-raw`;
    pre.textContent = JSON.stringify(trace, null, 2);
    details.appendChild(pre);
    li.appendChild(details);
    return li;
}
```

(The `formatTierLabel` helper lands in Task 3. Until then, inline a temporary `String(tier)` and the test for tier labeling won't fire. Sequence: Task 2 ships first; Task 3 immediately after replaces the inline.)

**Step 6: Render-shape test**

Create `tests/unit/integration/viewer/traces-consolidation.test.js`:

```javascript
import { jest } from '@jest/globals';
import { renderTab } from '../../../../src/integration/viewer/tabs/traces.js';

describe('traces tab renders consolidation events distinctly', () => {
    let parent;
    beforeEach(() => {
        parent = document.createElement('div');
        document.body.appendChild(parent);
    });
    afterEach(() => parent.remove());

    test('consolidate trace shows event badge + meta line', async () => {
        const ctx = {
            chatId: 'test',
            state: {
                runtime: {
                    traces: [{
                        kind: 'consolidate',
                        timestamp: '2026-04-29T13:47:02.000Z',
                        chatId: 'test',
                        summary: { factCount: 7, scope: 'episodic' },
                        durationMs: 412,
                        extractor: 'gpt-4o-mini',
                    }],
                },
            },
        };
        await renderTab(parent, ctx);
        const items = parent.querySelectorAll('.starmem-viewer-traces-item');
        expect(items).toHaveLength(1);
        const badge = items[0].querySelector('.starmem-tier-badge.starmem-tier-badge-event');
        expect(badge).not.toBeNull();
        expect(badge.textContent).toBe('consolidate');
        const summary = items[0].querySelector('.starmem-viewer-traces-summary');
        expect(summary.textContent).toContain('7 facts');
        expect(summary.textContent).toContain('412ms');
        expect(summary.textContent).toContain('gpt-4o-mini');
    });

    test('failed consolidate trace shows · failed marker', async () => {
        const ctx = {
            chatId: 'test',
            state: {
                runtime: {
                    traces: [{
                        kind: 'consolidate',
                        timestamp: '2026-04-29T13:47:02.000Z',
                        chatId: 'test',
                        summary: { factCount: 0, scope: 'episodic', error: 'extractor timeout' },
                        durationMs: 30000,
                        extractor: 'gpt-4o-mini',
                    }],
                },
            },
        };
        await renderTab(parent, ctx);
        const summary = parent.querySelector('.starmem-viewer-traces-summary');
        expect(summary.textContent).toContain('failed');
    });

    test('mixed kinds preserve order (newest at top of list)', async () => {
        const ctx = {
            chatId: 'test',
            state: {
                runtime: {
                    traces: [
                        { kind: 'retrieve', timestamp: '2026-04-29T13:46:55Z', tierResolved: 3, classifier: 'relational', query: 'q1' },
                        { kind: 'consolidate', timestamp: '2026-04-29T13:47:02.000Z', chatId: 'test', summary: { factCount: 2, scope: 'episodic' }, durationMs: 120, extractor: 'm' },
                    ],
                },
            },
        };
        await renderTab(parent, ctx);
        const items = parent.querySelectorAll('.starmem-viewer-traces-item');
        // Latest first per existing implementation
        expect(items[0].textContent).toContain('consolidate');
        expect(items[1].textContent).toContain('q1');
    });
});
```

**Step 7: Run all tests**

```bash
npm test 2>&1 | grep -E "^Test Suites|^Tests:"
# Expected: 100 suites / 977+ tests, all green
npm run lint 2>&1 | tail -3
npm run typecheck 2>&1 | tail -3
```

**Step 8: Commit**

```bash
git add src/consolidation/consolidate.js src/integration/viewer/tabs/traces.js \
        tests/unit/consolidation/consolidate-trace.test.js \
        tests/unit/integration/viewer/traces-consolidation.test.js
git commit -m "feat(traces): consolidation event rows in Memory Viewer (P16 T2)

T4 from Phase 15 plan, deferred to Phase 16. Trace shape per pre-scope:
{kind: 'consolidate', timestamp, chatId, summary: { factCount, scope,
error? }, durationMs, extractor}. Ring-buffer cap honored. Failed
consolidations append a trace with error marker.

Render: distinct dashed badge ('consolidate') vs solid-bordered tier
badges. Mixed-kind ordering preserved (latest first).

Closes Phase 15 candidate T4."
```

**Done-when:**
- [ ] Both new test files green
- [ ] Full suite green: `^Tests: \d+ passed`
- [ ] Lint clean, typecheck clean
- [ ] No new files outside the listed paths
- [ ] Commit landed

---

## Task 3: T5—Tier label honesty (post-Phase-14 ladder is `0/1/3/Floor`)

**Tag:** `[structural]`—subagent-friendly. Mechanical relabel + helper extraction.

**Objective:** Phase 14 demolished Tier 2 (always-seed-Tier-3 ladder). The traces tab still shows `T2` raw from `trace.tierResolved`—but the ladder no longer resolves at Tier 2. New labels: `T0 / T1 / T3 / Floor` (no `T2`). Add a `formatTierLabel(tier)` helper, route both `kind: 'retrieve'` and `kind: 'consolidate'` rendering through it, pin the labels in tests so future ladder changes can't silently drift the UI.

**Files:**
- Modify: `src/integration/viewer/tabs/traces.js`—extract `formatTierLabel`, replace inline tier rendering
- Create: `tests/unit/integration/viewer/traces-tier-labels.test.js`

**Pre-flight:**

```bash
# Confirm Tier 2 is gone from the ladder
mcp_jcodemunch_search_text repo=local-SillyTavern-STARmem-036d3fcc query="tier2|TIER_2|Tier 2" file_pattern="src/**/*.js"
# Expected: only constants/legacy mentions; no live ladder code references Tier 2
mcp_jcodemunch_get_file_outline repo=local-SillyTavern-STARmem-036d3fcc file_path=src/retrieval/ladder.js
# Verify Tier values 0/1/3 + 'floor' are the only resolved values
```

**Step 1: Failing test**

`tests/unit/integration/viewer/traces-tier-labels.test.js`:

```javascript
import { jest } from '@jest/globals';
import { formatTierLabel, renderTab } from '../../../../src/integration/viewer/tabs/traces.js';

describe('formatTierLabel—post-Phase-14 ladder honesty', () => {
    test('T0 / T1 / T3 are the only tier numbers', () => {
        expect(formatTierLabel(0)).toBe('T0');
        expect(formatTierLabel(1)).toBe('T1');
        expect(formatTierLabel(3)).toBe('T3');
    });

    test("'floor' renders as 'Floor'", () => {
        expect(formatTierLabel('floor')).toBe('Floor');
    });

    test('legacy T2 is renamed to T3 (Phase 14 backfill—Tier 2 demolished)', () => {
        expect(formatTierLabel(2)).toBe('T3');
    });

    test('null/undefined returns ?', () => {
        expect(formatTierLabel(null)).toBe('?');
        expect(formatTierLabel(undefined)).toBe('?');
    });

    test('renders T3 in the tab for any retrieve trace with tier=3', async () => {
        const parent = document.createElement('div');
        document.body.appendChild(parent);
        await renderTab(parent, {
            chatId: 'test',
            state: {
                runtime: {
                    traces: [{ kind: 'retrieve', timestamp: '2026-04-29T13:00:00Z', tierResolved: 3, classifier: 'relational', query: 'x' }],
                },
            },
        });
        const badge = parent.querySelector('.starmem-tier-badge');
        expect(badge.textContent).toBe('T3');
        parent.remove();
    });
});
```

**Step 2: Run—expect FAIL** (`formatTierLabel` is not exported yet)

```bash
npm test -- tests/unit/integration/viewer/traces-tier-labels.test.js 2>&1 | tail -10
```

**Step 3: Implement in `traces.js`**

Add to the file (export it):

```javascript
/**
 * Format a tier value for the tab UI.
 * Post-Phase-14 ladder: Tier 2 is demolished; legacy traces with
 * `tierResolved: 2` (pre-Phase-14) are backfilled to T3 honestly—
 * Phase 14 tier demolition collapsed seed-into-Tier-3, so a pre-demolition
 * "Tier 2 hit" was the same code path that today resolves at Tier 3.
 *
 * @param {0 | 1 | 2 | 3 | 'floor' | null | undefined} tier
 * @returns {'T0' | 'T1' | 'T3' | 'Floor' | '?'}
 */
export function formatTierLabel(tier) {
    if (tier === 0) return 'T0';
    if (tier === 1) return 'T1';
    if (tier === 2 || tier === 3) return 'T3';
    if (tier === 'floor') return 'Floor';
    return '?';
}
```

Replace the inline `formatTierLabel(tier)` placeholder from Task 2 with the real call. (Task 2's body already added the helper-call site; this task introduces the helper itself.)

**Step 4: Run all tests**

```bash
npm test 2>&1 | grep -E "^Test Suites|^Tests:"
# Expected: 101 suites / 982+ tests, all green
npm run lint 2>&1 | tail -3
npm run typecheck 2>&1 | tail -3
```

**Step 5: Commit**

```bash
git add src/integration/viewer/tabs/traces.js \
        tests/unit/integration/viewer/traces-tier-labels.test.js
git commit -m "feat(traces): tier label honesty post-Phase-14 demolition (P16 T3)

T5 from Phase 15 plan, deferred to Phase 16. formatTierLabel(tier)
extracted; legacy tier=2 traces (pre-Phase-14 demolition) backfill to
T3 since the seed-into-Tier-3 path is what historical Tier 2 hits
actually exercised. Test pins T0/T1/T3/Floor as the canonical UI labels.

Closes Phase 15 candidate T5."
```

**Done-when:**
- [ ] Tier label helper exported, all five test cases green
- [ ] Full suite green
- [ ] Lint + typecheck clean
- [ ] No `T2` string remains in `traces.js` UI output (grep: `grep -n '"T2"' src/integration/viewer/tabs/traces.js` → empty)
- [ ] Commit landed

---

## Task 4: Visual identity pass—token system + viewer shell

**Tag:** `[cosmetic]`—controller drafts, subagent dispatches. **Eyeball verdict gates next cosmetic task.**

**Objective:** Land the Quiet Library token system (spacing, typography, elevation, radius, motion) into `style.css`. Apply to the viewer shell (header, tabs, filter row, body container) and to the staged-reveal entrance animation. Subsequent cosmetic tasks (5/6/7) reuse these tokens—they don't re-introduce literals.

**Pre-req:** Task 1 mockup approved. If not approved, do not start this task.

**Files:**
- Modify: `style.css`—add the full token block, restyle viewer shell + tabs + filter row
- Modify: `src/integration/viewer/mount.js`—add `is-revealing` class on mount, remove after `--starmem-dur-slow` + buffer
- Create: `tests/integration/css-tokens-defined.test.js`—invariant: every `--starmem-*` token used in the codebase is also defined
- Modify: `tests/e2e/viewer.spec.js`—add 1 sanity assertion
- Modify: existing `tests/integration/no-hardcoded-colors.test.js` if needed (token-system additions shouldn't trip it; verify and adjust)

**Pre-flight:**

```bash
mcp_jcodemunch_get_file_outline repo=local-SillyTavern-STARmem-036d3fcc file_path=src/integration/viewer/mount.js
mcp_jcodemunch_search_text repo=local-SillyTavern-STARmem-036d3fcc query="--starmem-" file_pattern="**/*.css"
# Confirm current token surface (Phase 15: --starmem-fg, fg-muted, bg, bg-elevated, border, danger, overlay)
grep -n "^    --starmem-" style.css | head -20
```

**Step 1: Add the token system to `style.css`**

Append to the `:root` block (after the existing tokens), or restructure into a clearly-commented "Quiet Library" section:

```css
/* =========================================================================
 * Quiet Library tokens—Phase 16. Spacing/type/elevation/radius/motion are
 * STARmem's own; color tokens above inherit from ST themes.
 * ========================================================================= */
:root {
    /* Typography—serif display, inherited body, monospace for data */
    --starmem-font-display: 'Iowan Old Style', 'Palatino Linotype', 'Palatino',
                            'URW Palladio L', 'Book Antiqua', Georgia, serif;
    --starmem-font-body: inherit;
    --starmem-font-mono: ui-monospace, 'JetBrains Mono', 'Cascadia Code',
                         Menlo, Consolas, monospace;
    --starmem-fs-display-1: 1.5rem;
    --starmem-fs-display-2: 1.125rem;
    --starmem-fs-body: 0.9375rem;
    --starmem-fs-meta: 0.8125rem;
    --starmem-fs-mono: 0.8125rem;
    --starmem-lh-tight: 1.25;
    --starmem-lh-reading: 1.55;
    --starmem-tracking-display: -0.005em;
    --starmem-tracking-meta: 0.04em;

    /* Spacing—4px base, 1.5× ratio for major steps */
    --starmem-space-1: 0.25rem;
    --starmem-space-2: 0.5rem;
    --starmem-space-3: 0.75rem;
    --starmem-space-4: 1rem;
    --starmem-space-5: 1.5rem;
    --starmem-space-6: 2.25rem;
    --starmem-space-7: 3.5rem;

    /* Elevation—paper-like, never glossy */
    --starmem-border-faint: color-mix(in srgb, var(--SmartThemeBorderColor, #3a3a3a) 50%, transparent);
    --starmem-elev-0: none;
    --starmem-elev-1: 0 1px 0 var(--starmem-border-faint);
    --starmem-elev-2: 0 1px 2px rgba(0, 0, 0, 0.18), 0 0 0 1px var(--starmem-border-faint);
    --starmem-elev-3: 0 6px 24px rgba(0, 0, 0, 0.28), 0 0 0 1px var(--starmem-border);

    /* Radius—restrained */
    --starmem-radius-1: 2px;
    --starmem-radius-2: 4px;
    --starmem-radius-3: 6px;

    /* Motion */
    --starmem-ease: cubic-bezier(0.2, 0, 0.1, 1);
    --starmem-dur-fast: 120ms;
    --starmem-dur-med: 280ms;
    --starmem-dur-slow: 600ms;

    /* Bg variants—paper feel */
    --starmem-bg-paper: color-mix(in srgb, var(--SmartThemeBodyColor, #e8e8e8) 8%, var(--SmartThemeBlurTintColor, #1a1a1a));
    --starmem-accent: var(--SmartThemeQuoteColor, #c4a87c);
}
```

Then update viewer-shell rules. Replace existing `.starmem-viewer*` declarations (or add new ones if absent) so they use the tokens—copy the structure from `examples/identity-mockup.html`'s viewer block. Specifically:

- `.starmem-viewer`—`bg-elevated`, `radius-3`, `elev-3`, `overflow: hidden`
- `.starmem-viewer-header`—flex / baseline / `space-5 space-6 space-3` padding / `1px solid border-faint` bottom
- `.starmem-viewer-title`—`font-display`, `fs-display-1`, weight 400, `tracking-display`
- `.starmem-viewer-close`—bare button, muted color, hover transitions to fg
- `.starmem-viewer-filter-row`—`space-3 space-6` padding, flex, baseline-aligned label
- `.starmem-viewer-subject-input`—bg, `border-faint`, `radius-1`, focus border to accent
- `.starmem-viewer-tabs`—`0 space-6` padding, `1px solid border-faint` bottom
- `.starmem-viewer-tab`—`font-display`, `tracking-meta`, transparent border-bottom, color/border transitions
- `.starmem-viewer-tab-active`—`accent` underline, `fg` color
- `.starmem-viewer-body`—`space-5 space-6` padding, min-height for empty states

**Step 2: Add the staged-reveal animation to `style.css`**

```css
/* Memorable moment—staged viewer-open reveal (600ms total) */
.starmem-viewer.is-revealing .starmem-viewer-header {
    animation: starmem-fade-up var(--starmem-dur-med) var(--starmem-ease) both;
}
.starmem-viewer.is-revealing .starmem-viewer-tab-active {
    animation: starmem-underline-draw var(--starmem-dur-slow) var(--starmem-ease) 280ms both;
}
.starmem-viewer.is-revealing .starmem-viewer-body {
    animation: starmem-fade-in var(--starmem-dur-med) var(--starmem-ease) 320ms both;
}
@keyframes starmem-fade-up {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
}
@keyframes starmem-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
}
@keyframes starmem-underline-draw {
    from { border-bottom-color: transparent; }
    to { border-bottom-color: var(--starmem-accent); }
}

/* a11y respect */
@media (prefers-reduced-motion: reduce) {
    .starmem-viewer.is-revealing .starmem-viewer-header,
    .starmem-viewer.is-revealing .starmem-viewer-tab-active,
    .starmem-viewer.is-revealing .starmem-viewer-body {
        animation: none;
    }
}
```

**Step 3: Wire the reveal class in `mount.js`**

Inside `openViewer()`, after the root is appended to its parent (just before `return state;`), add:

```javascript
// Memorable moment: staged entrance reveal. Class drives keyframe animations
// in style.css; honored unless prefers-reduced-motion is set.
root.classList.add('starmem-is-revealing');
// Cleanup so re-renders don't re-animate (post slow + small buffer)
setTimeout(() => root.classList.remove('starmem-is-revealing'), 900);
```

(Naming note: mockup used `is-revealing` without prefix; production scope must be prefixed `starmem-` per the no-leaky-css invariant. Update the CSS rule selectors above accordingly: `.starmem-viewer.starmem-is-revealing` instead of `.starmem-viewer.is-revealing`.)

**Step 4: Token-defined invariant test**

`tests/integration/css-tokens-defined.test.js`:

```javascript
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('every --starmem-* token used is also defined in style.css', () => {
    const css = readFileSync(resolve(process.cwd(), 'style.css'), 'utf8');

    test('every var(--starmem-X) reference resolves to a definition', () => {
        const used = new Set();
        const re = /var\(\s*(--starmem-[a-z0-9-]+)/gi;
        let m;
        while ((m = re.exec(css))) used.add(m[1]);

        const defined = new Set();
        const defRe = /^\s*(--starmem-[a-z0-9-]+)\s*:/gm;
        let d;
        while ((d = defRe.exec(css))) defined.add(d[1]);

        const missing = [...used].filter(u => !defined.has(u));
        expect(missing).toEqual([]);
    });

    test('Quiet Library token surface is present', () => {
        const required = [
            '--starmem-font-display', '--starmem-font-body', '--starmem-font-mono',
            '--starmem-fs-display-1', '--starmem-fs-display-2', '--starmem-fs-body',
            '--starmem-fs-meta', '--starmem-fs-mono',
            '--starmem-space-1', '--starmem-space-7',
            '--starmem-elev-1', '--starmem-elev-3',
            '--starmem-radius-1', '--starmem-radius-3',
            '--starmem-ease', '--starmem-dur-fast', '--starmem-dur-med', '--starmem-dur-slow',
            '--starmem-accent',
        ];
        for (const tok of required) {
            expect(css).toContain(`${tok}:`);
        }
    });
});
```

**Step 5: Playwright sanity assertion**

Append to `tests/e2e/viewer.spec.js` (a new test, not replacing existing):

```javascript
test('viewer shell uses Quiet Library serif display face for title', async ({ page }) => {
    await openViewer(page);
    const title = page.locator('.starmem-viewer-title').first();
    await expect(title).toBeVisible();
    const fontFamily = await title.evaluate(el => getComputedStyle(el).fontFamily);
    // Serif stack—first font is Iowan Old Style; downstream fallbacks are all serif.
    // Match anywhere in the stack to handle host font availability differences.
    expect(fontFamily.toLowerCase()).toMatch(/iowan|palatino|palladio|book antiqua|georgia|serif/);
});
```

(Adjust `openViewer(page)` helper invocation to match the harness's existing patterns. If the harness doesn't have a helper, inline the open-viewer dispatch.)

**Step 6: Run all checks**

```bash
npm test 2>&1 | grep -E "^Test Suites|^Tests:"
# Expected: 102 suites / 985+ tests, all green
npm run lint 2>&1 | tail -3
npm run typecheck 2>&1 | tail -3
# E2E only if local ST is running:
test -n "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8000 2>/dev/null | grep -E '^[23]')" \
  && npm run test:e2e 2>&1 | tail -10 \
  || echo "ST offline—skipping e2e (will run in CI / pre-ship)"
```

**Step 7: Eva eyeball verdict—applied identity**

Have Eva install the extension into a local ST and open the Memory Viewer. Verdict against the mockup:
- Does the rendered viewer match the mockup's overall feel?
- Is the staged reveal smooth (not janky)?
- Is `prefers-reduced-motion` honored when toggled?
- Any token values that look wrong at real-render scale (size? weight? line-height?)?

Approve / approve-with-notes / reject. If rejected, do not commit; iterate until approved.

**Step 8: Commit (only after approval)**

```bash
git add style.css src/integration/viewer/mount.js \
        tests/integration/css-tokens-defined.test.js \
        tests/e2e/viewer.spec.js
git commit -m "style(viewer): Quiet Library token system + staged reveal (P16 T4)

Visual identity pass per Task 1 mockup verdict. Token surface adds
typography (display/body/mono fonts + sizes), spacing rhythm, paper-like
elevation, restrained radius, motion (fast/med/slow + ease).

Viewer shell: serif display face (Iowan Old Style stack) on title and
tab labels, accent-color tab underline, paper elevation on the modal
shell. Memorable moment: 600ms staged entrance (header fade-up → tab
underline draw → body fade). prefers-reduced-motion honored.

Token-defined invariant test prevents future drift between use sites
and definitions. Playwright sanity asserts the serif stack reaches the
title's computed style. Token namespace is unprefixed-by-history except
for is-revealing → starmem-is-revealing (no-leaky-css invariant)."
```

**Done-when:**
- [ ] All `--starmem-*` tokens used in style.css have definitions (test green)
- [ ] Full suite green
- [ ] Lint + typecheck clean
- [ ] E2E sanity assertion green (or noted as offline-skipped)
- [ ] Eva eyeball verdict logged: approved
- [ ] No raw color literals introduced (existing `no-hardcoded-colors` test still green)
- [ ] Commit landed

---

## Task 5: T6 successor—consolidation indicator visual treatment

**Tag:** `[cosmetic]`—controller drafts, subagent dispatches.

**Pre-req:** Task 4 approved + landed.

**Objective:** Apply Quiet Library tokens to the indicator. Idle = subtle muted dot at 0.4 opacity. Busy = accent-colored dot with a 1.4s gentle pulse (scale 1 → 1.25, opacity 0.4 → 1, ease, infinite). `prefers-reduced-motion` reduces busy state to a static accent dot. Tooltip uses display font for the title text.

**Files:**
- Modify: `src/integration/indicator.js`—no behavior change, only docstring tweak if needed
- Modify: `style.css`—replace existing `.starmem-indicator-*` rules with token-driven versions
- Modify: `tests/e2e/indicator.spec.js`—add 1 sanity assertion

**Step 1: Style the indicator**

Replace existing indicator CSS in `style.css`:

```css
/* Consolidation indicator—quiet by default, gently pulses while busy */
#starmem-indicator,
.starmem-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    position: absolute;
    bottom: var(--starmem-space-2);
    right: var(--starmem-space-2);
    transition: background var(--starmem-dur-med) var(--starmem-ease),
                opacity var(--starmem-dur-med) var(--starmem-ease);
}
.starmem-indicator-idle {
    background: var(--SmartThemeEmColor, #a0a0a0);
    opacity: 0.4;
}
.starmem-indicator-busy {
    background: var(--starmem-accent);
    animation: starmem-indicator-pulse 1.4s var(--starmem-ease) infinite;
}
.starmem-indicator-floating {
    position: fixed;
    bottom: var(--starmem-space-4);
    right: var(--starmem-space-4);
    z-index: 1000;
}
@keyframes starmem-indicator-pulse {
    0%, 100% { opacity: 0.4; transform: scale(1); }
    50%      { opacity: 1;   transform: scale(1.25); }
}
@media (prefers-reduced-motion: reduce) {
    .starmem-indicator-busy { animation: none; opacity: 1; }
}
```

**Step 2: Playwright sanity**

Append to `tests/e2e/indicator.spec.js`:

```javascript
test('busy indicator uses accent color', async ({ page }) => {
    // Force-set runtime.consolidating = true via test-only injection or fixture state
    await setConsolidatingFixture(page, true);
    const dot = page.locator('#starmem-indicator');
    await expect(dot).toHaveClass(/starmem-indicator-busy/);
    const bg = await dot.evaluate(el => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(bg).not.toBe('transparent');
});
```

(`setConsolidatingFixture` shape depends on how harness injects state; refer to existing `tests/e2e/fixtures/`. If absent, file as: open viewer → use a `_setConsolidatingForTests` window export, or skip the test until a fixture exists. The structural shape—assert busy class + non-transparent bg—is the load-bearing part.)

**Step 3: Eyeball verdict**

Open ST → trigger consolidation (e.g. paste 12 message turns to fill the buffer) → watch the indicator transition idle → busy → idle. Verdict against mockup. Approve / iterate.

**Step 4: Commit (post-approval)**

```bash
git add style.css tests/e2e/indicator.spec.js
git commit -m "style(indicator): Quiet Library treatment—accent pulse (P16 T5)

T6 successor from Phase 15 plan. Idle: muted 0.4-opacity dot. Busy:
accent-colored 1.4s gentle pulse (opacity + scale). Reduced-motion
respected. Tokens reused from Task 4."
```

**Done-when:**
- [ ] Indicator CSS uses tokens, not literals (verify with `no-hardcoded-colors` test)
- [ ] Eyeball verdict: approved
- [ ] E2E sanity green (or skipped with reason)
- [ ] Full suite + lint + typecheck green
- [ ] Commit landed

---

## Task 6: T7 successor—episodic tab visual polish

**Tag:** `[cosmetic]`—controller drafts, subagent dispatches.

**Pre-req:** Task 4 approved + landed.

**Objective:** Apply Quiet Library to the episodic tab. Group entries by subject; each subject is a serif display heading with a hanging-indent left border (literary feel). Entries within a group: dotted-border separators, content-left + monospace meta-right grid, generous reading line-height. Empty state uses the same token system instead of generic muted text.

**Files:**
- Modify: `src/integration/viewer/tabs/episodic.js`—restructure rendering to grouped-by-subject
- Modify: `style.css`—add `.starmem-viewer-episodic-*` rules
- Modify: `tests/unit/integration/viewer/episodic.test.js`—pin grouping + meta shape
- Modify: `tests/e2e/viewer.spec.js`—add 1 sanity assertion for episodic tab

**Pre-flight:**

```bash
mcp_jcodemunch_get_symbol_source repo=local-SillyTavern-STARmem-036d3fcc symbol_id="src/integration/viewer/tabs/episodic.js::renderTab#function"
# Confirm current entry shape: { id, subject, content, lifecycle: { importance, createdAt }, ... }
mcp_jcodemunch_search_text repo=local-SillyTavern-STARmem-036d3fcc query="lifecycle.importance" file_pattern="src/**/*.js"
```

**Step 1: Restructure `episodic.js` rendering**

Replace the current rendering body (after the loading guard, after the `entries` projection) with grouped-by-subject:

```javascript
// Group entries by subject (preserving insertion order)
const groups = new Map();
for (const e of entries) {
    const subj = e.subject || '(unsubjected)';
    if (!groups.has(subj)) groups.set(subj, []);
    groups.get(subj).push(e);
}

const root = document.createElement('div');
root.className = `${CSS_PREFIX}-viewer-episodic`;

if (groups.size === 0) {
    const empty = document.createElement('p');
    empty.className = `${CSS_PREFIX}-viewer-empty`;
    empty.textContent = 'No episodic memories yet. They appear after consolidation runs.';
    root.appendChild(empty);
    parent.appendChild(root);
    return;
}

for (const [subject, subjectEntries] of groups) {
    const group = document.createElement('div');
    group.className = `${CSS_PREFIX}-viewer-episodic-subject-group`;
    const heading = document.createElement('h3');
    heading.className = `${CSS_PREFIX}-viewer-episodic-subject`;
    heading.textContent = subject;
    group.appendChild(heading);

    for (const entry of subjectEntries) {
        const row = document.createElement('div');
        row.className = `${CSS_PREFIX}-viewer-episodic-entry`;

        const content = document.createElement('div');
        content.className = `${CSS_PREFIX}-viewer-episodic-content`;
        content.textContent = entry.content || '';
        row.appendChild(content);

        const meta = document.createElement('div');
        meta.className = `${CSS_PREFIX}-viewer-episodic-meta`;
        const imp = entry.lifecycle?.importance ?? '?';
        const age = formatAge(entry.lifecycle?.createdAt);
        meta.textContent = `imp·${imp} · ${age}`;
        row.appendChild(meta);

        group.appendChild(row);
    }
    root.appendChild(group);
}
parent.appendChild(root);

// helper, can live inside the module
function formatAge(iso) {
    if (!iso) return '?';
    const ms = Date.now() - new Date(iso).getTime();
    const days = Math.floor(ms / 86400000);
    if (days < 1) return 'today';
    if (days === 1) return '1d';
    if (days < 30) return `${days}d`;
    const months = Math.floor(days / 30);
    return `${months}mo`;
}
```

**Step 2: Style additions in `style.css`**

```css
/* Episodic tab—literary archive layout, grouped by subject */
.starmem-viewer-episodic {
    display: grid;
    gap: var(--starmem-space-5);
}
.starmem-viewer-episodic-subject-group {
    border-left: 2px solid var(--starmem-border-faint);
    padding-left: var(--starmem-space-4);
}
.starmem-viewer-episodic-subject {
    font-family: var(--starmem-font-display);
    font-size: var(--starmem-fs-display-2);
    font-weight: 400;
    color: var(--starmem-fg);
    margin: 0 0 var(--starmem-space-2);
    letter-spacing: var(--starmem-tracking-display);
}
.starmem-viewer-episodic-entry {
    padding: var(--starmem-space-2) 0;
    border-bottom: 1px dotted var(--starmem-border-faint);
    display: grid;
    grid-template-columns: 1fr auto;
    gap: var(--starmem-space-3);
    align-items: baseline;
}
.starmem-viewer-episodic-entry:last-child { border-bottom: none; }
.starmem-viewer-episodic-content {
    font-size: var(--starmem-fs-body);
    line-height: var(--starmem-lh-reading);
}
.starmem-viewer-episodic-meta {
    font-family: var(--starmem-font-mono);
    font-size: var(--starmem-fs-mono);
    color: var(--starmem-fg-muted);
    white-space: nowrap;
}
```

**Step 3: Update unit test**

In `tests/unit/integration/viewer/episodic.test.js` (or create if absent), pin:

```javascript
test('groups entries by subject with display heading', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    await renderTab(parent, {
        chatId: 't',
        state: { entries: [
            { id: '1', scope: 'episodic', subject: 'Alanis', content: 'a', lifecycle: { importance: 70, createdAt: new Date().toISOString() } },
            { id: '2', scope: 'episodic', subject: 'Theo',   content: 'b', lifecycle: { importance: 40, createdAt: new Date().toISOString() } },
            { id: '3', scope: 'episodic', subject: 'Alanis', content: 'c', lifecycle: { importance: 60, createdAt: new Date().toISOString() } },
        ] },
    });
    const groups = parent.querySelectorAll('.starmem-viewer-episodic-subject-group');
    expect(groups).toHaveLength(2);
    const headings = parent.querySelectorAll('.starmem-viewer-episodic-subject');
    expect([...headings].map(h => h.textContent)).toEqual(['Alanis', 'Theo']);
    parent.remove();
});

test('meta line shows importance and age', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    await renderTab(parent, {
        chatId: 't',
        state: { entries: [{
            id: '1', scope: 'episodic', subject: 'X', content: 'c',
            lifecycle: { importance: 72, createdAt: new Date(Date.now() - 3 * 86400000).toISOString() },
        }] },
    });
    const meta = parent.querySelector('.starmem-viewer-episodic-meta');
    expect(meta.textContent).toContain('imp·72');
    expect(meta.textContent).toContain('3d');
    parent.remove();
});
```

(Adjust to reflect the actual signature/state shape; `state.entries` may need to be filtered to `scope === 'episodic'` inside the tab if it isn't already.)

**Step 4: Playwright sanity**

```javascript
test('episodic tab renders grouped subjects', async ({ page }) => {
    await openViewerWithFixture(page, 'episodic-multi-subject');
    await page.locator('.starmem-viewer-tab[data-tab="episodic"]').click();
    const groups = page.locator('.starmem-viewer-episodic-subject-group');
    expect(await groups.count()).toBeGreaterThanOrEqual(1);
});
```

**Step 5: Eyeball verdict + commit**

Approve/iterate. Then:

```bash
git add src/integration/viewer/tabs/episodic.js style.css \
        tests/unit/integration/viewer/episodic.test.js \
        tests/e2e/viewer.spec.js
git commit -m "style(viewer/episodic): Quiet Library subject groups (P16 T6)

T7 successor from Phase 15 plan. Entries grouped by subject; each subject
heading uses serif display face with a hanging left border (literary
archive feel). Dotted-separator entries; content-left + monospace
meta-right grid; reading line-height. Tokens reused from Task 4."
```

**Done-when:**
- [ ] Grouping by subject works for any entry shape
- [ ] Eyeball verdict: approved
- [ ] Unit + e2e tests green
- [ ] Full suite + lint + typecheck green
- [ ] Commit landed

---

## Task 7: T8 successor—settings panel layout pass

**Tag:** `[cosmetic]`—controller drafts, subagent dispatches.

**Pre-req:** Task 4 approved + landed.

**Objective:** Apply Quiet Library to the settings panel. Sections separated by display-font headings with token-driven dividers. Fields use a 220px-label / fluid-input grid for consistent vertical alignment. Help text below each field is muted + italic. Inputs use token-driven borders + focus-on-accent.

**Files:**
- Modify: `src/integration/settingsPanel.js`—wrap rendered fields in `.starmem-settings-section` + `.starmem-settings-field`
- Modify: `style.css`—add `.starmem-settings-*` rules
- Modify: `tests/unit/integration/settingsPanel.test.js`—pin grid + section structure

**Step 1: Restructure rendered HTML**

Wherever `renderSettingsPanel` (or equivalent) constructs field rows, group consecutive fields under a `<section class="starmem-settings-section">` with an `<h3 class="starmem-settings-section-title">`. Each field is now:

```javascript
const field = document.createElement('div');
field.className = `${CSS_PREFIX}-settings-field`;
const label = document.createElement('label');
label.className = `${CSS_PREFIX}-settings-label`;
label.htmlFor = inputId;
label.textContent = labelText;
field.appendChild(label);
field.appendChild(inputElement);
if (helpText) {
    const help = document.createElement('p');
    help.className = `${CSS_PREFIX}-settings-help`;
    help.textContent = helpText;
    field.appendChild(help);
}
section.appendChild(field);
```

(Subagent: refer to mockup `examples/identity-mockup.html` settings section for the exact DOM shape.)

**Step 2: Add CSS rules**

```css
.starmem-settings {
    background: var(--starmem-bg-elevated);
    border-radius: var(--starmem-radius-3);
    box-shadow: var(--starmem-elev-2);
    padding: var(--starmem-space-5) var(--starmem-space-6);
}
.starmem-settings-section { margin-bottom: var(--starmem-space-6); }
.starmem-settings-section:last-child { margin-bottom: 0; }
.starmem-settings-section-title {
    font-family: var(--starmem-font-display);
    font-size: var(--starmem-fs-display-2);
    font-weight: 400;
    margin: 0 0 var(--starmem-space-3);
    padding-bottom: var(--starmem-space-2);
    border-bottom: 1px solid var(--starmem-border-faint);
    letter-spacing: var(--starmem-tracking-display);
}
.starmem-settings-field {
    display: grid;
    grid-template-columns: 220px 1fr;
    gap: var(--starmem-space-4);
    align-items: center;
    padding: var(--starmem-space-2) 0;
}
.starmem-settings-label { font-size: var(--starmem-fs-body); color: var(--starmem-fg); }
.starmem-settings-help {
    grid-column: 2;
    font-size: var(--starmem-fs-meta);
    color: var(--starmem-fg-muted);
    margin-top: var(--starmem-space-1);
    font-style: italic;
}
.starmem-settings-field input[type="number"],
.starmem-settings-field input[type="text"],
.starmem-settings-field select {
    background: var(--starmem-bg);
    border: 1px solid var(--starmem-border-faint);
    border-radius: var(--starmem-radius-1);
    color: var(--starmem-fg);
    padding: var(--starmem-space-2) var(--starmem-space-3);
    font: inherit;
    max-width: 200px;
    transition: border-color var(--starmem-dur-fast) var(--starmem-ease);
}
.starmem-settings-field input:focus,
.starmem-settings-field select:focus {
    outline: none;
    border-color: var(--starmem-accent);
}

/* Mobile: collapse to single column */
@media (max-width: 600px) {
    .starmem-settings-field {
        grid-template-columns: 1fr;
        gap: var(--starmem-space-1);
    }
    .starmem-settings-help { grid-column: 1; }
}
```

**Step 3: Eyeball verdict + commit**

```bash
git add src/integration/settingsPanel.js style.css \
        tests/unit/integration/settingsPanel.test.js
git commit -m "style(settings): Quiet Library section layout (P16 T7)

T8 successor from Phase 15 plan. Fields organized under display-font
section titles; 220px-label + fluid-input grid for vertical alignment;
help text muted + italic. Mobile collapses to single column. Tokens
reused from Task 4."
```

**Done-when:**
- [ ] Settings panel uses tokens, no literals
- [ ] Eyeball verdict: approved
- [ ] Unit tests green (existing + any updated assertions)
- [ ] Full suite + lint + typecheck green
- [ ] Commit landed

---

## Task 8: T9—ARIA roles + keyboard navigation for viewer tabs

**Tag:** `[structural]`—subagent-friendly. A11y is structural value, distinct from cosmetic.

**Objective:** Make the Memory Viewer tab strip keyboard-navigable (Arrow Left/Right, Home, End) and screen-reader-correct (proper `tablist` / `tab` / `tabpanel` ARIA wiring; tabpanel `aria-labelledby`; `aria-controls` from each tab to its panel; focus management on tab switch). Plan 15 already shipped `role="tablist"` and `aria-selected` on tabs; this task completes the spec.

**Files:**
- Modify: `src/integration/viewer/mount.js`—extend `wireTabs()` with keyboard handler; add `aria-controls` and `tabpanel` `aria-labelledby` linking
- Create: `tests/unit/integration/viewer/viewer-aria.test.js`—pin ARIA shape
- Create: `tests/unit/integration/viewer/viewer-keyboard.test.js`—pin keyboard nav
- Modify: `tests/e2e/viewer.spec.js`—add 1 keyboard sanity assertion

**Pre-flight:**

```bash
mcp_jcodemunch_get_symbol_source repo=local-SillyTavern-STARmem-036d3fcc symbol_id="src/integration/viewer/mount.js::wireTabs#function"
# Confirm tab buttons have data-tab and aria-selected as observed in current source
grep -n "role=\"tab\"\|aria-selected" src/integration/viewer/mount.js
```

**Step 1: Failing tests**

`tests/unit/integration/viewer/viewer-aria.test.js`:

```javascript
import { jest } from '@jest/globals';
import { openViewer, _setContextForTests, _resetContextForTests } from '../../../../src/integration/viewer/mount.js';

describe('viewer ARIA shape', () => {
    afterEach(() => _resetContextForTests());

    test('tablist contains tabs with aria-controls referencing tabpanel id', async () => {
        _setContextForTests({});
        const parent = document.createElement('div');
        document.body.appendChild(parent);
        await openViewer('test', { parent });

        const tablist = parent.querySelector('[role="tablist"]');
        expect(tablist).not.toBeNull();
        const tabs = tablist.querySelectorAll('[role="tab"]');
        expect(tabs.length).toBe(5);
        for (const tab of tabs) {
            const panelId = tab.getAttribute('aria-controls');
            expect(panelId).toBeTruthy();
            // The referenced panel must exist
            const panel = parent.querySelector(`#${CSS.escape(panelId)}`);
            expect(panel).not.toBeNull();
            expect(panel.getAttribute('role')).toBe('tabpanel');
        }
        parent.remove();
    });

    test('tabpanel has aria-labelledby pointing back to active tab', async () => {
        _setContextForTests({});
        const parent = document.createElement('div');
        document.body.appendChild(parent);
        await openViewer('test', { parent });
        const activeTab = parent.querySelector('[role="tab"][aria-selected="true"]');
        expect(activeTab).not.toBeNull();
        const tabId = activeTab.id;
        expect(tabId).toBeTruthy();
        const panel = parent.querySelector('[role="tabpanel"]');
        expect(panel.getAttribute('aria-labelledby')).toBe(tabId);
        parent.remove();
    });

    test('only the active tab has tabindex 0; inactive tabs have tabindex -1', async () => {
        _setContextForTests({});
        const parent = document.createElement('div');
        document.body.appendChild(parent);
        await openViewer('test', { parent });
        const tabs = parent.querySelectorAll('[role="tab"]');
        const tabIndices = [...tabs].map(t => t.getAttribute('tabindex'));
        expect(tabIndices.filter(t => t === '0')).toHaveLength(1);
        expect(tabIndices.filter(t => t === '-1')).toHaveLength(4);
        parent.remove();
    });
});
```

`tests/unit/integration/viewer/viewer-keyboard.test.js`:

```javascript
import { jest } from '@jest/globals';
import { openViewer, _resetContextForTests, _setContextForTests } from '../../../../src/integration/viewer/mount.js';

function press(target, key) {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    return ev;
}

describe('viewer keyboard navigation', () => {
    let parent;
    beforeEach(async () => {
        _setContextForTests({});
        parent = document.createElement('div');
        document.body.appendChild(parent);
        await openViewer('test', { parent });
    });
    afterEach(() => { parent.remove(); _resetContextForTests(); });

    test('ArrowRight moves selection to next tab', async () => {
        const tabs = parent.querySelectorAll('[role="tab"]');
        tabs[0].focus();
        press(tabs[0], 'ArrowRight');
        await new Promise(r => setTimeout(r, 0)); // allow async render
        expect(tabs[1].getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(tabs[1]);
    });

    test('ArrowLeft on first tab wraps to last', async () => {
        const tabs = parent.querySelectorAll('[role="tab"]');
        tabs[0].focus();
        press(tabs[0], 'ArrowLeft');
        await new Promise(r => setTimeout(r, 0));
        expect(tabs[tabs.length - 1].getAttribute('aria-selected')).toBe('true');
    });

    test('Home jumps to first tab', async () => {
        const tabs = parent.querySelectorAll('[role="tab"]');
        tabs[3].focus();
        press(tabs[3], 'Home');
        await new Promise(r => setTimeout(r, 0));
        expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    });

    test('End jumps to last tab', async () => {
        const tabs = parent.querySelectorAll('[role="tab"]');
        tabs[0].focus();
        press(tabs[0], 'End');
        await new Promise(r => setTimeout(r, 0));
        expect(tabs[tabs.length - 1].getAttribute('aria-selected')).toBe('true');
    });

    test('Enter / Space activate the focused tab (no-op if already selected)', async () => {
        const tabs = parent.querySelectorAll('[role="tab"]');
        tabs[2].focus();
        press(tabs[2], 'Enter');
        await new Promise(r => setTimeout(r, 0));
        expect(tabs[2].getAttribute('aria-selected')).toBe('true');
    });
});
```

**Step 2: Run—expect FAIL**

```bash
npm test -- tests/unit/integration/viewer/viewer-aria.test.js tests/unit/integration/viewer/viewer-keyboard.test.js 2>&1 | tail -20
```

**Step 3: Implement in `mount.js`**

Modify `buildRootElement(chatId)` to give each tab a stable `id`, add `aria-controls`, and the body gets a stable `id` + `aria-labelledby`:

```javascript
const tabIds = VIEWER_TABS.map(t => `${CSS_PREFIX}-tab-${t}`);
const panelId = `${CSS_PREFIX}-tabpanel-${chatId.replace(/[^a-z0-9-]/gi, '-')}`;

root.innerHTML = `
    <div class="${CSS_PREFIX}-viewer-header">
        <h2 class="${CSS_PREFIX}-viewer-title">STARmem Memory Viewer</h2>
        <button type="button" class="${CSS_PREFIX}-viewer-close" aria-label="Close">✕</button>
    </div>
    <div class="${CSS_PREFIX}-viewer-filter-row">
        <label for="${CSS_PREFIX}-viewer-subject">Subject:</label>
        <input type="text" id="${CSS_PREFIX}-viewer-subject" class="${CSS_PREFIX}-viewer-subject-input" placeholder="(all subjects)" />
    </div>
    <nav class="${CSS_PREFIX}-viewer-tabs" role="tablist" aria-label="Memory views">
        ${VIEWER_TABS.map((t, i) => `
            <button type="button"
                    role="tab"
                    id="${tabIds[i]}"
                    class="${CSS_PREFIX}-viewer-tab"
                    data-tab="${t}"
                    aria-controls="${panelId}"
                    tabindex="-1">${titleFor(t)}</button>
        `).join('')}
    </nav>
    <div class="${CSS_PREFIX}-viewer-body" id="${panelId}" role="tabpanel" aria-labelledby="${tabIds[0]}" tabindex="0"></div>
`;
return root;
```

Modify `highlightActiveTab(state)` to maintain `aria-labelledby` and roving tabindex:

```javascript
function highlightActiveTab(state) {
    const buttons = state.root.querySelectorAll(`.${CSS_PREFIX}-viewer-tab`);
    const panel = state.root.querySelector('[role="tabpanel"]');
    let activeId = null;
    for (const btn of buttons) {
        const tab = /** @type {HTMLElement} */ (btn).dataset.tab;
        if (tab === state.activeTab) {
            btn.classList.add(`${CSS_PREFIX}-viewer-tab-active`);
            btn.setAttribute('aria-selected', 'true');
            btn.setAttribute('tabindex', '0');
            activeId = btn.id;
        } else {
            btn.classList.remove(`${CSS_PREFIX}-viewer-tab-active`);
            btn.setAttribute('aria-selected', 'false');
            btn.setAttribute('tabindex', '-1');
        }
    }
    if (panel && activeId) panel.setAttribute('aria-labelledby', activeId);
}
```

Add a `wireTabKeyboard(state)` and call it from `wireTabs(state)`:

```javascript
function wireTabKeyboard(state) {
    const buttons = [...state.root.querySelectorAll(`.${CSS_PREFIX}-viewer-tab`)];
    state.root.querySelector(`.${CSS_PREFIX}-viewer-tabs`).addEventListener('keydown', async (ev) => {
        const target = ev.target;
        if (!(target instanceof HTMLElement) || target.getAttribute('role') !== 'tab') return;
        const idx = buttons.indexOf(target);
        if (idx < 0) return;
        let nextIdx = -1;
        switch (ev.key) {
            case 'ArrowRight': nextIdx = (idx + 1) % buttons.length; break;
            case 'ArrowLeft':  nextIdx = (idx - 1 + buttons.length) % buttons.length; break;
            case 'Home':       nextIdx = 0; break;
            case 'End':        nextIdx = buttons.length - 1; break;
            case 'Enter':
            case ' ':          nextIdx = idx; break;
            default: return;
        }
        ev.preventDefault();
        const next = buttons[nextIdx];
        const tab = next.dataset.tab;
        if (!tab) return;
        state.activeTab = tab;
        highlightActiveTab(state);
        next.focus();
        await renderActiveTab(state);
    });
}

function wireTabs(state) {
    const buttons = state.root.querySelectorAll(`.${CSS_PREFIX}-viewer-tab`);
    for (const btn of buttons) {
        btn.addEventListener('click', async () => {
            const tab = /** @type {HTMLElement} */ (btn).dataset.tab;
            if (!tab) return;
            state.activeTab = tab;
            highlightActiveTab(state);
            await renderActiveTab(state);
        });
    }
    wireTabKeyboard(state);
    highlightActiveTab(state);
}
```

**Step 4: Playwright sanity**

```javascript
test('keyboard navigates tabs', async ({ page }) => {
    await openViewer(page);
    const firstTab = page.locator('[role="tab"]').first();
    await firstTab.focus();
    await page.keyboard.press('ArrowRight');
    const second = page.locator('[role="tab"]').nth(1);
    await expect(second).toHaveAttribute('aria-selected', 'true');
});
```

**Step 5: Run all + commit**

```bash
npm test 2>&1 | grep -E "^Test Suites|^Tests:"
# Expected: 104 suites / ~995 tests, all green
npm run lint 2>&1 | tail -3
npm run typecheck 2>&1 | tail -3
```

```bash
git add src/integration/viewer/mount.js \
        tests/unit/integration/viewer/viewer-aria.test.js \
        tests/unit/integration/viewer/viewer-keyboard.test.js \
        tests/e2e/viewer.spec.js
git commit -m "feat(viewer): ARIA + keyboard navigation for tabs (P16 T8)

T9 from Phase 15 plan. tablist/tab/tabpanel wired with aria-controls
and aria-labelledby. Roving tabindex pattern: only the active tab is
in the tab order. Keyboard: Arrow Left/Right (with wrap), Home/End,
Enter/Space activate. Tabpanel keeps a stable id; aria-labelledby
follows the active tab.

Closes Phase 15 candidate T9."
```

**Done-when:**
- [ ] Both unit suites green
- [ ] E2E keyboard sanity green (or skipped offline)
- [ ] Full suite green
- [ ] Lint + typecheck clean
- [ ] Manual screen-reader spot-check (VoiceOver, NVDA, or browser devtools accessibility tree) reads "tab 1 of 5, Working, selected" on the active tab
- [ ] Commit landed

---

## Task 9: Public-ship pass—version bump, docs, screenshot, repo metadata

**Tag:** `[public-ship]`—controller-only. Eva runs `gh` commands (Step 7).

**Pre-req:** Tasks 0.5 (conventions doc) + all cosmetic + structural tasks landed.

**Objective:** Ship STARmem v2.0 publicly. Bump version, rewrite README, write CHANGELOG from scratch (Phases 0–16), create `docs/install.md`, capture one Memory Viewer screenshot, update GitHub repo metadata.

**Files:**
- Modify: `manifest.json`—`2.0.0-dev` → `2.0.0`; ensure all conventional fields per `docs/research/extension-install-conventions.md`
- Modify: `package.json`—`2.0.0-dev` → `2.0.0`
- Modify: `README.md`—rewrite with hero, screenshot, install block, features, configuration, compatibility, license, citations
- Create: `CHANGELOG.md`—from scratch, Keep a Changelog 1.1.0 format, with a single `[2.0.0]—2026-04-29` entry summarizing Phases 0–16
- Create: `docs/install.md`—both the ST UI install path and the git-clone path
- Create: `docs/screenshots/viewer.png`—one screenshot of the Memory Viewer (~1200px wide, captured via Playwright against fixture state)

**Step 1: Version bumps**

```bash
# Patch manifest.json
# Use patch tool with old_string='"version": "2.0.0-dev"' new_string='"version": "2.0.0"' on each file
```

Then verify any `requires`, `homePage`, `display_name`, `loading_order` field deltas per the conventions doc. If `homePage` is missing, add: `"homePage": "https://github.com/EvaL3n4/SillyTavern-STARmem"` (substitute the actual repo URL).

**Step 2: Capture the screenshot**

Author a one-shot `tests/e2e/_capture-screenshot.spec.js` (`_` prefix to keep it out of the regular run):

```javascript
import { test } from '@playwright/test';
test('capture viewer screenshot for README', async ({ page }) => {
    await page.goto('http://localhost:8000');  // local ST
    // Inject a deterministic fixture state so the screenshot looks alive but reproducible
    await page.evaluate(() => {
        window.__STARMEM_SCREENSHOT_FIXTURE__ = true;
        // ... seed state with 2-3 subjects, 5-7 episodic entries
    });
    await page.locator('[data-testid="open-starmem-viewer"]').click();
    await page.locator('.starmem-viewer-tab[data-tab="episodic"]').click();
    await page.waitForTimeout(900);  // let staged reveal finish
    await page.screenshot({
        path: 'docs/screenshots/viewer.png',
        clip: { x: 0, y: 0, width: 1200, height: 720 },
    });
});
```

(Subagent: adapt to the actual harness shape. The structurally-essential bit is one PNG at `docs/screenshots/viewer.png`, ~1200px wide, showing a populated Memory Viewer.)

Run only when capturing:

```bash
npx playwright test tests/e2e/_capture-screenshot.spec.js --reporter=line
```

Crop / re-shoot until Eva approves the framing.

**Step 3: Rewrite `README.md`**

Replace the current 39-line README with this structure (calibrated per `docs/research/extension-install-conventions.md` §2):

```markdown
# STARmem

> A memory extension for SillyTavern—long-form roleplay and
> narrative chat. Deterministic 4-tier retrieval, single-substrate context
> tree, offline-only LLM extraction, first-class benchmarking.

![STARmem Memory Viewer](docs/screenshots/viewer.png)

## Install

In SillyTavern:

1. Click the Extensions icon (puzzle piece, top bar).
2. Click "Install Extension" (top right of the Extensions panel).
3. Paste this URL: `https://github.com/EvaL3n4/SillyTavern-STARmem`
4. Click "Install".

For local-clone install (development), see [`docs/install.md`](docs/install.md).

## Features

- **Three memory scopes.** Working buffer (hot), Episodic (long-term), Persona (Enhanced-RAPTOR-distilled). Graph is infrastructure, not a memory.
- **Deterministic retrieval, always.** Tier 0 exact cache → Tier 1 fuzzy cache → Tier 3 intent-routed graph expansion (BM25-seeded). Floor: top-K by `recency × importance × maturity_boost`. **No LLM call on the query path. Ever.**
- **Single write path.** One `consolidate()` function, lazy-chained: Working → Episodic (triggered at buffer ≥ 10 or idle ≥ 60s) → Persona (explicit rebuild only).
- **Honest instrumentation.** Every retrieval produces a replayable trace; every consolidation produces a trace; the Memory Viewer surfaces both on a single timeline.
- **No vector DB. No embeddings. No sidecar files.** State lives in `chatMetadata['STARmem']`—rides ST's native backup.

## Configuration

Open the STARmem settings panel from ST's Extensions drawer:

- **Buffer size**—Working buffer threshold for consolidation (default: 10).
- **Idle timeout**—Seconds of silence before consolidation also fires (default: 60).
- **Connection profile**—Which ST connection profile to use for fact extraction. Used at write time only.

## Compatibility

- **Requires** SillyTavern 1.13.0+.
- **Tested on** Catppuccin, Midnight, and stock dark themes.
- **Not migrated from v1.** STARmem v2 is a clean break (per the [design spec §11](docs/specs/2026-04-20-starmem-v2-design.md)). New chats only.

## Documentation

- [Design spec](docs/specs/2026-04-20-starmem-v2-design.md)—full architecture
- [Install guide](docs/install.md)—UI + local-clone paths
- [Research wiki](docs/wiki/)—paper-by-paper notes for adopted approaches
- [Benchmarks](docs/bench/)—measured retrieval quality on LoCoMo + LongMemEval-S
- [Implementation plans](docs/plans/)—phased rollout, retros per phase

## Citations

STARmem's design draws on published research:

**Adopted:**
- **ByteRover**—Nguyen et al. 2026, [arXiv:2604.01599](https://arxiv.org/abs/2604.01599)—substrate design (Context Tree, lifecycle metadata, tiered retrieval)
- **AdaMem**—Yan et al. 2026, [arXiv:2603.16496](https://arxiv.org/abs/2603.16496)—Working/Episodic/Persona vocabulary
- **MAGMA**—Jiang et al. 2026, [arXiv:2601.03236](https://arxiv.org/abs/2601.03236)—intent-routed graph expansion
- **Enhanced RAPTOR**—Liu et al. 2026, [DOI:10.3389/fcomp.2025.1710121](https://doi.org/10.3389/fcomp.2025.1710121)—Persona rebuild pipeline
- **RAPTOR**—Sarthi et al. 2024, [arXiv:2401.18059](https://arxiv.org/abs/2401.18059)—recursive abstractive tree

**Evaluated, not adopted:** A-MEM (multi-hop too weak for roleplay), Zep / Graphiti (full KG overkill at chat scale).

## License

Apache License 2.0—see [LICENSE](LICENSE).
```

**Step 4: Write `CHANGELOG.md`**

```markdown
# Changelog

All notable changes to STARmem are documented here. Format: [Keep a
Changelog](https://keepachangelog.com/en/1.1.0/) 1.1.0; STARmem follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0]—2026-04-29

First public release. Clean break from the v1 private beta—not
migrated; new chats only.

### Architecture

- **Single-substrate context tree** in `chatMetadata['STARmem']`. No
  sidecar files; no vector DB; no embeddings.
- **Three memory scopes**: Working (hot buffer), Episodic (long-term),
  Persona (Enhanced-RAPTOR-distilled). Graph is infrastructure.
- **Deterministic 4-tier retrieval ladder**: T0 exact cache → T1 fuzzy
  cache → T3 intent-routed graph expansion (BM25-seeded) → Floor
  (recency × importance × maturity_boost). No LLM on the query path.
- **Single write path**—one `consolidate()` function, lazy-chained
  (buffer ≥ 10 or idle ≥ 60s).
- **AKL-lite lifecycle**—importance (0–100), maturity tiers with
  hysteresis gaps, recency decay (τ = 30d), multiplicative score.

### Surface

- **Memory Viewer**—tabbed dashboard (Working / Episodic / Persona /
  Graph / Traces) with subject filter, JSONL trace export, ARIA + keyboard
  navigation, and the "Quiet Library" visual identity.
- **Settings panel**—buffer size, idle timeout, connection profile
  selection (extraction model picker via ST's connection manager).
- **Consolidation indicator**—subtle pulse next to the send button
  while consolidation runs.
- **Interceptor**—installs into ST's `globalThis.SillyTavern.extensions`,
  injects retrieved memories into the prompt at chat-completion time.

### Benchmarking

- **First-class harness**—`bench/cli.js` with corpus adapters for
  LoCoMo and LongMemEval-S (6 task types).
- **Modal-served sweep substrate**—`--mode run-point | run-baselines |
  run-sweep` with per-corpus parameter sweeps and conversation-level
  parallel fan-out (`run_point_chunk`, 30-container parallelism).
- **Coverage-aware amendment gate**—`_should_amend(baseline, candidate)`
  enforces `ΔMRR ≥ 0.02 AND coverage_delta ≥ −5pp` before merging
  parameter tuning.
- **Honest baselines**—bm25only / recency / random retrievers on both
  corpora, documented in `docs/bench/baselines/*.md`.

### Test substrate

- 104 jest suites / ~995 unit + integration tests
- 58 pytest tests for benchmark / Modal infrastructure
- 9+ Playwright E2E tests against a live local ST
- Three CSS-hygiene invariants (`no-leaky-css`, `style-css-invariants`,
  `no-hardcoded-colors`) gating UI work
- Token-defined invariant test pinning the design system

### Out of scope (per spec §11)

Not in v2.0: drift detection; influence propagation at retrieval time;
multi-agent research loops; embeddings; v1 migration; setup wizard;
health checks; debug console; lightweight NER (capitalized-word
matching suffices). These remain v2.1+ candidates.

### Acknowledgements

STARmem v2 was built across 16 phases over ~6 weeks. Thanks to the
ByteRover, AdaMem, MAGMA, and Enhanced RAPTOR teams whose papers
shaped the architecture; to RivelleDays' MoonlitEchoes for the
extension-install convention reference; and to the SillyTavern team
for an extension surface that survives a clean substrate replacement
without API churn.
```

**Step 5: Write `docs/install.md`**

```markdown
# Install

## Path A—From the SillyTavern UI (recommended)

1. Open SillyTavern.
2. Click the Extensions icon (puzzle piece) in the top bar.
3. Click "Install Extension" at the top right of the panel.
4. Paste: `https://github.com/EvaL3n4/SillyTavern-STARmem`
5. Click "Install".
6. STARmem appears in the extension list. Toggle it on.

## Path B—Local clone (development)

```bash
cd <path-to-SillyTavern>/public/scripts/extensions/third-party
git clone https://github.com/EvaL3n4/SillyTavern-STARmem.git
```

Restart SillyTavern. The extension loads from the cloned directory.

For dev tooling (lint, typecheck, jest, playwright):

```bash
cd <path>/public/scripts/extensions/third-party/SillyTavern-STARmem
npm install
npm test         # jest unit + integration
npm run lint
npm run typecheck
npm run test:e2e # Playwright; requires local ST running
```

## Verifying the install

After enabling STARmem, send a few messages in any chat. The
consolidation indicator (a small dot next to the send button) should
pulse briefly after ~10 messages. Open the STARmem Memory Viewer from
the Extensions drawer to inspect what's been recorded.

## Uninstall

Disable from the Extensions panel, or:

```bash
rm -rf <path-to-ST>/public/scripts/extensions/third-party/SillyTavern-STARmem
```

State stored in `chatMetadata['STARmem']` is preserved across reinstalls
because it lives in your chat files, not in the extension directory.
```

**Step 6: Run final pre-ship verification**

```bash
npm test 2>&1 | grep -E "^Test Suites|^Tests:"
npm run lint 2>&1 | tail -3
npm run typecheck 2>&1 | tail -3
# Confirm version bumps
grep '"version"' manifest.json package.json
# Expected: both "2.0.0", no "-dev"
# Confirm screenshot exists
file docs/screenshots/viewer.png
# Expected: PNG image data, ~1200 x 720
# Confirm README has the screenshot reference
grep "docs/screenshots/viewer.png" README.md
```

**Step 7: Commit + Eva runs gh metadata**

```bash
git add manifest.json package.json README.md CHANGELOG.md \
        docs/install.md docs/screenshots/viewer.png
git commit -m "release(2.0.0): public ship—README + CHANGELOG + install (P16 T9)

Bump 2.0.0-dev → 2.0.0. README rewrite with screenshot, install block,
features, configuration, compatibility, citations. CHANGELOG from
scratch (Keep a Changelog 1.1.0) summarizing Phases 0–16. Install guide
covers UI + local-clone paths. One Memory Viewer screenshot at
docs/screenshots/viewer.png.

Calibrated against docs/research/extension-install-conventions.md
(reference: MoonlitEchoes by RivelleDays)."
```

Then Eva runs (substitute the actual repo path):

```bash
gh repo edit EvaL3n4/SillyTavern-STARmem \
  --description "A memory extension for SillyTavern—deterministic 4-tier retrieval, three memory scopes, offline-only extraction, first-class benchmarking." \
  --homepage "https://github.com/EvaL3n4/SillyTavern-STARmem" \
  --add-topic sillytavern \
  --add-topic memory \
  --add-topic roleplay \
  --add-topic llm \
  --add-topic extension \
  --add-topic bm25 \
  --add-topic raptor

# Tag the release
git tag -a v2.0.0 -m "STARmem v2.0.0—first public release"
git push origin v2.0.0

# Optional: GitHub release with auto-generated notes from commits
gh release create v2.0.0 --title "STARmem v2.0.0" --notes-from-tag
```

**Done-when:**
- [ ] manifest.json + package.json at `2.0.0`
- [ ] README rewritten with screenshot + install block
- [ ] CHANGELOG.md exists with `[2.0.0]` entry
- [ ] `docs/install.md` exists with both paths
- [ ] `docs/screenshots/viewer.png` exists, viewer-renders-as-mockup
- [ ] All tests + lint + typecheck still green
- [ ] Eva runs gh repo edit + tag commands
- [ ] Eva confirms repo description + topics show on GitHub web UI
- [ ] v2.0.0 tag pushed
- [ ] Commit landed

---

## Task 10: Phase 16 retro + ROADMAP entry

**Tag:** `[doc]`—controller-only.

**Objective:** Per the `phased-project-planning` skill's bottom-up close pattern (Pitfall 13): findings → retro → ROADMAP. Tasks 1–9 produce the findings; this task narrates them.

**Files:**
- Create: `docs/plans/phase-16-retro.md`
- Modify: `docs/plans/ROADMAP.md`—append `## Phase 16—2026-MM-DD` entry above the Phase 15 entry

**Required retro content (mirror the Phase 15 retro template):**

1. **Title.** "Phase 16 Retro—Public Ship: UI/UX Identity + Structural Survivors"
2. **§0 The honest title**—confirm what shipped matches the plan title; flag any rescope.
3. **§1 What shipped**—task table with commits, full description.
4. **§1.x Test counts**—entry baseline 98 / 974 vs close (per `phased-project-planning` Pitfall 13: include both phase-entry and prior-phase-close numbers).
5. **§2 Decision audit**—every decision held / revised; for each revised, note the why.
6. **§3 Lessons**—at minimum: the Phase 15 host-ceiling reframe (lesson conditional on internal vs public use); how the eyeball-as-gate pattern performed (vs Phase 15's smoke); how `frontend-design` skill performed against actual implementation; reference-extension calibration value.
7. **§4 Surprises**—anything that didn't go to plan.
8. **§5 v2.1 candidates surfaced**—pixel-snapshot tests if appetite; light/high-contrast theme matrix; `prefers-reduced-motion` test coverage gap if any.
9. **§6 Notes for v2.1+ phases**—what test substrate now exists; what's still gating future visual work.

**ROADMAP entry shape:**

```markdown
## Phase 16—2026-MM-DD

**What shipped:** Public-ship release. Quiet Library visual identity (token system: typography / spacing / elevation / radius / motion; serif display face; staged 600ms viewer entrance reveal; reduced-motion respected). Six structural survivors from Phase 15: T4 (Traces consolidation events with shape `{kind: 'consolidate', timestamp, chatId, summary, durationMs, extractor}`), T5 (tier label honesty—T0/T1/T3/Floor; legacy T2 backfilled to T3 since seed-into-Tier-3 is what historical Tier 2 hits exercised), T6 (consolidation indicator visual treatment—accent pulse), T7 (episodic tab—subject groups with display headings + dotted separators), T8 (settings panel—display-font sections + 220px-label grid), T9 (viewer ARIA + keyboard navigation: tablist/tab/tabpanel wired; roving tabindex; Arrow/Home/End/Enter handlers). Public-ship pass: manifest 2.0.0-dev → 2.0.0, README rewrite with screenshot + install block, CHANGELOG from scratch summarizing Phases 0–16, `docs/install.md`, `docs/screenshots/viewer.png`, GitHub repo description + topics + v2.0.0 tag.

**Test totals:** Entry 98 suites / 974 tests (jest), 58 (pytest), 9 (Playwright). Close: <fill>.

**Commits this phase:** ~12 total—plan + retro amendment (T0), reference-conventions doc (T0.5), identity mockup (T1), T4 trace events (T2), T5 tier labels (T3), T4 token system + viewer shell (T4), T5/T6/T7 cosmetic successors (T5/T6/T7), T9 ARIA + keyboard (T8), public-ship pass (T9), retro (T10).

**Execution mode:** Strict serial. Controller-driven for `[doc]` / `[gate]` / `[public-ship]`; subagent-friendly for `[structural]` (T4 trace, T5 labels, T9 a11y); hybrid (controller drafts + subagent dispatches one-at-a-time, eyeball verdict between each) for `[cosmetic]`. No parallel work—Phase 15 lesson 3.1 enforced via per-task acceptance tags.

**Decisions held / revised:** <fill from §2 of retro>

**Surprises:** <fill from §4>

**Notes for v2.1+:** <fill from §6>

**v2.1 candidates filed:** <fill>

**Phase 16 closes the v2.0 cycle.** STARmem is publicly shipped at v2.0.0.

---
```

**Commit:**

```bash
git add docs/plans/phase-16-retro.md docs/plans/ROADMAP.md
git commit -m "docs(plans): phase 16 retro + ROADMAP entry (P16 T10)

Public-ship cycle closes. Phase 15 host-ceiling lesson amended as
conditional on internal-vs-public use mode. Eyeball-as-gate pattern
field-validated; cosmetic acceptance criteria with per-task tags
prevented the Phase 15 mid-execution collapse shape."
```

**Done-when:**
- [ ] `phase-16-retro.md` exists with all 9 sections filled
- [ ] ROADMAP entry exists, dated, with placeholder fields populated
- [ ] Both commits land
- [ ] Working tree clean
- [ ] `git log --oneline | head -15` shows the full Phase 16 commit chain

---

## Phase 16 done-when checklist

Mirror the per-task done-when blocks at the phase boundary:

- [ ] Task 0—plan + retro amendment + ROADMAP forward pointer committed
- [ ] Task 0.5—extension-install conventions doc committed
- [ ] Task 1—identity mockup approved by Eva and committed
- [ ] Task 2—T4 traces consolidation events shipped
- [ ] Task 3—T5 tier label honesty shipped
- [ ] Task 4—Quiet Library token system + viewer shell shipped (Eva-approved)
- [ ] Task 5—T6 indicator visual shipped (Eva-approved)
- [ ] Task 6—T7 episodic tab visual shipped (Eva-approved)
- [ ] Task 7—T8 settings panel layout shipped (Eva-approved)
- [ ] Task 8—T9 viewer ARIA + keyboard nav shipped
- [ ] Task 9—manifest bump + README + CHANGELOG + install doc + screenshot + repo metadata + v2.0.0 tag
- [ ] Task 10—Phase 16 retro + ROADMAP entry shipped
- [ ] Full jest suite green
- [ ] `npm run lint` clean
- [ ] `npm run typecheck` clean
- [ ] `npm run test:e2e` green against local ST
- [ ] No uncommitted changes
- [ ] Public release visible on GitHub

