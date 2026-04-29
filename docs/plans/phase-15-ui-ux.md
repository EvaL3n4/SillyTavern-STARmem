# Phase 15 — UI/UX Polish + Playwright E2E Foundation

> **For Hermes:** Use `subagent-driven-development` to execute task-by-task. Visual / DOM-touching tasks should be controller-executed; mechanical or contained tasks (Task 1 Playwright wiring, Task 2 guard test, Task 4 traces dispatch wiring) are subagent-friendly. Every task ends with `git commit` — do not batch.

**Goal:** Close v2.0 with a polished, theme-respectful UI surface. Land a narrow Playwright smoke harness as the missing E2E test substrate, audit + tighten `style.css` for minimalist theme inheritance, ship the Memory Viewer's missing consolidation-events surface, finalize the indicator's visual treatment, polish the episodic tab and settings panel, add ARIA + keyboard-nav to the viewer tabs, and reflect the post-Phase-14 ladder shape in the Traces tab. v2.1 retrieval-side carryovers (`_should_amend` correctness-knob mode, λ₁ structural fix, etc.) stay parked — Phase 15 is a clean UI/UX lane.

**Architecture:** No new modules; Phase 15 polishes and instruments what Phase 8 shipped. The UI surface (`src/integration/{settings,settingsPanel,indicator,interceptor,bootstrap}.js` + `src/integration/viewer/{mount,tabs/*}.js` + `style.css`) is structurally complete — Phase 15 makes it nice. Three load-bearing CSS hygiene tests already exist (`no-leaky-css`, `style-css-invariants`, mobile-breakpoint discipline) and stay green throughout. Playwright lands as a new top-level test target (`tests/e2e/`) with its own runner, kept entirely out of the jest suite to avoid jsdom-vs-real-browser cross-talk. Every `style.css` variable already inherits ST CSS custom properties via `var(--SmartTheme*, hardcoded-fallback)` — Phase 15 audits the fallbacks and tightens the inheritance, but doesn't change the strategy.

**Tech Stack:** STARmem v2 (vanilla JS ES2022 modules, no build step per `AGENTS.md`). Existing devDeps: `jest` (with `jest-environment-jsdom`), `@types/jest`, `eslint` 9, `tsc` for JSDoc typecheck. **New:** `@playwright/test` (devDep, browser binaries downloaded on first install). Playwright runs against a local SillyTavern install with this extension cloned in — no mocking, no jsdom shim, real browser execution. Theme inheritance is structural via `var(--SmartTheme*)` fallbacks; **no theme fixtures** are encoded in the harness — Phase 15 trusts the global CSS contract instead of pinning specific themes (Eva's call: "we theme based on global CSS").

---

## Decisions locked before writing this plan (see conversation 2026-04-29)

1. **Phase 15 scope = clean UI/UX lane.** No v2.1 retrieval carryovers (correctness-knob amend mode, λ₁ structural fix, abstention scoring, external baselines). UI/UX deserves its own setup; bench-side concerns ride to Phase 16+ on their own merits.
2. **Playwright = narrow smoke harness, not full E2E.** Phase 15 lands: install harness, verify extension load, settings panel renders, viewer opens + tabs switch, indicator mounts. ~5–8 happy-path tests total. Broad E2E (synthesize chats, verify interceptor fires, consolidation triggers, indicator pulses, settings persist across reload) deferred to Phase 16. Eva's call: "I've been pushing 'completion' for a while and got sidetracked by benchmarking" — narrow harness unblocks UX iteration without becoming a phase-eater.
3. **No theme fixtures.** Theme inheritance is structural via `var(--SmartTheme*, fallback)` and the existing `style-css-invariants.test.js` already enforces fallback discipline regex-side. Visual smoke runs against ST's default theme only; theme correctness is a property of the CSS contract, not a Playwright assertion.
4. **All 9 polish candidates ship.** Eva's call: "I'm happy with all 9. That would be nice actually." Tasks 4–9 cover them. Order is dependency-driven (post-Phase-14 ladder relabel → traces consolidation → indicator → episodic polish → settings layout → a11y), not priority-driven.
5. **Hardcoded-color regression guard extends existing test infra.** New `tests/integration/integration/no-hardcoded-colors.test.js` joins the existing `no-leaky-css.test.js` and `style-css-invariants.test.js` triad — same methodology (regex over source files), same exemption pattern (inline `/* exempt: ... */` comments). DRY: don't reinvent the regex-walker.
6. **Minimalist sweep is fallback-tightening, not redesign.** Audit every `var(--SmartTheme*, fallback)` in `style.css` and ensure: (a) the SmartTheme key actually exists in stock ST, (b) the fallback is sane under both dark and light themes, (c) the fallback color isn't a hardcoded hex when a sibling token offers a better default. **Do not** add new visual elements; do not change the layout shape; do not introduce custom fonts. Polish is *removal of inconsistency*, not addition of style.
7. **Traces tab gets a `kind: 'consolidation' | 'retrieval'` filter** rather than a separate tab. Consolidation events plug into the existing ring-buffer infrastructure (`runtime.traces`) with a discriminating `kind` field. Filter UI is two pill buttons (`Retrieval` / `Consolidation`) that toggle visibility. Reuses the existing JSONL export, clear button, and rendering loop.
8. **Post-Phase-14 ladder labels.** Traces tab's tier breakdown should label resolved tiers as `Tier 0 (exact)`, `Tier 1 (fuzzy)`, `Tier 3 (graph)`, `Floor` — and label the BM25 stage as **`BM25 seed (Tier 3 input)`** rather than `Tier 2`. Phase 14's structural demolition is reflected in the user-visible labels. The trace JSON keeps existing field names (no schema change); only the rendering layer relabels.
9. **Indicator visual finalization = three-state CSS only.** `idle` (transparent, no animation), `busy` (warm-amber pulse, current behavior), and a new `recent-success` brief flash (~500ms cyan glow on consolidation completion → fade to idle). No new mount points, no new sizes. The current `floating` fallback class stays.
10. **ARIA scope.** Viewer tabs get `role="tablist"` / `role="tab"` / `role="tabpanel"` + `aria-selected` + `aria-controls`. Keyboard-nav: Left/Right arrows cycle tabs, Home/End jump to first/last, Enter/Space activates focused tab. Settings panel and indicator are simpler surfaces — they get `aria-label` where their function isn't obvious from text and that's it. No screen-reader testing in this phase (Eva's not running NVDA / VoiceOver scripts; ST itself doesn't); just structural correctness verifiable via Playwright assertions on `role` / `aria-*` attributes.
11. **Settings panel polish is layout/spacing only.** No new fields, no rearrangement of the current order, no behavioral change. Tighten the row alignment, give the warning callout breathing room, and ensure the `menu_button`s in the actions row align consistently with ST's native button styling.
12. **Plan size target ~1300 lines.** Larger than Phase 14 because Tasks 1, 4, 5 carry verbatim source. Tasks 2, 3, 6–10 reference existing files. Will chunk-write per the writing-plans skill if heredoc shows growth issues.

---

## Task list

| # | Task | Owner | Wall | Notes |
|---|---|---|---|---|
| 0 | Plan commit | Controller | — | This file |
| 1 | Playwright + E2E foundation (narrow smoke) | Subagent | medium | New `tests/e2e/`, devDep, npm script, 5–8 tests |
| 2 | Hardcoded-color regression guard | Subagent | small | New `tests/integration/integration/no-hardcoded-colors.test.js` |
| 3 | `style.css` minimalist sweep + fallback audit | Controller | small | Audit-and-tighten only; no redesign |
| 4 | Memory Viewer Traces — consolidation events | Subagent | medium | Add `kind` filter, dispatch consolidation traces from `consolidate()` |
| 5 | Post-Phase-14 ladder relabeling in Traces tab | Subagent | small | Rendering-layer relabel; no schema change |
| 6 | Indicator visual treatment finalization | Controller | small | Three-state CSS + 500ms cyan flash on completion |
| 7 | Episodic tab visual polish | Controller | small | Spacing, typography, sort-control alignment |
| 8 | Settings panel layout pass | Controller | small | Row alignment, warning callout, button row consistency |
| 9 | Viewer tabs ARIA + keyboard navigation | Subagent | medium | `role=tablist/tab/tabpanel`, arrow keys, Home/End |
| 10 | Retro + ROADMAP entry | Controller | small | Closes v2.0 fully (Phase 16 = broad E2E) |

**Dependency graph:**
```
0  →  1 (Playwright foundation, gates 4/5/9 visual smokes)
0  →  2 (guard test, no other deps)
0  →  3 (CSS sweep, no other deps; runs alongside 6/7/8)
1  →  4 → 5 (traces consolidation requires render-layer first; relabel rides on top)
1  →  9 (a11y smoke needs Playwright)
0  →  6, 7, 8 (CSS-only polish, can run in parallel with each other and 3)
4, 5, 6, 7, 8, 9  →  10 (retro waits for everything)
```

Three parallel tracks once Task 1 lands: (a) tracesconsolidation+relabel (4 → 5), (b) CSS polish (3, 6, 7, 8 — orderable any way), (c) a11y (9). Task 2 is independent and can ship anytime after 0.

**Skills that apply:**
- Task 1 → new install pattern; will land a `playwright-st-extension-smoke` skill candidate at retro time if the harness shape generalizes.
- Task 2 → the existing `tests/integration/integration/no-leaky-css.test.js` is the template; methodology already field-validated.
- Task 4 → `subagent-driven-development` for the dispatch-wiring portion; manual review on the rendering portion.

---

## Task 0: Commit this plan

**Objective:** Stabilise the plan file as the canonical reference for Tasks 1–10. Subagents downstream read it directly without needing the conversation history.

**Files:**
- Create: `docs/plans/phase-15-ui-ux.md` (this file)

**Step 1: Verify file exists and has expected line count**

```bash
wc -l docs/plans/phase-15-ui-ux.md
# Expected: 1100-1400 lines
grep -c "^## Task " docs/plans/phase-15-ui-ux.md
# Expected: 11 (tasks 0-10)
```

**Step 2: Verify no `***` redactions snuck in**

```bash
grep -n "= \*\*\*\|=\*\*\*" docs/plans/phase-15-ui-ux.md
# Expected: empty output. Any hits = secrets-guard redaction; patch back the literal value.
```

**Step 3: Commit**

```bash
git add docs/plans/phase-15-ui-ux.md
git commit -m "docs(plans): phase 15 ui/ux polish + playwright foundation

11-task plan, decisions §1-12. Phase 15 = clean UI/UX lane.
Narrow Playwright smoke (broad E2E deferred to Phase 16),
all 9 polish candidates land, theme inheritance via global CSS
(no theme fixtures). v2.1 retrieval carryovers stay parked."
```

**Verification:** `git log -1 --oneline` shows the commit; the plan file is the only delta.

---

## Task 1: Playwright + E2E smoke harness

**Objective:** Install Playwright as a devDep, scaffold `tests/e2e/`, and ship 5–8 narrow smoke tests that verify the extension loads cleanly into a fresh local SillyTavern, the settings panel renders, the viewer opens and tabs switch, and the indicator mounts. This is the missing E2E substrate per Eva's call ("Playwright, E2E testing is missing"); broad behavioral E2E (interceptor → consolidation → indicator pulse, settings persistence across reload, etc.) is reserved for Phase 16.

**Files:**
- Modify: `package.json` (add `@playwright/test` devDep + `test:e2e` + `test:e2e:install` npm scripts)
- Create: `playwright.config.js` (top-level config — single project, headed=false default, trace on retry)
- Create: `tests/e2e/fixtures/st-instance.js` (helper: launch a local ST, wait for ready, return Page)
- Create: `tests/e2e/load.spec.js` (smoke 1: extension loads, no console errors)
- Create: `tests/e2e/settings.spec.js` (smoke 2-3: settings panel renders, fields are interactive)
- Create: `tests/e2e/viewer.spec.js` (smoke 4-7: open, tab-switch through all 5 tabs, close)
- Create: `tests/e2e/indicator.spec.js` (smoke 8: indicator mounted at expected anchor, idle by default)
- Create: `tests/e2e/README.md` (doc: how to run, ST install assumptions, what's in scope and what's not)
- Modify: `.gitignore` (add `test-results/`, `playwright-report/`, `tests/e2e/.auth/`)

**Pre-flight context for the subagent:**

The local ST install lives at `/home/opus/.hermes/profiles/hanami/home/SillyTavern/`. The extension is already cloned at `/home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem/`. To run the smoke, ST must be running locally on `http://localhost:8000` (ST's default port), serving the page that loads the extension.

**Critical:** Playwright tests must NOT mock ST. They run against the real running instance. The test setup either (a) assumes ST is already running and connects, or (b) launches ST via a Playwright `webServer` config block. **Pick (a) for Phase 15** — launching ST is its own concern and adds CI complexity. Tests that can't connect to `localhost:8000` skip with a clear message rather than failing.

**Step 1: Add Playwright devDep**

```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
npm install --save-dev --save-exact @playwright/test@^1.48.0
```

Then add npm scripts to `package.json` (insert after the existing `bench:baselines` entry, before the closing `}` of `scripts`):

```json
        "test:e2e": "playwright test",
        "test:e2e:install": "playwright install chromium",
        "test:e2e:headed": "playwright test --headed",
        "test:e2e:debug": "PWDEBUG=1 playwright test"
```

**Step 2: Create `playwright.config.js`**

```js
/**
 * Playwright config for STARmem v2 E2E smokes.
 *
 * Phase 15 scope (narrow): does the extension load, render, and mount cleanly
 * against a real local SillyTavern? Phase 16 will add broad behavioral E2E
 * (interceptor, consolidation, persistence).
 *
 * Assumes a local ST is running at http://localhost:8000. Tests that can't
 * connect skip with a clear message rather than failing.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './tests/e2e',
    timeout: 30_000,
    expect: { timeout: 5_000 },
    fullyParallel: false,           // ST is a single-instance backend; serialize
    retries: 0,                     // smoke tests should be deterministic; no flake masking
    workers: 1,
    reporter: process.env.CI ? 'github' : 'list',
    use: {
        baseURL: 'http://localhost:8000',
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
});
```

**Step 3: Create `tests/e2e/fixtures/st-instance.js`**

```js
/**
 * ST instance helper — connect to a local SillyTavern and verify it's ready.
 *
 * Use as a Playwright fixture: `await openST(page)` returns a page navigated
 * to ST's main view with the extension confirmed loaded.
 */
import { test as base, expect } from '@playwright/test';

/**
 * Navigate to ST and wait for the chat surface to be ready.
 * Throws (and the test fails clearly) if ST isn't reachable.
 */
export async function openST(page) {
    let response;
    try {
        response = await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 5_000 });
    } catch (err) {
        test.skip(true, `SillyTavern not running at ${page.context()._options.baseURL}: ${err.message}`);
        return;
    }
    expect(response.ok()).toBe(true);

    // Wait for ST's chat surface to appear. ST renders #send_but as part
    // of the main UI — that's a stable readiness signal.
    await page.waitForSelector('#send_but', { timeout: 10_000 });
}

/**
 * Confirm the STARmem extension actually loaded. Reads the global flag set
 * in src/integration/index.js:exportTestSurface() at module load.
 */
export async function expectExtensionLoaded(page) {
    const loaded = await page.evaluate(() => {
        return Boolean(globalThis.STARmem || document.querySelector('[id^="starmem-"], [class^="starmem-"]'));
    });
    expect(loaded).toBe(true);
}

export const test = base;
export { expect };
```

**Step 4: Create `tests/e2e/load.spec.js` (smoke 1)**

```js
/**
 * Smoke 1 — STARmem loads cleanly into ST with no console errors.
 *
 * This is the most basic guarantee: opening ST with the extension installed
 * does not throw, does not log errors, and the extension's bootstrap path
 * runs to completion.
 */
import { test, expect, openST, expectExtensionLoaded } from './fixtures/st-instance.js';

test('extension loads with no console errors', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(err.message));

    await openST(page);
    await expectExtensionLoaded(page);

    // Filter out ST's own pre-existing console noise (network 404s for
    // optional extension manifests, etc.) by requiring the error to mention
    // STARmem-related identifiers.
    const ourErrors = errors.filter(e =>
        /starmem|STARmem|integration\/(bootstrap|interceptor|indicator|settings)/i.test(e),
    );
    expect(ourErrors).toEqual([]);
});

test('indicator mounts at send-button anchor', async ({ page }) => {
    await openST(page);
    await expectExtensionLoaded(page);
    // Decision 14.B: indicator mounts inside #send_but_container or
    // floats fixed bottom-right.
    const indicator = page.locator('.starmem-indicator');
    await expect(indicator).toHaveCount(1);
    await expect(indicator).toBeVisible();
});
```

**Step 5: Create `tests/e2e/settings.spec.js` (smokes 2-3)**

```js
/**
 * Smoke 2-3 — settings panel renders into ST's extensions drawer and is
 * interactive.
 */
import { test, expect, openST, expectExtensionLoaded } from './fixtures/st-instance.js';

test('settings panel mounts into ST extensions drawer', async ({ page }) => {
    await openST(page);
    await expectExtensionLoaded(page);

    // Open the extensions drawer. ST's selector for the toggle is stable;
    // the drawer itself is #extensions_settings (per integration/constants.js).
    await page.locator('#extensions-settings-button, [data-i18n="Extensions"]').first().click();
    await page.waitForSelector('#extensions_settings', { state: 'visible' });

    const panel = page.locator('.starmem-settings-panel');
    await expect(panel).toBeVisible();
});

test('settings panel exposes the expected fields', async ({ page }) => {
    await openST(page);
    await expectExtensionLoaded(page);
    await page.locator('#extensions-settings-button, [data-i18n="Extensions"]').first().click();
    await page.waitForSelector('.starmem-settings-panel', { state: 'visible' });

    // Per Phase 8: panel exposes connection profile + scorer + thresholds.
    // Just confirm the structural shape — labels exist, inputs exist.
    await expect(page.locator('.starmem-settings-row')).not.toHaveCount(0);
    const inputs = page.locator('.starmem-settings-input, .starmem-settings-select');
    expect(await inputs.count()).toBeGreaterThan(0);
});
```

**Step 6: Create `tests/e2e/viewer.spec.js` (smokes 4-7)**

```js
/**
 * Smoke 4-7 — Memory Viewer opens, all 5 tabs render, close works.
 */
import { test, expect, openST, expectExtensionLoaded } from './fixtures/st-instance.js';

const TABS = ['working', 'episodic', 'persona', 'graph', 'traces'];

async function openViewer(page) {
    await page.evaluate(() => {
        // Trigger the open path the same way the settings-panel button does.
        // openViewer is exported from src/integration/index.js.
        if (globalThis.STARmem?.openViewer) {
            return globalThis.STARmem.openViewer();
        }
        // Fallback: dispatch the same event the settings button dispatches.
        document.querySelector('.starmem-open-viewer')?.click();
    });
    await page.waitForSelector('.starmem-viewer', { state: 'visible' });
}

test('viewer opens via API', async ({ page }) => {
    await openST(page);
    await expectExtensionLoaded(page);
    await openViewer(page);
    await expect(page.locator('.starmem-viewer')).toBeVisible();
});

for (const tabName of TABS) {
    test(`viewer tab "${tabName}" renders`, async ({ page }) => {
        await openST(page);
        await expectExtensionLoaded(page);
        await openViewer(page);

        // Tabs are buttons with data-tab attribute (per viewer/mount.js).
        await page.locator(`.starmem-viewer-tab[data-tab="${tabName}"]`).click();
        await expect(page.locator(`.starmem-viewer-${tabName}`)).toBeVisible();
    });
}

test('viewer closes via X button', async ({ page }) => {
    await openST(page);
    await expectExtensionLoaded(page);
    await openViewer(page);
    await page.locator('.starmem-viewer-close').click();
    await expect(page.locator('.starmem-viewer')).not.toBeVisible();
});
```

**Step 7: Create `tests/e2e/indicator.spec.js` (smoke 8)**

```js
/**
 * Smoke 8 — indicator is in idle state by default (no consolidation running
 * on a fresh ST). Confirms the polling path doesn't false-positive on a
 * clean state.
 */
import { test, expect, openST, expectExtensionLoaded } from './fixtures/st-instance.js';

test('indicator defaults to idle', async ({ page }) => {
    await openST(page);
    await expectExtensionLoaded(page);
    const indicator = page.locator('.starmem-indicator');
    await expect(indicator).toHaveClass(/starmem-indicator-idle/);
    await expect(indicator).not.toHaveClass(/starmem-indicator-busy/);
});
```

**Step 8: Create `tests/e2e/README.md`**

```markdown
# STARmem E2E Smoke Harness (Phase 15)

Narrow Playwright smoke against a real local SillyTavern instance.

## Setup

```bash
npm install
npm run test:e2e:install   # downloads chromium; ~150 MB one-time
```

## Run

Start your local ST instance first (it must be reachable at `http://localhost:8000`).

```bash
npm run test:e2e            # headless
npm run test:e2e:headed     # with browser window — debugging
npm run test:e2e:debug      # Playwright Inspector — step through
```

If ST isn't running, every test will skip with a clear message rather than fail.

## What's in scope (Phase 15)

- Extension loads with no console errors
- Indicator mounts at the expected anchor and defaults to idle
- Settings panel renders into ST's extensions drawer with interactive fields
- Memory Viewer opens, all 5 tabs render, close works

## What's NOT in scope (deferred to Phase 16)

- Real chat synthesis → interceptor → consolidation pipeline
- Indicator pulse on actual consolidation
- Settings persistence across page reload
- Theme switching (we trust the global CSS contract; see `style.css` and `tests/integration/integration/style-css-invariants.test.js`)
- Viewer content correctness (jest unit tests cover this; E2E only confirms the tabs *render*)
- ARIA / keyboard navigation correctness (Phase 15 Task 9 — runs alongside but tested in jsdom + manual; full a11y suite is Phase 16)
```

**Step 9: Update `.gitignore`**

Append to `.gitignore`:

```
# Playwright
test-results/
playwright-report/
tests/e2e/.auth/
```

**Step 10: Run the harness**

If a local ST is up at `localhost:8000`:

```bash
npm run test:e2e:install   # one-time
npm run test:e2e
```

Expected: 8 tests pass (or skip gracefully if ST unreachable).

If ST isn't up, the suite should skip cleanly:

```
8 skipped
```

**Step 11: Commit**

```bash
git add package.json package-lock.json playwright.config.js tests/e2e/ .gitignore
git commit -m "test(e2e): playwright smoke harness (P15 T1)

Narrow E2E foundation per Phase 15 Decision 2. 8 smoke tests
covering extension load, indicator mount, settings panel render,
viewer tabs, and viewer close. Runs against a real local ST at
localhost:8000; skips cleanly if unreachable.

New devDep: @playwright/test. New npm scripts: test:e2e,
test:e2e:install, test:e2e:headed, test:e2e:debug.

Phase 16 will land broad behavioral E2E (interceptor pipeline,
consolidation triggers, persistence, theme matrix)."
```

**Verification checklist:**

- [ ] `npm run test:e2e` either passes 8 tests or skips 8 cleanly
- [ ] `npm test` (jest) is unchanged — 97 suites / 973 tests still green
- [ ] `npm run lint` green
- [ ] No `tests/e2e/*.spec.js` files appear in jest's collection (confirm: `npm test 2>&1 | grep -c 'tests/e2e'` returns 0)
- [ ] `playwright.config.js` is at the repo root, not inside `tests/`

---

## Task 2: Hardcoded-color regression guard

**Objective:** Land a third invariant test that joins `no-leaky-css.test.js` and `style-css-invariants.test.js`, catching any JS source file that writes a hardcoded color (hex, rgb, rgba, hsl) into `element.style.*`. Phase 8 set the rule (theme inheritance via `var(--SmartTheme*)` only) but didn't have a structural enforcer for the JS side. Eva's call: theme via global CSS — anything hardcoded in JS bypasses that contract.

**Files:**
- Create: `tests/integration/integration/no-hardcoded-colors.test.js`

**Methodology:** mirrors `no-leaky-css.test.js` — walk every `.js` file under `src/integration/`, extract every string literal AND every `element.style.X = '...'` / `style.cssText = '...'` assignment, scan for hex / rgb / rgba / hsl color tokens. Fail with file + line on any unwhitelisted hit. Same `/* exempt: <reason> */` opt-out as the sibling tests.

**Step 1: Write the test**

Create `tests/integration/integration/no-hardcoded-colors.test.js`:

```js
/**
 * Grep invariant: no JS file under src/integration/ may set a hardcoded
 * color on a DOM element. All colors must come from CSS — either the
 * `--starmem-*` design tokens (which themselves fall back through
 * `var(--SmartTheme*, hex)`) or a class toggle that selects a
 * theme-aware CSS rule.
 *
 * Catches:
 *   element.style.color = '#ff0000'
 *   element.style.background = 'rgb(255, 0, 0)'
 *   element.style.cssText = '...background: #ff0000...'
 *   document.querySelector('...').style.fill = 'rgba(...)'
 *
 * Exemption pattern (per the no-leaky-css.test.js convention):
 *   // exempt: <one-line reason>
 *   element.style.color = '#ff0000';
 *
 * Tripwire-verified at commit time by injecting a deliberate violation
 * (see writing-plans skill "Tripwire-Verify Grep-Based Guard Tests").
 */
import { describe, test } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname,
    '..', '..', '..', 'src', 'integration');

function walk(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        const s = statSync(full);
        if (s.isDirectory()) out.push(...walk(full));
        else if (/\.js$/.test(entry)) out.push(full);
    }
    return out;
}

/**
 * Color literal patterns. Matches what shows up in real CSS:
 *   #fff, #ffff, #ffffff, #ffffffff
 *   rgb(255, 0, 0), rgba(255, 0, 0, 0.5)
 *   hsl(0, 100%, 50%), hsla(0, 100%, 50%, 0.5)
 * Skips named CSS colors ('red', 'blue') because they're rare in JS source
 * and false-positive on string content like 'red flag' / 'blue square'.
 */
const HEX_RE = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
const FUNC_COLOR_RE = /\b(?:rgba?|hsla?)\s*\(/g;

/**
 * Style-assignment patterns. Catches both .style.X = and .style.cssText =.
 * Also matches inline-style strings passed to setAttribute('style', ...).
 */
const STYLE_ASSIGN_RES = [
    /\.style\.[a-zA-Z]+\s*=\s*['"`]([^'"`]*)['"`]/g,
    /\.style\.cssText\s*=\s*['"`]([^'"`]*)['"`]/g,
    /\.setAttribute\s*\(\s*['"`]style['"`]\s*,\s*['"`]([^'"`]*)['"`]\s*\)/g,
];

/**
 * Check whether the line above a given character offset has an `// exempt:`
 * comment. Allows opt-out for known-acceptable hardcoded colors (e.g. SVG
 * stroke for an icon that intentionally doesn't theme).
 */
function isExempted(src, charOffset) {
    const before = src.slice(0, charOffset);
    const lastNewline = before.lastIndexOf('\n');
    const prevLineStart = before.lastIndexOf('\n', lastNewline - 1);
    const prevLine = src.slice(prevLineStart + 1, lastNewline);
    return /\/\/\s*exempt:/i.test(prevLine);
}

function scanFile(file) {
    const src = readFileSync(file, 'utf8');
    /** @type {{ kind: string, snippet: string, line: number }[]} */
    const violations = [];

    function recordIfColor(matchText, charOffset, kind) {
        if (isExempted(src, charOffset)) return;
        const hexHits = matchText.match(HEX_RE);
        const funcHits = matchText.match(FUNC_COLOR_RE);
        if (!hexHits && !funcHits) return;
        const line = src.slice(0, charOffset).split('\n').length;
        violations.push({
            kind,
            snippet: matchText.slice(0, 120),
            line,
        });
    }

    for (const re of STYLE_ASSIGN_RES) {
        let m;
        while ((m = re.exec(src)) !== null) {
            recordIfColor(m[1] || m[0], m.index, 'style-assignment');
        }
    }

    return violations;
}

describe('no-hardcoded-colors', () => {
    test('every JS file under src/integration/ uses CSS-only colors', () => {
        const files = walk(ROOT);
        /** @type {{ file: string, kind: string, line: number, snippet: string }[]} */
        const failures = [];

        for (const file of files) {
            const rel = path.relative(ROOT, file);
            for (const v of scanFile(file)) {
                failures.push({ file: rel, ...v });
            }
        }

        if (failures.length > 0) {
            const lines = failures.map(f =>
                `  ${f.file}:${f.line} (${f.kind}): ${f.snippet}`,
            );
            throw new Error(
                `Hardcoded color literals found in JS source:\n${lines.join('\n')}\n\n` +
                'All colors must come from CSS (--starmem-* tokens or theme-aware\n' +
                'class toggles). If this is intentional, add an `// exempt: <reason>`\n' +
                'comment on the line directly above.',
            );
        }
    });
});
```

**Step 2: Run to confirm it passes against the current tree**

```bash
npm test -- tests/integration/integration/no-hardcoded-colors.test.js
```

Expected: PASS. The current tree should be clean — Phase 8 already enforced this via review.

**Step 3: Tripwire — confirm the guard actually fires**

Per the writing-plans skill ("Tripwire-Verify Grep-Based Guard Tests"), we MUST inject a deliberate violation and confirm the test fails before trusting it.

Inject a sentinel into a non-whitelisted file:

```bash
# Append a one-line sentinel violation to indicator.js
echo "// TEST-SENTINEL — do not commit" >> src/integration/indicator.js
echo "if (false) { document.body.style.color = '#ff0000'; }" >> src/integration/indicator.js

# Run the guard test in isolation
npm test -- tests/integration/integration/no-hardcoded-colors.test.js 2>&1 | head -30
```

Expected: FAIL with a message naming `indicator.js`, the line number, and `#ff0000`.

**Step 4: Revert the sentinel via `patch()` (NOT `git checkout`)**

Per the writing-plans skill's sentinel-cleanup-command-choice section: use `patch()` to remove only the sentinel, not `git checkout` which would blow away other uncommitted work. The two appended lines have unique enough content to use as `old_string`:

```bash
# Remove the two sentinel lines using patch tool with the exact text
# (controller-issued — patch() with old_string=$'\n// TEST-SENTINEL — do not commit\nif (false) { document.body.style.color = '\\''#ff0000'\\''; }\n' new_string='')
```

**Step 5: Re-run full test suite**

```bash
npm test
```

Expected: 97 suites / 973 + 1 = 974 tests, all green. (The new test contributes one more assertion to the suite count.)

**Step 6: Commit**

```bash
git add tests/integration/integration/no-hardcoded-colors.test.js
git commit -m "test(integration): no-hardcoded-colors guard (P15 T2)

Third invariant joining no-leaky-css and style-css-invariants:
all colors in src/integration/ JS must come from CSS, never
hardcoded as element.style or setAttribute('style', ...).

Methodology mirrors no-leaky-css: regex over .js sources,
\`// exempt: <reason>\` opt-out for known-acceptable cases.
Tripwire-verified by injecting a deliberate violation; confirmed
the guard fires before reverting and committing.

Phase 8 set the rule (theme inheritance via var(--SmartTheme*));
this guard makes it structural."
```

**Verification:** `npm test 2>&1 | grep -E '^Test Suites|^Tests:'` shows 97 suites / 974 tests.

---

## Task 3: `style.css` minimalist sweep + fallback audit

**Objective:** Audit every `var(--SmartTheme*, fallback)` in `style.css`. Verify each `--SmartTheme*` key actually exists in stock ST, sanity-check fallbacks under both dark and light themes, replace ad-hoc hex fallbacks with sibling-token-derived fallbacks where structurally cleaner. **No new visual elements. No layout changes. No fonts.** Polish is *removal of inconsistency*, not addition of style.

**Pre-flight context:** `style.css` is currently 396 lines. The design-token block at the top defines 9 `--starmem-*` custom properties, each mapping `var(--SmartThemeXxx, hardcoded)`. The rest of the file consumes those tokens; only a few rules touch `var(--SmartTheme*)` directly. Audit scope is the token block + any direct `var(--SmartTheme*)` in rule bodies.

**ST's actual `--SmartTheme*` tokens** (live in `public/themes.json` and applied at theme switch time):

- `--SmartThemeBodyColor` — main text color
- `--SmartThemeEmColor` — muted/em text color
- `--SmartThemeBlurTintColor` — surface tint over the blurred background
- `--SmartThemeShadowColor` — drop-shadow / elevated-surface accent
- `--SmartThemeBorderColor` — border color for cards / inputs
- `--SmartThemeQuoteColor` — quote-block accent (we don't use)
- `--SmartThemeUnderlineColor` — link / underline accent (we don't use)

There is no `--SmartThemeErrorColor` in stock ST. `style.css` currently defines `--starmem-danger: var(--SmartThemeErrorColor, #f7768e)` — the var lookup will *always* fall through to the hex. This is an audit hit.

**Files:**
- Modify: `style.css` (token block + a small number of rule bodies)
- Modify: `tests/integration/integration/style-css-invariants.test.js` (extend the fallback-required regex if any new patterns surface)

**Step 1: Capture the current token-block as a baseline**

```bash
sed -n '20,35p' style.css
```

Expected output (or close):

```css
:root {
    --starmem-fg:           var(--SmartThemeBodyColor, #e8e8e8);
    --starmem-fg-muted:     var(--SmartThemeEmColor, #a0a0a0);
    --starmem-bg:           var(--SmartThemeBlurTintColor, #1a1a1a);
    --starmem-bg-elevated:  var(--SmartThemeShadowColor, #242424);
    --starmem-border:       var(--SmartThemeBorderColor, #3a3a3a);
    --starmem-accent:       #7aa2f7;                      /* STARmem blue */
    --starmem-accent-warm:  #e0af68;                      /* Indicator amber */
    --starmem-danger:       var(--SmartThemeErrorColor, #f7768e);
    --starmem-radius:       6px;
    --starmem-gap:          0.75rem;
    --starmem-indicator-sz: 10px;
}
```

**Step 2: Audit each token**

| Token | Current var | Stock ST has key? | Verdict |
|---|---|---|---|
| `--starmem-fg` | `--SmartThemeBodyColor` | ✅ | KEEP |
| `--starmem-fg-muted` | `--SmartThemeEmColor` | ✅ | KEEP |
| `--starmem-bg` | `--SmartThemeBlurTintColor` | ✅ | KEEP |
| `--starmem-bg-elevated` | `--SmartThemeShadowColor` | ⚠️ (semantic mismatch — Shadow is for drop-shadows, not surface elevation) | **CHANGE** to a brand-themed surface mix, or drop `--SmartTheme*` entirely and use `color-mix(--starmem-bg, white 5%)` |
| `--starmem-border` | `--SmartThemeBorderColor` | ✅ | KEEP |
| `--starmem-danger` | `--SmartThemeErrorColor` | ❌ (key doesn't exist; always falls through to hex) | **CHANGE** — drop the var, use the hex directly OR derive from `var(--SmartThemeBodyColor)` via `color-mix` |
| `--starmem-accent` | hardcoded `#7aa2f7` | n/a (brand) | KEEP — STARmem brand color |
| `--starmem-accent-warm` | hardcoded `#e0af68` | n/a (brand) | KEEP — indicator brand color |

**Step 3: Apply the two audit hits**

For `--starmem-bg-elevated`: the current `--SmartThemeShadowColor` semantically means "drop-shadow tint", not "elevated surface". Under most ST themes (Catppuccin, Midnight, Solarized), this still produces a workable result by accident, but it's load-bearing on coincidence. Switch to a derived approach:

```css
/* Patch style.css token block — replace the --starmem-bg-elevated line: */
    --starmem-bg-elevated:  color-mix(in srgb,
                                      var(--SmartThemeBodyColor, #e8e8e8) 6%,
                                      var(--SmartThemeBlurTintColor, #1a1a1a));
```

This derives an elevated surface from the body color tinted into the surface base — works under any theme (light or dark) because it uses the same token semantics ST already uses elsewhere.

For `--starmem-danger`: `--SmartThemeErrorColor` doesn't exist in stock ST. Drop the var indirection:

```css
/* Patch style.css token block — replace the --starmem-danger line: */
    --starmem-danger:       #f7768e;
```

Add a comment above it:

```css
    /* Brand danger color (no ST equivalent — --SmartThemeErrorColor not defined). */
    --starmem-danger:       #f7768e;
```

**Step 4: Sweep rule bodies for direct `var(--SmartTheme*)` usage**

```bash
grep -n "var(--SmartTheme" style.css | grep -v "^[0-9]*:    --starmem"
```

Expected: returns rule-body usages outside the token block. For each hit, verify:
1. The fallback is present (already enforced by `style-css-invariants.test.js` test 3).
2. Could it reference a `--starmem-*` token instead, for DRY?

If a rule body uses `var(--SmartThemeBodyColor, #fff)` directly when `--starmem-fg` is already mapped to the same thing, replace with `var(--starmem-fg)`. This isn't strictly polish — it's DRY reduction.

**Step 4b: Sweep rule bodies for un-tokenized color literals**

```bash
grep -nE '#[0-9a-fA-F]{3,6}|rgb\(|rgba\(|hsl\(' style.css \
    | grep -v ' --starmem' \
    | grep -v 'var('
```

Expected: returns rule-body literals outside the token block AND outside `var(--…, fallback)` form. Today's known hit is line 161 (the viewer modal backdrop): `background: rgba(0, 0, 0, 0.55);`. This is an intentional theme-agnostic overlay (modals dim the page regardless of theme), not a styling oversight. The action: introduce a token for it and reference the token from the rule body.

```css
/* Add to the :root block alongside the other tokens */
    --starmem-overlay:      rgba(0, 0, 0, 0.55);

/* Then in the modal backdrop rule (line ~161) */
    background: var(--starmem-overlay);
```

This keeps the visual unchanged but lets future theming (light-theme overlay tweak, accessibility opacity bump) happen in one place. Also brings the rule body into compliance with the "all colors via tokens" discipline.

**Step 5: Run the existing CSS hygiene tests**

```bash
npm test -- tests/integration/integration/style-css-invariants.test.js tests/integration/integration/no-leaky-css.test.js
```

Expected: both PASS. The fallback-required-on-SmartTheme-var regex still passes because we either (a) replaced an unfallbacked var with a brand hex (no var, no requirement) or (b) kept the fallback in place.

**Step 6: Visual smoke (manual, ~2 min)**

Open ST locally with the extension loaded, switch through 3 stock themes (default dark, default light, any Catppuccin variant if installed). Confirm:

1. Settings panel: text readable on all three.
2. Memory Viewer: tab text readable, list rows distinguishable from background.
3. Indicator: idle is invisible/transparent; busy is visibly amber against any theme background.

**Step 7: Commit**

```bash
git add style.css
git commit -m "style: audit + tighten theme-inheritance fallbacks (P15 T3)

- --starmem-bg-elevated: derive from BodyColor + BlurTintColor
  via color-mix instead of misusing ShadowColor (semantic fix).
- --starmem-danger: drop --SmartThemeErrorColor indirection
  (key doesn't exist in stock ST; var always fell through).
- --starmem-overlay: new token for the theme-agnostic modal
  backdrop (was rgba(0,0,0,0.55) inline at line 161).
- Rule bodies that duplicated --SmartTheme* lookups already
  available via --starmem-* tokens now use the local token
  (DRY reduction).

No layout changes, no new visual elements, no fonts. Just
removing inconsistency in how theme inheritance is wired."
```

**Verification:** `tests/integration/integration/style-css-invariants.test.js` still green; manual visual check across 3 themes confirms readability.

---

## Task 4: Memory Viewer Traces — consolidation events

**Objective:** Surface consolidation events in the Traces tab alongside the existing retrieval traces. Phase 7 retro flagged this as a v2.1 candidate; Phase 15 ships it. The implementation extends the existing `runtime.traces` ring buffer with a discriminating `kind: 'retrieval' | 'consolidation'` field, dispatches a consolidation trace from `consolidate()` after each successful run, and adds a two-pill filter UI to the Traces tab.

**Files:**
- Modify: `src/consolidation/consolidate.js` (after the existing return path: dispatch a consolidation trace into `runtime.traces`)
- Modify: `src/consolidation/index.js` (export `_appendConsolidationTrace` for testability if the helper isn't already wired)
- Modify: `src/integration/viewer/tabs/traces.js` (kind filter + render branch)
- Modify: `style.css` (filter pill styles — minimal, theme-aware)
- Create: `tests/unit/integration/viewer/traces-consolidation.test.js`

**Step 1: Decide trace shape**

A consolidation trace carries:

```js
{
    kind: 'consolidation',          // NEW field; existing retrieval traces get kind: 'retrieval'
    timestamp: number,              // Date.now() at consolidate() return
    chatId: string,
    summary: {
        added: number,              // count of new entries
        updated: number,            // count of access-event updates
        drained: number,            // count of working-buffer entries drained
    },
    durationMs: number,             // wall time of the consolidate() call
    extractor: string,              // settings.extractionModelLabel (provenance)
}
```

Existing retrieval traces are `{ chatId, query, intent, ladder: [...], ... }` with no `kind` field today. Migration: when reading traces, treat absence of `kind` as `kind: 'retrieval'` (backward-compatible — every existing trace is a retrieval trace).

**Step 2: Wire dispatch in `consolidate.js`**

Read the current return path:

```bash
grep -n "return\|runtime.traces" src/consolidation/consolidate.js | head -20
```

Locate the success-path return statement (typically near end of file, returns `{ added, updated, drained }`). Wrap the body in a wall-time measurement and append a trace before returning. Sketch:

```js
// At top of consolidate():
const _t0 = Date.now();

// ... existing consolidation body ...

// Just before the existing return:
const _trace = {
    kind: 'consolidation',
    timestamp: Date.now(),
    chatId,
    summary: { added, updated, drained },
    durationMs: Date.now() - _t0,
    extractor: opts?.extractorLabel || 'unknown',
};

// Append to runtime.traces ring buffer (use the same path retrieval uses).
// If consolidate() doesn't currently touch runtime.traces, look at how
// retrieve() does it in src/retrieval/index.js for the canonical pattern,
// and use the SAME helper (don't reinvent the ring-buffer-write code).

return { added, updated, drained, _trace };  // expose for tests; ignore in callers
```

**Critical:** the ring buffer respects a max size from constants (likely `RETRIEVAL.TRACE_RING_SIZE` or similar). Find the existing helper that retrieval traces use and reuse it. **Do not duplicate the ring-buffer logic.** If no helper exists, extract one to `src/core/traces.js` and call from both retrieval and consolidation paths (DRY).

**Step 3: Update existing retrieval traces with `kind: 'retrieval'`**

In whichever file appends retrieval traces (likely `src/retrieval/index.js` or `src/retrieval/trace.js`), add `kind: 'retrieval'` to the trace object. Don't break backward-compat in the reader — see Step 4.

**Step 4: Render branch in `traces.js`**

Read `src/integration/viewer/tabs/traces.js`. The current render iterates `traces` and calls `buildTraceItem(trace)`. Update:

1. Add filter pills above the list:
   ```js
   const filterRow = document.createElement('div');
   filterRow.className = `${CSS_PREFIX}-viewer-traces-filter`;
   const allBtn = pill('All', 'all', /* active */ true);
   const retBtn = pill('Retrieval', 'retrieval', false);
   const conBtn = pill('Consolidation', 'consolidation', false);
   filterRow.append(allBtn, retBtn, conBtn);
   root.appendChild(filterRow);
   ```

2. Filter logic:
   ```js
   function visibleTraces(traces, filter) {
       if (filter === 'all') return traces;
       return traces.filter(t => (t.kind || 'retrieval') === filter);
   }
   ```

   Note the `t.kind || 'retrieval'` — backward-compat for existing traces without the field.

3. `buildTraceItem` branches on `kind`:
   ```js
   function buildTraceItem(trace) {
       const item = document.createElement('li');
       item.className = `${CSS_PREFIX}-viewer-trace-item`;
       if ((trace.kind || 'retrieval') === 'consolidation') {
           item.classList.add(`${CSS_PREFIX}-viewer-trace-consolidation`);
           item.appendChild(buildConsolidationContent(trace));
       } else {
           item.classList.add(`${CSS_PREFIX}-viewer-trace-retrieval`);
           item.appendChild(buildRetrievalContent(trace));
       }
       return item;
   }

   function buildConsolidationContent(trace) {
       const root = document.createElement('div');
       const head = document.createElement('div');
       head.className = `${CSS_PREFIX}-viewer-trace-head`;
       head.textContent = `Consolidation · ${trace.summary.added} added · ${trace.summary.updated} updated · ${trace.summary.drained} drained · ${trace.durationMs}ms`;
       const meta = document.createElement('div');
       meta.className = `${CSS_PREFIX}-viewer-trace-meta`;
       meta.textContent = `${new Date(trace.timestamp).toLocaleTimeString()} · ${trace.extractor}`;
       root.append(head, meta);
       return root;
   }
   ```

   Wrap the existing retrieval-trace rendering in `buildRetrievalContent` (move the existing body into that helper).

**Step 5: CSS for filter pills**

Append to `style.css`:

```css
/* Traces tab — kind filter pills (Phase 15 Task 4). */
.starmem-viewer-traces-filter {
    display: flex;
    gap: 0.5rem;
    padding: 0.25rem 0;
    margin-bottom: var(--starmem-gap);
}

.starmem-viewer-traces-filter-pill {
    padding: 0.25rem 0.75rem;
    border: 1px solid var(--starmem-border);
    border-radius: 9999px;
    color: var(--starmem-fg-muted);
    background: transparent;
    font-size: 0.85rem;
    cursor: pointer;
    transition: color 150ms ease-out, border-color 150ms ease-out;
}

.starmem-viewer-traces-filter-pill:hover {
    color: var(--starmem-fg);
    border-color: var(--starmem-fg-muted);
}

.starmem-viewer-traces-filter-pill[aria-pressed="true"] {
    color: var(--starmem-fg);
    border-color: var(--starmem-accent);
    background: color-mix(in srgb, var(--starmem-accent) 12%, transparent);
}

.starmem-viewer-trace-consolidation .starmem-viewer-trace-head {
    color: var(--starmem-accent-warm);
}

.starmem-viewer-trace-retrieval .starmem-viewer-trace-head {
    color: var(--starmem-fg);
}
```

**Step 6: Tests**

Create `tests/unit/integration/viewer/traces-consolidation.test.js`:

```js
import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { JSDOM } from 'jsdom';

let document, window;

beforeEach(() => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    document = dom.window.document;
    window = dom.window;
    globalThis.document = document;
    globalThis.window = window;
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.Blob = window.Blob;
    globalThis.URL = { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} };
});

describe('traces tab — kind filter', () => {
    test('renders both retrieval and consolidation traces with kind labels', async () => {
        const { renderTab } = await import('../../../../src/integration/viewer/tabs/traces.js');
        const parent = document.createElement('div');
        const ctx = {
            chatId: 'c1',
            state: {
                runtime: {
                    traces: [
                        { kind: 'retrieval', chatId: 'c1', query: 'foo', intent: 'factual', ladder: [] },
                        { kind: 'consolidation', chatId: 'c1', timestamp: Date.now(), summary: { added: 3, updated: 1, drained: 5 }, durationMs: 42, extractor: 'gemma-2:test' },
                    ],
                },
            },
        };
        await renderTab(parent, ctx);
        const items = parent.querySelectorAll('.starmem-viewer-trace-item');
        expect(items.length).toBe(2);
        expect(parent.querySelector('.starmem-viewer-trace-consolidation')).not.toBeNull();
        expect(parent.querySelector('.starmem-viewer-trace-retrieval')).not.toBeNull();
        expect(parent.querySelector('.starmem-viewer-traces-filter-pill[aria-pressed="true"]').textContent).toBe('All');
    });

    test('treats trace without `kind` field as retrieval (backward-compat)', async () => {
        const { renderTab } = await import('../../../../src/integration/viewer/tabs/traces.js');
        const parent = document.createElement('div');
        const ctx = {
            chatId: 'c1',
            state: {
                runtime: {
                    traces: [
                        { chatId: 'c1', query: 'foo', intent: 'factual', ladder: [] }, // no kind
                    ],
                },
            },
        };
        await renderTab(parent, ctx);
        expect(parent.querySelector('.starmem-viewer-trace-retrieval')).not.toBeNull();
        expect(parent.querySelector('.starmem-viewer-trace-consolidation')).toBeNull();
    });

    test('Consolidation pill filters out retrieval traces', async () => {
        const { renderTab } = await import('../../../../src/integration/viewer/tabs/traces.js');
        const parent = document.createElement('div');
        const ctx = {
            chatId: 'c1',
            state: {
                runtime: {
                    traces: [
                        { kind: 'retrieval', chatId: 'c1', query: 'foo', intent: 'factual', ladder: [] },
                        { kind: 'consolidation', chatId: 'c1', timestamp: Date.now(), summary: { added: 1, updated: 0, drained: 1 }, durationMs: 10, extractor: 'test' },
                    ],
                },
            },
        };
        await renderTab(parent, ctx);
        const consPill = parent.querySelector('.starmem-viewer-traces-filter-pill[data-kind="consolidation"]');
        consPill.click();
        // Re-rendering happens inline; query the updated DOM:
        await new Promise(r => setTimeout(r, 0));
        const visible = parent.querySelectorAll('.starmem-viewer-trace-item');
        expect(visible.length).toBe(1);
        expect(visible[0].classList.contains('starmem-viewer-trace-consolidation')).toBe(true);
    });
});
```

Add a complementary test to `tests/unit/consolidation/consolidate.test.js` (or wherever consolidate's tests live) verifying the dispatched trace shape.

**Step 7: Run all tests**

```bash
npm test
```

Expected: 97 + 1 = 98 suites, +3-4 new tests. All green.

**Step 8: Commit**

```bash
git add src/consolidation/consolidate.js src/consolidation/index.js \
        src/integration/viewer/tabs/traces.js \
        src/retrieval/index.js src/retrieval/trace.js \
        style.css \
        tests/unit/integration/viewer/traces-consolidation.test.js
git commit -m "feat(viewer): traces tab — consolidation events + kind filter (P15 T4)

Closes Phase 7 retro v2.1 candidate. Consolidation traces now
flow into the same ring buffer as retrieval traces, distinguished
by a new \`kind: 'consolidation' | 'retrieval'\` field. Existing
traces without the field render as retrieval (backward-compat).

Filter UI: three pills (All / Retrieval / Consolidation) at the
top of the Traces tab. JSONL export and clear-all stay unchanged.

Trace shape for consolidation:
  { kind, timestamp, chatId, summary: { added, updated, drained },
    durationMs, extractor }"
```

**Verification:** open viewer manually, trigger a consolidation (~10 messages or 60s idle), confirm a consolidation trace appears.

---

## Task 5: Post-Phase-14 ladder relabeling in Traces tab

**Objective:** Reflect Phase 14's structural Tier 2 demolition in the user-visible labels of the Traces tab. The trace JSON keeps existing field names — only the rendering layer relabels. Per Decision 8: resolved tiers display as `Tier 0 (exact)`, `Tier 1 (fuzzy)`, `Tier 3 (graph)`, `Floor`; the BM25 stage labels as `BM25 seed (Tier 3 input)` instead of `Tier 2`.

**Files:**
- Modify: `src/integration/viewer/tabs/traces.js` (the `buildRetrievalContent` helper from Task 4)

**Pre-flight:** read the current ladder rendering. Per `src/retrieval/trace.js`, traces include a `ladder: [{ tier: 't0' | 't1' | 't2' | 't3' | 'floor', hit: bool, candidates: [...], ... }]` array. The current renderer likely emits "Tier 0 / Tier 1 / Tier 2 / Tier 3 / Floor" verbatim from the field. Phase 14 demolished t2 as a resolver, but the trace schema still emits a `t2` entry representing the BM25 seed stage that feeds Tier 3.

**Step 1: Confirm trace shape**

```bash
grep -n "tier:" src/retrieval/trace.js src/retrieval/ladder.js | head -20
```

Confirm the trace continues to emit `tier: 't2'` for the BM25 seed stage. If it does, this task is rendering-only. If post-Phase-14 trace.js was updated to drop `t2` entirely, this task is moot — verify by inspection.

**Step 2: Define the label map**

In `traces.js` (the trace renderer file), near the top:

```js
const TIER_LABELS = {
    t0: 'Tier 0 (exact)',
    t1: 'Tier 1 (fuzzy)',
    t2: 'BM25 seed (Tier 3 input)',
    t3: 'Tier 3 (graph)',
    floor: 'Floor',
};

function tierLabel(tier) {
    return TIER_LABELS[tier] || tier;
}
```

**Step 3: Replace direct field interpolation with `tierLabel`**

Wherever the current code renders `tier.tier` or similar directly, route through `tierLabel(tier.tier)`. Typical patterns:

```js
// Before:
row.textContent = `Tier ${tier.tier}: ${tier.hit ? 'hit' : 'miss'} (${tier.candidates.length} candidates)`;

// After:
row.textContent = `${tierLabel(tier.tier)}: ${tier.hit ? 'hit' : 'miss'} (${tier.candidates.length} candidates)`;
```

**Step 4: Update tests**

Find existing tests that assert on rendered tier text:

```bash
grep -rn "Tier 2\|Tier 1\|Tier 0\|Tier 3" tests/unit/integration/viewer/ 2>/dev/null
```

Update each assertion to expect the new label format.

**Step 5: Run tests + visual smoke**

```bash
npm test -- tests/unit/integration/viewer/
```

Expected: all green. Open the viewer manually, dispatch a query that goes through the ladder, confirm Traces tab shows the new labels.

**Step 6: Commit**

```bash
git add src/integration/viewer/tabs/traces.js tests/unit/integration/viewer/
git commit -m "feat(viewer): post-Phase-14 ladder labels in Traces tab (P15 T5)

Per Phase 14 retro Notes for Phase 15: Tier 2 is no longer a
resolver and no longer exists structurally. Trace rendering now
labels the BM25 stage as 'BM25 seed (Tier 3 input)' rather than
'Tier 2', and tier resolution rows include their semantic role
(exact / fuzzy / graph / floor).

No schema change — trace JSON still carries tier: 't2' for the
BM25 seed stage. Only the rendering layer relabels."
```

---

## Task 6: Consolidation indicator visual treatment

**Objective:** Tighten the consolidation indicator's visual treatment per Eva's "subtle dot" preference. The indicator already mounts inside `#send_but_container` with an idle/busy class toggle and a fallback to `document.body` with `floating` class — the *behavior* is correct. This task is pure CSS: a quieter resting state, a more deliberate busy pulse, and parity between the anchored and floating placements so the floating fallback doesn't look like a different component. No JS changes — the test substrate at `tests/integration/integration/indicator.test.js` should remain untouched and still pass.

**Files:**
- Edit: `style.css` (rules at lines 44–95 — search `.starmem-indicator`)

**Methodology:** read each existing rule, decide what shifts, edit in place. Do not introduce new selectors. The visual-regression guard on `style.css` is structural (line counts, `var(--SmartTheme*)` discipline, `starmem-` prefix) and should not flag a same-selector recolor.

**Step 1: Read current rules**

```bash
sed -n '40,100p' style.css
```

You will see five rules: `.starmem-indicator`, `.starmem-indicator.starmem-indicator-floating`, `.starmem-indicator.starmem-indicator-idle`, `.starmem-indicator.starmem-indicator-busy`, and the busy-state `@keyframes starmem-pulse` block. Document the existing values in a comment block before changing anything (helps the diff narrative in the commit).

**Step 2: Locked design parameters**

| Property | Idle | Busy | Notes |
|---|---|---|---|
| Diameter | 6px | 6px | Was 10px (`--starmem-indicator-sz`) — Eva's "subtle"; lower the token to 6px |
| Background | `transparent` | `var(--starmem-accent-warm)` | Idle = no fill; busy = the brand-warm token (already defined in `:root` as `#e0af68`) |
| Border | `1px solid var(--starmem-border)` | `1px solid transparent` | Idle = ring using the design-system border token; busy = solid swap |
| Opacity | 0.4 | 1.0 | Idle stays present but recedes |
| Animation | none | `starmem-pulse 1.4s ease-in-out infinite` | Was 1s — slower reads as deliberate, not jittery |
| Position offset | top: 50%, right: 4px, transform: translateY(-50%) | (same) | Anchored placement |

Floating fallback inherits the same except `position: fixed; bottom: 12px; right: 12px; top: auto; transform: none;` so the dot lands consistently in the bottom-right corner regardless of which path mounted it.

**Step 3: Pulse animation revision**

The current `@keyframes starmem-pulse` (if present at lines ~80–95) likely scales 1.0 → 1.3 → 1.0 with opacity 0.6 → 1.0 → 0.6. Replace with:

```css
@keyframes starmem-pulse {
    0%, 100% {
        transform: translateY(-50%) scale(1);
        box-shadow: 0 0 0 0 var(--starmem-accent-warm);
    }
    50% {
        transform: translateY(-50%) scale(1.15);
        box-shadow: 0 0 0 4px transparent;
    }
}
```

This produces a soft outward halo rather than a scaling dot — reads as "active" without drawing the eye away from the chat.

For the floating fallback the keyframes need to override the `transform`:

```css
@keyframes starmem-pulse-floating {
    0%, 100% {
        transform: scale(1);
        box-shadow: 0 0 0 0 var(--starmem-accent-warm);
    }
    50% {
        transform: scale(1.15);
        box-shadow: 0 0 0 4px transparent;
    }
}

.starmem-indicator.starmem-indicator-floating.starmem-indicator-busy {
    animation: starmem-pulse-floating 1.4s ease-in-out infinite;
}
```

**Step 4: Locked CSS**

Lower the indicator token first (in the `:root` block at the top of `style.css`):

```css
--starmem-indicator-sz: 6px;   /* was 10px */
```

Replace the indicator block (lines ~44–95) with:

```css
/*
 * Consolidation indicator — subtle dot mounted in #send_but_container,
 * or fixed bottom-right as a floating fallback. Idle state is a faint
 * outline (always present, low signal); busy state is a filled dot with
 * a soft outward halo pulse using the brand-warm token.
 *
 * Decision 14.B: anchor placement; .starmem-indicator-floating is the
 * defensive fallback when #send_but_container isn't mounted yet.
 */
.starmem-indicator {
    position: absolute;
    top: 50%;
    right: 4px;
    transform: translateY(-50%);
    width: var(--starmem-indicator-sz, 6px);
    height: var(--starmem-indicator-sz, 6px);
    border-radius: 50%;
    pointer-events: none;
    transition: opacity 220ms ease-out, background-color 220ms ease-out;
}

.starmem-indicator.starmem-indicator-floating {
    position: fixed;
    top: auto;
    bottom: 12px;
    right: 12px;
    transform: none;
    z-index: 9999;
}

.starmem-indicator.starmem-indicator-idle {
    background: transparent;
    border: 1px solid var(--starmem-border);
    opacity: 0.4;
}

.starmem-indicator.starmem-indicator-busy {
    background: var(--starmem-accent-warm);
    border: 1px solid transparent;
    opacity: 1;
    animation: starmem-pulse 1.4s ease-in-out infinite;
}

@keyframes starmem-pulse {
    0%, 100% {
        transform: translateY(-50%) scale(1);
        box-shadow: 0 0 0 0 var(--starmem-accent-warm);
    }
    50% {
        transform: translateY(-50%) scale(1.15);
        box-shadow: 0 0 0 4px transparent;
    }
}

@keyframes starmem-pulse-floating {
    0%, 100% {
        transform: scale(1);
        box-shadow: 0 0 0 0 var(--starmem-accent-warm);
    }
    50% {
        transform: scale(1.15);
        box-shadow: 0 0 0 4px transparent;
    }
}

.starmem-indicator.starmem-indicator-floating.starmem-indicator-busy {
    animation: starmem-pulse-floating 1.4s ease-in-out infinite;
}
```

**Step 5: Test pass**

```bash
npm test -- tests/integration/integration/indicator.test.js
npm run test:invariants  # if a script alias exists; else jest no-leaky-css + style-css-invariants
```

Both must pass. The indicator JS test is class-based (asserts `.starmem-indicator-idle` / `.starmem-indicator-busy` on transition) and is invariant under recolors.

**Step 6: Manual sanity check**

```bash
npm run lint
npm run typecheck  # 3 pre-existing errors in tests/, ignore
```

**Step 7: Commit**

```bash
git add style.css
git commit -m "style(indicator): subtle dot + soft halo pulse (P15 T6)

Per Phase 15 Decision: minimalist style inheriting ST CSS via the
existing --starmem-* design tokens.

- Lower --starmem-indicator-sz token: 10px → 6px
- Idle: 6px ring at 0.4 opacity using --starmem-border
- Busy: 6px filled with --starmem-accent-warm + soft outward
  box-shadow halo (was 1.3x scale pulse — read as jittery)
- Pulse duration 1.0s → 1.4s for deliberateness
- Floating fallback gets its own pulse keyframes (no transform conflict)

All colors flow through the design-system tokens defined in :root,
which themselves cascade var(--SmartTheme*, fallback). The brand-warm
token (--starmem-accent-warm = #e0af68) is intentionally unrouted
through SmartTheme — indicator colour is a brand identity choice,
verified during T3's CSS audit (T2 scans JS files only).

Behavior unchanged: indicator.test.js and class-based assertions
all pass. No JS changes."
```

**Verification checklist:**

- [ ] `tests/integration/integration/indicator.test.js` green
- [ ] `tests/integration/integration/no-leaky-css.test.js` green (selectors all `starmem-` prefixed)
- [ ] `tests/integration/integration/style-css-invariants.test.js` green (no hardcoded color outside `var()` fallback)
- [ ] Eyeball check in a fresh ST: idle dot is barely-there, busy dot pulses calmly, floating fallback (test by hiding `#send_but_container` in DevTools before mount) lands bottom-right cleanly.

---

## Task 7: Memory Viewer episodic tab visual polish

**Objective:** Visual polish for the episodic tab. The tab is more developed than I'd remembered: it already has a header with `count/total` (`.starmem-viewer-episodic-header`), a sort dropdown (`#starmem-viewer-episodic-sort` — `importance` desc default, `recency` option), inline tag rendering, and a subject filter wired through the parent viewer. The functional surface is solid; this task is typography hierarchy, density, hover state, and a calmer empty state. No data-shape or sort-logic changes.

**Files:**
- Edit: `src/integration/viewer/tabs/episodic.js` (DOM emission only — no logic edits)
- Edit: `style.css` (search `.starmem-viewer-episodic` block)

**Methodology:** identify the visual misalignments that make the tab feel unfinished, fix each, re-run the existing tab test (`tests/integration/integration/viewer-tabs-episodic.test.js`).

**Step 1: Read current state**

```bash
cat src/integration/viewer/tabs/episodic.js   # 127 lines
sed -n '/\.starmem-viewer-episodic/,/^\.starmem-[^v]/p' style.css   # current rules
cat tests/integration/integration/viewer-tabs-episodic.test.js   # see assertion shape
```

The test queries by these selectors (don't break them):
- `.${CSS_PREFIX}-viewer-episodic-header` — header text contains `count/total`
- `.${CSS_PREFIX}-viewer-episodic-item` — one per rendered entry
- `#${CSS_PREFIX}-viewer-episodic-sort` — a `<select>` whose `change` event re-renders

Anything we add must keep those three intact.

**Step 2: Polish targets**

Verify against the actual file before editing — fix only those that hold:

1. **Item density** — items likely render as flat `<div>`s with little vertical separation. Add row gap, subtle left-border, and a hover state.
2. **Header typography** — `.starmem-viewer-episodic-header` likely emits `2/2` as plain text; should read as a header (slightly heavier weight, muted "of N" tail).
3. **Importance + tag rendering hierarchy** — importance score and tag pills currently fight the body text for attention; demote both to muted secondary line.
4. **Empty state** — likely a bare `"No entries"` string; replace with a centered two-line block (hint about consolidation).

**Step 3: CSS — extend existing block**

Add or replace the `.starmem-viewer-episodic*` block. Locked values (use the existing `--starmem-*` token system from `:root`, do not introduce new tokens):

```css
/*
 * Memory Viewer — episodic tab
 * Items render as bordered rows with hover lift; header carries
 * filtered/total counts; sort dropdown sits inline in header.
 */
.starmem-viewer-episodic-header {
    display: flex;
    align-items: baseline;
    gap: var(--starmem-gap, 0.75rem);
    padding: 4px 8px 8px 8px;
    font-weight: 600;
    color: var(--starmem-fg, inherit);
}

.starmem-viewer-episodic-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 4px 8px;
}

.starmem-viewer-episodic-item {
    display: grid;
    grid-template-columns: 1fr;
    gap: 4px;
    padding: 8px 10px;
    border-left: 2px solid var(--starmem-border);
    background: var(--starmem-bg);
    border-radius: 0 var(--starmem-radius, 4px) var(--starmem-radius, 4px) 0;
    transition: background-color 180ms ease-out, border-color 180ms ease-out;
}

.starmem-viewer-episodic-item:hover {
    background: var(--starmem-bg-elevated);
    border-left-color: var(--starmem-accent);
}

.starmem-viewer-episodic-item-content {
    color: var(--starmem-fg);
    line-height: 1.4;
    word-break: break-word;
}

.starmem-viewer-episodic-item-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 0.8em;
    color: var(--starmem-fg-muted);
}

.starmem-viewer-episodic-item-importance {
    font-family: var(--monoFontFamily, monospace);
    opacity: 0.85;
}

.starmem-viewer-episodic-item-tag {
    padding: 1px 6px;
    border: 1px solid var(--starmem-border);
    border-radius: 999px;
    font-size: 0.9em;
}

.starmem-viewer-episodic-empty {
    padding: 24px 12px;
    text-align: center;
    color: var(--starmem-fg-muted);
}

.starmem-viewer-episodic-empty p {
    margin: 0 0 6px 0;
}

.starmem-viewer-episodic-empty-hint {
    font-size: 0.85em;
    opacity: 0.75;
}
```

The grid is single-column on the item itself (content row + meta row stack vertically); meta row is itself a flex row carrying importance + tags. This keeps density tight while letting tags wrap on narrow viewers.

**Step 4: episodic.js DOM tweak**

If the existing render path emits items without a wrapping list element, wrap them in `<div class="${CSS_PREFIX}-viewer-episodic-list">`. Within each item, separate content from meta:

```js
const item = document.createElement('div');
item.className = `${CSS_PREFIX}-viewer-episodic-item`;

const content = document.createElement('div');
content.className = `${CSS_PREFIX}-viewer-episodic-item-content`;
content.textContent = entry.content;

const meta = document.createElement('div');
meta.className = `${CSS_PREFIX}-viewer-episodic-item-meta`;

const importance = document.createElement('span');
importance.className = `${CSS_PREFIX}-viewer-episodic-item-importance`;
importance.textContent = `imp ${entry.lifecycle.importance}`;
meta.appendChild(importance);

for (const tag of entry.tags) {
    const tagEl = document.createElement('span');
    tagEl.className = `${CSS_PREFIX}-viewer-episodic-item-tag`;
    tagEl.textContent = tag;
    meta.appendChild(tagEl);
}

item.append(content, meta);
listEl.appendChild(item);
```

The existing tag-rendering test (`renders tags inline`) queries by `textContent` — moving tags into a `.starmem-viewer-episodic-item-meta` child still satisfies it because `.starmem-viewer-episodic-item.textContent` walks descendants.

**Step 5: Empty state**

Replace any bare empty-text emission with:

```js
container.innerHTML = `
    <div class="${CSS_PREFIX}-viewer-episodic-empty">
        <p>No episodic entries yet.</p>
        <p class="${CSS_PREFIX}-viewer-episodic-empty-hint">
            Entries appear after consolidation runs over the chat buffer.
        </p>
    </div>
`;
```

If the empty state is currently asserted by a test (check `viewer-tabs-episodic.test.js` for a `'No entries'` substring), update the assertion to match the new copy.

**Step 6: Run tests**

```bash
npm test -- tests/integration/integration/viewer-tabs-episodic.test.js
npm test -- tests/integration/integration/no-leaky-css.test.js
npm test -- tests/integration/integration/style-css-invariants.test.js
npm test -- tests/integration/integration/no-hardcoded-colors.test.js   # T2 gate
```

The header / item / sort assertions should all be green. If `renders tags inline` fails, walk the DOM under `.starmem-viewer-episodic-item` to confirm the new meta-row layout still surfaces the tag text.

**Step 7: Lint + typecheck + eyeball**

```bash
npm run lint
npm run typecheck
```

Eyeball: open Memory Viewer → Episodic tab on a chat with entries; verify items have the bordered-row look, hover lifts to accent, meta row sits below content in muted color. Switch ST themes (Default → whichever you daily-drive); confirm tokens cascade.

**Step 8: Commit**

```bash
git add src/integration/viewer/tabs/episodic.js style.css
git commit -m "style(viewer): episodic tab visual polish (P15 T7)

Two-row item layout: content (full text, normal weight) + meta
row (importance score in mono + tag pills, muted, smaller).

Items now have left-border + hover state that accents on hover
(uses --starmem-accent token). Empty state expanded from bare
text to centered two-line block with consolidation hint.

All existing classnames preserved (.starmem-viewer-episodic-header,
.starmem-viewer-episodic-item, #starmem-viewer-episodic-sort);
sort/filter logic unchanged. Tag rendering moved into a meta-row
child but textContent assertions still pass."
```

**Verification checklist:**

- [ ] `tests/integration/integration/viewer-tabs-episodic.test.js` green (5+ assertions)
- [ ] `tests/integration/integration/no-leaky-css.test.js` green
- [ ] `tests/integration/integration/style-css-invariants.test.js` green
- [ ] `tests/integration/integration/no-hardcoded-colors.test.js` green
- [ ] Manual: items render bordered with hover; meta row visible & muted; empty state centered; theme switch behaves

---
## Task 8: Settings panel layout pass

**Objective:** Tighten the settings panel's visual rhythm. The panel is rendered from an HTML template (`settings.html`) consumed via ST's `renderExtensionTemplateAsync`, then wired up by `settingsPanel.js` (no JS rendering of structure — just event binding). The template already uses `<details>/<summary>` collapsibles for grouping with four sections — Connection profiles, Triggers, Retrieval, Debug — plus an actions row and a live-region warnings block. This task is pure visual: typography hierarchy, row spacing, alignment, and the `--starmem-accent` left-rail treatment so each section reads as a distinct block.

**Files:**
- Edit: `settings.html` (HTML template — minor structural additions only; no group renaming or new fields)
- Edit: `style.css` (search `.starmem-settings*` block; extend or add)

**Methodology:** read the template + existing CSS, identify density/hierarchy issues, edit in place. Do **not** introduce a "Danger zone" group — `Reset to defaults` is non-destructive (re-applies defaults; the user's data isn't touched), and there is no `Clear all entries` button. Don't invent destructive UI in a polish task.

**Step 1: Read current state**

```bash
cat settings.html                                   # 65 lines, the template source
sed -n '/\.starmem-settings/,/^\.starmem-[^s]/p' style.css   # current settings rules
sed -n '76,100p' src/integration/settingsPanel.js    # render entry point
```

Confirm what exists:
- Top-level wrapper `.starmem-settings-panel`
- Title `.starmem-settings-title` ("STARmem"), subtitle `.starmem-settings-subtitle`
- Four `<details class="starmem-settings-section">` with `<summary>`: Connection profiles (open by default), Triggers, Retrieval, Debug
- Inside each section, `.starmem-settings-row` rows with `<label>` + `<input>` (range + select + checkbox + text)
- Range inputs are paired with `<span class="starmem-settings-value">` for the live numeric readout
- Actions row `.starmem-settings-actions` with two `<button class="menu_button">`: Reset, Open Memory Viewer
- Live region `#starmem-settings-warnings` with `aria-live="polite"`
- ST classes (`text_pole`, `menu_button`) are deliberately reused for native-look inputs/buttons — keep them

**Step 2: Polish targets**

1. **Section visual identity** — `<details>/<summary>` should read as a card with a subtle left rail accent on hover/open, not a flat indented line. Use `--starmem-accent` for the open-state rail.
2. **Row rhythm** — current `.starmem-settings-row` is likely `display: flex` or `display: grid` but rows may bunch up; lock to a two-column grid (label | input+value) with consistent vertical gap.
3. **Range + value pairing** — `<input type="range">` and its `<span class="starmem-settings-value">` should sit on one row; current rendering may stack vertically.
4. **Title/subtitle hierarchy** — confirm subtitle is muted (`var(--starmem-fg-muted)`), title uses normal body weight.
5. **Actions row** — buttons should sit right-aligned with comfortable padding and clear separation from the last `<details>`.
6. **Warnings region** — when populated, should look like an alert (subtle border, `--starmem-danger` accent), not blend into the section list.

**Step 3: Locked CSS**

Replace the `.starmem-settings*` block:

```css
/*
 * Settings panel — collapsible <details> sections with left-rail accent,
 * two-column rows, right-aligned actions, alerted warnings.
 */
.starmem-settings-panel {
    padding: 12px 4px 16px 4px;
    color: var(--starmem-fg);
}

.starmem-settings-title {
    margin: 0 0 2px 0;
    font-size: 1.1em;
    font-weight: 600;
}

.starmem-settings-subtitle {
    margin: 0 0 12px 0;
    font-size: 0.85em;
    color: var(--starmem-fg-muted);
    opacity: 0.85;
}

.starmem-settings-section {
    border: 1px solid var(--starmem-border);
    border-left: 3px solid var(--starmem-border);
    border-radius: var(--starmem-radius, 4px);
    background: var(--starmem-bg);
    padding: 0 12px;
    margin: 0 0 10px 0;
    transition: border-left-color 200ms ease-out;
}

.starmem-settings-section[open] {
    border-left-color: var(--starmem-accent);
}

.starmem-settings-section > summary {
    padding: 8px 4px;
    cursor: pointer;
    font-weight: 600;
    color: var(--starmem-fg);
    list-style: none;
}

.starmem-settings-section > summary::-webkit-details-marker {
    display: none;
}

.starmem-settings-section > summary::before {
    content: "▸";
    display: inline-block;
    width: 1em;
    color: var(--starmem-fg-muted);
    transition: transform 180ms ease-out;
}

.starmem-settings-section[open] > summary::before {
    transform: rotate(90deg);
}

.starmem-settings-row {
    display: grid;
    grid-template-columns: minmax(180px, 40%) 1fr auto;
    gap: 10px;
    align-items: center;
    padding: 6px 0;
}

.starmem-settings-row + .starmem-settings-row {
    border-top: 1px solid var(--starmem-border);
}

.starmem-settings-row > label {
    color: var(--starmem-fg);
    font-size: 0.9em;
}

.starmem-settings-row > input[type="checkbox"] {
    justify-self: start;
    grid-column: 2 / span 2;
}

.starmem-settings-row > input[type="range"] {
    width: 100%;
}

.starmem-settings-value {
    font-family: var(--monoFontFamily, monospace);
    font-size: 0.85em;
    color: var(--starmem-fg-muted);
    min-width: 4ch;
    text-align: right;
}

.starmem-settings-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 4px 4px 4px;
    border-top: 1px solid var(--starmem-border);
    margin-top: 8px;
}

.starmem-settings-warnings {
    margin-top: 10px;
    padding: 0;
}

.starmem-settings-warnings:not(:empty) {
    padding: 8px 12px;
    border: 1px solid var(--starmem-danger);
    border-left: 3px solid var(--starmem-danger);
    border-radius: var(--starmem-radius, 4px);
    background: var(--starmem-bg-elevated);
    color: var(--starmem-fg);
    font-size: 0.9em;
}
```

The `:not(:empty)` selector keeps the warnings region invisible when there are no warnings — no border, no padding, nothing. Aligns with Eva's "polished products" preference: empty UI shouldn't be visible.

**Step 4: HTML template — minor additions only**

The four-section structure is correct as-is. The single template change is to ensure each `<input type="range">` row has its `<span class="starmem-settings-value">` inside the same `.starmem-settings-row` (already true per the template) so the grid layout pairs them on one line.

If any range input rows have the value-span outside the row wrapper, move them inside. Confirm by reading lines 30–47 of `settings.html` — if all three range rows (buffer-size, idle-timeout, traces-max) have the structure:

```html
<div class="starmem-settings-row">
    <label for="...">…</label>
    <input type="range" id="..." />
    <span id="...-value" class="starmem-settings-value"></span>
</div>
```

then no template edit is needed.

**Step 5: settingsPanel.js — no changes**

This task is pure CSS + (possibly) one HTML structural confirm. Do not edit `settingsPanel.js`. Event wiring (`wireInputs`, `wireActions`, `populateProfileDropdown`, etc.) is correct.

**Step 6: Run tests**

```bash
npm test -- tests/integration/integration/settingsPanel
npm test -- tests/integration/integration/no-leaky-css.test.js
npm test -- tests/integration/integration/style-css-invariants.test.js
npm test -- tests/integration/integration/no-hardcoded-colors.test.js
```

The settings-panel test queries inputs by `id` (e.g. `#starmem-settings-buffer-size`) — invariant under CSS changes. Should pass without modification.

**Step 7: Lint + typecheck + eyeball**

```bash
npm run lint
npm run typecheck
```

Eyeball: open ST extensions drawer → STARmem panel; verify each `<details>` reads as a card with a left rail that brightens on open, ranges sit cleanly with their numeric readout right-aligned, actions row sits at the bottom with both buttons right-aligned, warnings region disappears when empty. Switch themes; rail accent + danger accent should follow the user's theme via `--starmem-accent` and `--starmem-danger` token cascade.

**Step 8: Commit**

```bash
git add settings.html style.css
git commit -m "style(settings): card-style sections + grid rows (P15 T8)

Settings panel polish — no logic, no field additions.

Sections: <details>/<summary> render as cards with a subtle left
rail (--starmem-border) that brightens to --starmem-accent when
the section is open. Custom marker (▸ rotating to ▾) replaces the
default disclosure triangle for visual consistency.

Rows: locked to a 3-column grid (label | input | value) so range
inputs and their numeric readouts pair on one line. Inter-row
hairline border replaces vertical gap.

Actions row: right-aligned, separated from the last section by
a top border.

Warnings region: invisible (zero padding, no border) when empty
via :not(:empty); becomes an alerted block (--starmem-danger
accent) when populated.

No HTML structural changes (template ranges already pair value
spans inside the row). No settingsPanel.js changes."
```

**Verification checklist:**

- [ ] `tests/integration/integration/settingsPanel*` green (id-based queries are invariant)
- [ ] `tests/integration/integration/no-leaky-css.test.js` green
- [ ] `tests/integration/integration/style-css-invariants.test.js` green
- [ ] `tests/integration/integration/no-hardcoded-colors.test.js` green
- [ ] Manual: four cards with rotating disclosure markers; left rail accents on open; range+value pair on one line; actions bottom-right; warnings invisible when empty, alerted when present; theme switch cascades via `--starmem-*` tokens

---
## Task 9: ARIA + keyboard navigation for viewer tabs

**Objective:** Add proper keyboard navigation and ARIA wiring to the Memory Viewer's tab strip (`src/integration/viewer/mount.js`). Current state: `role="tablist"` and `role="tab"` are present (lines 102–104) and `aria-selected` toggles correctly on click (lines 143/146), but there's no `aria-controls` linkage between tabs and panels, no keyboard arrow-key navigation, no `tabindex` management, and the close button is the only element a screen reader announces by name.

This is an accessibility task. None of it changes visual behavior; all of it changes how assistive tech and keyboard users experience the viewer.

**Files:**
- Edit: `src/integration/viewer/mount.js` (tab template + click handler)
- Add: `tests/integration/integration/viewer.a11y.test.js`

**Methodology:** WAI-ARIA Authoring Practices "Tabs with Manual Activation" pattern. Manual activation (Enter/Space to switch) rather than automatic activation (arrow keys switch) is the right choice here because each tab loads data and we don't want left-arrow-then-right-arrow to thrash the data fetch.

**Step 1: Locked ARIA shape**

Each tab button:
```html
<button type="button"
        role="tab"
        class="starmem-viewer-tab"
        data-tab="episodic"
        id="starmem-tab-episodic"
        aria-controls="starmem-panel-episodic"
        aria-selected="false"
        tabindex="-1">Episodic</button>
```

Tab panel:
```html
<div role="tabpanel"
     class="starmem-viewer-body"
     id="starmem-panel-episodic"
     aria-labelledby="starmem-tab-episodic"
     tabindex="0"></div>
```

Note: the current implementation has *one* `<div role="tabpanel">` body that swaps content on tab change. That's fine — the `id` and `aria-labelledby` get rewritten on tab switch alongside the content. Alternatively, render five hidden panels and toggle `[hidden]`. The single-body approach is simpler and matches existing render code.

Locked rule: only the active tab has `tabindex="0"`; all others have `tabindex="-1"`. This is the WAI-ARIA "roving tabindex" pattern — Tab key enters the tablist, lands on the active tab; arrow keys then move focus within the tablist.

**Step 2: Keyboard handler**

Add to the tablist setup in `mount.js`:

```js
function setupTabKeyboardNav(tabsEl, panelEl) {
    tabsEl.addEventListener('keydown', (ev) => {
        const tabs = Array.from(tabsEl.querySelectorAll('[role="tab"]'));
        const currentIdx = tabs.findIndex((t) => t === document.activeElement);
        if (currentIdx === -1) return;

        let nextIdx = -1;
        switch (ev.key) {
            case 'ArrowRight':
                nextIdx = (currentIdx + 1) % tabs.length;
                break;
            case 'ArrowLeft':
                nextIdx = (currentIdx - 1 + tabs.length) % tabs.length;
                break;
            case 'Home':
                nextIdx = 0;
                break;
            case 'End':
                nextIdx = tabs.length - 1;
                break;
            case 'Enter':
            case ' ': {
                ev.preventDefault();
                tabs[currentIdx].click();
                return;
            }
            default:
                return;
        }
        ev.preventDefault();
        tabs[nextIdx].focus();
        // Manual activation: focus moves but selection doesn't change
        // until Enter/Space.
    });
}
```

Call `setupTabKeyboardNav(tabsEl, bodyEl)` after the tabs render.

**Step 3: Roving tabindex on activation**

The existing tab-switch handler (lines ~140–150 of `mount.js`) toggles `aria-selected`. Extend it:

```js
function activateTab(tabName) {
    const tabs = tabsEl.querySelectorAll('[role="tab"]');
    tabs.forEach((btn) => {
        const isActive = btn.dataset.tab === tabName;
        btn.setAttribute('aria-selected', String(isActive));
        btn.tabIndex = isActive ? 0 : -1;
        btn.classList.toggle(`${CSS_PREFIX}-viewer-tab-active`, isActive);
    });
    bodyEl.id = `${CSS_PREFIX}-panel-${tabName}`;
    bodyEl.setAttribute('aria-labelledby', `${CSS_PREFIX}-tab-${tabName}`);
    renderTab(tabName, bodyEl);
}
```

`bodyEl.tabIndex = 0` and `bodyEl.role = 'tabpanel'` get set once at mount time.

**Step 4: Initial tab state**

When the viewer opens, the first tab (or last-active tab from state) gets `tabindex="0"` and `aria-selected="true"`; the rest get `tabindex="-1"`. Verify this matches the existing initial-render path in `mount.js` and adjust the initial render to match.

**Step 5: Close button label**

The close button at line 96 already has `aria-label="Close"` — upgrade to `aria-label="Close STARmem Memory Viewer"` for context. Keep `✕` as the visible text.

**Step 6: Add tab-panel ID setup at mount**

After the body element is created (line 107), set:

```js
bodyEl.id = `${CSS_PREFIX}-panel-episodic`;  // initial active tab
bodyEl.setAttribute('aria-labelledby', `${CSS_PREFIX}-tab-episodic`);
bodyEl.setAttribute('tabindex', '0');
```

The tab IDs are set in the template loop:

```js
btn.id = `${CSS_PREFIX}-tab-${t}`;
btn.setAttribute('aria-controls', `${CSS_PREFIX}-panel-${t}`);
```

**Step 7: Write the accessibility test**

Create `tests/integration/integration/viewer.a11y.test.js`:

```js
/**
 * @jest-environment jsdom
 *
 * Accessibility invariants for the Memory Viewer tab strip.
 * WAI-ARIA "Tabs with Manual Activation" pattern.
 */

import { openViewer, closeViewer } from '../../../src/integration/viewer/mount.js';

describe('viewer a11y — tabs', () => {
    afterEach(() => {
        closeViewer();
        document.body.innerHTML = '';
    });

    test('tablist has correct role + label', () => {
        openViewer({ chatId: 'test' });
        const tablist = document.querySelector('[role="tablist"]');
        expect(tablist).toBeTruthy();
    });

    test('exactly one tab has tabindex=0 (roving tabindex)', () => {
        openViewer({ chatId: 'test' });
        const tabs = document.querySelectorAll('[role="tab"]');
        const focusables = Array.from(tabs).filter((t) => t.tabIndex === 0);
        expect(focusables).toHaveLength(1);
    });

    test('aria-selected=true matches tabindex=0', () => {
        openViewer({ chatId: 'test' });
        const active = document.querySelector('[role="tab"][aria-selected="true"]');
        expect(active.tabIndex).toBe(0);
    });

    test('aria-controls IDs resolve to a tabpanel', () => {
        openViewer({ chatId: 'test' });
        const tabs = document.querySelectorAll('[role="tab"]');
        tabs.forEach((tab) => {
            const id = tab.getAttribute('aria-controls');
            expect(id).toBeTruthy();
            const panel = document.getElementById(id);
            // Single-panel implementation: only the active tab's controls
            // resolves to the live #starmem-panel-* element. That's WAI-ARIA-OK
            // because aria-labelledby on the panel rotates with selection.
            if (tab.getAttribute('aria-selected') === 'true') {
                expect(panel).toBeTruthy();
                expect(panel.getAttribute('role')).toBe('tabpanel');
            }
        });
    });

    test('ArrowRight moves focus to next tab', () => {
        openViewer({ chatId: 'test' });
        const tabs = document.querySelectorAll('[role="tab"]');
        tabs[0].focus();
        const ev = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true });
        tabs[0].dispatchEvent(ev);
        expect(document.activeElement).toBe(tabs[1]);
    });

    test('ArrowLeft from first tab wraps to last', () => {
        openViewer({ chatId: 'test' });
        const tabs = document.querySelectorAll('[role="tab"]');
        tabs[0].focus();
        const ev = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true });
        tabs[0].dispatchEvent(ev);
        expect(document.activeElement).toBe(tabs[tabs.length - 1]);
    });

    test('Home key moves focus to first tab', () => {
        openViewer({ chatId: 'test' });
        const tabs = document.querySelectorAll('[role="tab"]');
        tabs[2].focus();
        const ev = new KeyboardEvent('keydown', { key: 'Home', bubbles: true });
        tabs[2].dispatchEvent(ev);
        expect(document.activeElement).toBe(tabs[0]);
    });

    test('Enter activates focused tab (manual activation)', () => {
        openViewer({ chatId: 'test' });
        const tabs = document.querySelectorAll('[role="tab"]');
        tabs[0].focus();
        // Move focus without activating
        tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        expect(document.activeElement).toBe(tabs[1]);
        expect(tabs[0].getAttribute('aria-selected')).toBe('true');  // unchanged
        // Now activate
        tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(tabs[1].getAttribute('aria-selected')).toBe('true');
        expect(tabs[0].getAttribute('aria-selected')).toBe('false');
    });

    test('close button has descriptive aria-label', () => {
        openViewer({ chatId: 'test' });
        const closeBtn = document.querySelector('[class*="viewer-close"]');
        const label = closeBtn.getAttribute('aria-label') || '';
        expect(label.toLowerCase()).toContain('memory viewer');
    });
});
```

**Step 8: Run tests**

```bash
npm test -- tests/integration/integration/viewer.a11y.test.js
npm test -- tests/integration/integration/viewer.mount.test.js  # invariant gate
```

The new file should pass; the existing mount test should remain green (DOM class names and structure are preserved).

**Step 9: Lint + typecheck**

```bash
npm run lint
npm run typecheck
```

**Step 10: Commit**

```bash
git add src/integration/viewer/mount.js tests/integration/integration/viewer.a11y.test.js
git commit -m "feat(viewer): keyboard nav + ARIA wiring for tab strip (P15 T9)

WAI-ARIA \"Tabs with Manual Activation\" pattern:

- aria-controls/aria-labelledby linkage between tabs and the
  shared body panel (id rotates on activation)
- Roving tabindex: only the active tab has tabindex=0
- Arrow keys (Left/Right/Home/End) move focus within the tablist
- Enter/Space activate the focused tab (manual activation —
  focus and selection are decoupled to avoid thrash)
- Close button aria-label upgraded to 'Close STARmem Memory Viewer'

New test: tests/integration/integration/viewer.a11y.test.js
covering the 9 invariants. Existing viewer.mount.test.js
remains green."
```

**Verification checklist:**

- [ ] `tests/integration/integration/viewer.a11y.test.js` 9/9 green
- [ ] `tests/integration/integration/viewer.mount.test.js` green (regression gate)
- [ ] `npm test` 97+ suites passing (1 new suite from this task)
- [ ] Lint + typecheck green (modulo the 3 pre-existing tests/ errors)
- [ ] Manual: Tab key into the viewer lands on the tablist; arrow keys move focus visibly; Enter activates; screen reader (VoiceOver / NVDA) announces "Memory Viewer, tablist, Episodic tab, 1 of 5"

---

## Phase 15 closure

### Exit criteria

Phase 15 is **shipped** when all of the following hold:

- [ ] All 9 tasks committed on `main` (or your preferred merge target — same convention as Phase 14)
- [ ] `npm test` ≥ 98 suites / ≥ 980 tests green (was 97 / 973 at Phase 14 close; T2 + T9 each add a suite, T1 adds a Playwright suite that jest skips, T4 likely adds tests, T5 may add tests)
- [ ] `npm run test:e2e` either passes 8 smoke tests or skips 8 cleanly (no errors)
- [ ] `npm run lint` 0 errors (warning count may shift; track but don't gate)
- [ ] `npm run typecheck` no *new* errors beyond the 3 pre-existing in `tests/`
- [ ] `style.css` post-T3 sweep: every color token uses `var(--SmartTheme*, fallback)` form
- [ ] No CSS-related test (`no-leaky-css`, `style-css-invariants`, `no-hardcoded-colors`) flags any source file
- [ ] Memory Viewer Traces tab renders consolidation events (T4) and uses post-Phase-14 labels (T5) — eyeballed in a chat with at least one consolidation trace
- [ ] Memory Viewer is keyboard-navigable end to end: open via settings button → Tab into tablist → arrow keys cycle → Enter activates → Esc or close button closes
- [ ] `docs/plans/phase-15-retro.md` written and committed (template below)
- [ ] `docs/plans/ROADMAP.md` updated with a Phase 15 heading at the top, format matching Phase 14's entry

### Task dependency graph

```
T0 (commit plan)
 │
 ├─ T1 (Playwright smoke harness)               [independent]
 │
 ├─ T2 (no-hardcoded-colors invariant)
 │   │
 │   ├─ T3 (style.css minimalist sweep)         [T2 gates regressions]
 │   │   │
 │   │   ├─ T6 (indicator visual)               [T3 establishes fallback discipline]
 │   │   ├─ T7 (episodic tab visual)            [T3 establishes fallback discipline]
 │   │   └─ T8 (settings panel layout)          [T3 establishes fallback discipline]
 │
 ├─ T4 (Traces tab consolidation events)        [independent — different file]
 │   │
 │   └─ T5 (Traces tab ladder relabel)          [touches same file as T4]
 │
 └─ T9 (viewer keyboard nav + ARIA)             [independent — adds new test, edits mount.js only]
```

**Recommended execution order:** T0 → T1 → T2 → T3 → T6 → T7 → T8 → T4 → T5 → T9.

T1 first establishes the e2e substrate; subsequent UI changes can be smoke-tested as they land. T2 before T3 means the hardcoded-color guard catches any backsliding during the style.css sweep. T6/T7/T8 chain after T3 because they all benefit from T3's fallback discipline. T4/T5 are a tight pair on the same file. T9 is the cleanest task and a good closer.

**Parallelization:** T1, T4 (after T2/T3), and T9 can be dispatched as subagents per `subagent-driven-development` since they touch disjoint files. T2/T3/T6/T7/T8 must run sequentially in the controller because they share `style.css`.

### Surprise capture

Per the post-Phase-14 amendment to `plan-preflight-audit`: live observations during this phase need post-hoc validation against persisted state before they become retro findings. If you spot something during a task (e.g., "Tier 2 toggle still rendering in settings panel," "ST drawer animation conflicts with viewer mount timing," "indicator pulses while floating fallback animation lags"), file it in `/tmp/p15-surprises.md` with a one-line description + which task surfaced it + whether you have persisted evidence (commit, screenshot, log). Promote to the retro only if persisted evidence exists.

### Retro template (`docs/plans/phase-15-retro.md`)

```markdown
# Phase 15 retro — UI/UX polish

**Status:** Shipped <date>
**Commits:** <range>
**ROADMAP entry:** Phase 15 — UI/UX polish

## What shipped

| Task | Commit | Notes |
|---|---|---|
| T1 | <sha> | Playwright narrow harness |
| T2 | <sha> | no-hardcoded-colors invariant |
| T3 | <sha> | style.css fallback sweep (N rules touched) |
| T4 | <sha> | Traces tab consolidation events |
| T5 | <sha> | Traces tab ladder relabel |
| T6 | <sha> | Indicator subtle dot + halo pulse |
| T7 | <sha> | Episodic tab visual polish |
| T8 | <sha> | Settings panel grouped fieldsets |
| T9 | <sha> | Viewer keyboard nav + ARIA |

## Test counts

- jest: NN suites / NNN tests (was 97/973)
- pytest (bench/modal): unchanged
- playwright: 8 smoke tests (skip-clean against missing local ST)

## Surprises (with persisted evidence only)

- (fill in from /tmp/p15-surprises.md, drop unverified)

## Notes for Phase 16

- **Broad behavioral E2E** (deferred from T1): interceptor pipeline, consolidation triggers, persistence across reload, theme matrix
- **(any UI debt that surfaced during T6/T7/T8 polish but didn't fit a same-task fix)**

## Notes for v2.1 (retrieval-side, parked from Phase 14)

(unchanged — see Phase 14 retro §6)

1. `_should_amend` correctness-knob mode
2. λ₁ structural fix
3. Pre-warmed Modal containers for variance-bound sweeps
4. Abstention scoring
5. Zep / Mem0 / Mem3 / MemGPT external baselines
6. LongMemEval `_oracle` / `_m` variants
7. `bench/modal/rerender.py` disposition
8. Live-observation post-hoc-validation rule
```

### ROADMAP entry shape

Prepend to `docs/plans/ROADMAP.md` (matches Phase 14 format):

```markdown
## Phase 15 — UI/UX polish (shipped <date> @ <last-sha>)

Clean UI/UX lane after v2.0 settled. Playwright narrow E2E harness (smoke,
not behavioral). style.css fallback sweep + two new invariant tests
(no-hardcoded-colors, style-css-invariants extension). Memory Viewer
Traces tab renders consolidation events, ladder labels updated for
post-Phase-14 reality. Indicator + episodic tab + settings panel visual
passes. Viewer tabs are now keyboard-navigable with full ARIA wiring.

Broad behavioral E2E and v2.1 retrieval candidates deferred. See
phase-15-retro.md for surprises and Phase 16 handoff notes.
```

---

## Cross-cutting reminders

1. **No build step.** Per `AGENTS.md`: ST loads `index.js` directly. Anything in `devDependencies` (Playwright, jest, eslint, tsc) is dev-time only. No transpilation, no bundling.
2. **No runtime `node_modules` imports.** Pure-JS only. Vendor anything you need into `src/vendor/` (already established for SHA-256 — see Phase 14 security batch).
3. **Theme inheritance via global CSS.** Every color in `style.css` is `var(--SmartTheme*, sane-fallback)`. The fallback exists so the extension is usable in a fresh ST install before the user's theme loads; the var ensures any theme override wins.
4. **`starmem-` class prefix discipline.** `no-leaky-css.test.js` enforces this structurally. Don't break it.
5. **One-line commit subjects, multi-line bodies.** Match the Phase 14 style: scope tag (`feat`/`fix`/`docs`/`style`/`test`/`chore`), parenthesized area, short subject, blank line, paragraph-per-rationale-point body, optional trailing task tag like `(P15 T6)`.
6. **Eva pushes commits.** Don't `git push` from the controller — leave commits on `main` for Eva to push when she's ready, matching Phase 14 close convention.
7. **Live observations need post-hoc validation.** File surprises in `/tmp/p15-surprises.md` during the phase; promote to retro only with persisted evidence (commit, screenshot, log).

---

**End of plan.**
