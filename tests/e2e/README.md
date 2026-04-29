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
