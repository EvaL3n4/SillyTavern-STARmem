# Phase 15 Retro — Theme-Inheritance Hygiene + E2E Smoke Harness (2026-04-29)

**Plan:** [`phase-15-ui-ux.md`](./phase-15-ui-ux.md) (rescoped — closed early at T3)
**Shipped:** 2026-04-29 at commit `aca9841` (T3); this retro is the closing commit
**Scope (as shipped):** Three structural pieces — Playwright smoke harness (T1), `no-hardcoded-colors` JS guard (T2), `style.css` theme-token audit + `--starmem-overlay` (T3). Five tasks (T4–T9) drafted but **not shipped** — collapsed during a mid-phase visual eyeball check.

---

## 0. The honest title

The plan was filed as **"UI/UX Polish + Playwright E2E Foundation."** That framing was wrong, and the rescope is the central narrative of this phase. What actually shipped is **test infrastructure + theme-contract hygiene** — load-bearing structural work that we packaged under a "polish" banner because we wanted permission to also do the visual tasks downstream. The visual tasks turned out to be unnecessary. The structural pieces stand on their own.

The retro therefore retitles the phase: **"Phase 15 — Theme-Inheritance Hygiene + E2E Smoke Harness."** Future ROADMAP / pull-forward references should use that name.

---

## 1. What shipped

| # | Task | Commit | Notes |
|---|---|---|---|
| 0 | Plan | `dbb71e0` | 2291-line plan, 9 tasks. Now annotated with rescope notice; tasks 4–9 preserved as historical draft. |
| 1 | Playwright E2E smoke harness | `07ff23d` | `@playwright/test 1.59.1` devDep, 4 spec files (load, settings, viewer, indicator), 9 happy-path tests against a local ST. `fullyParallel: false`, `workers: 1`, `retries: 0` — deterministic, no flake masking. README scopes Phase 15 vs. future phases. |
| 1.5 | E2E skip-path bugfix | `7c2a8b3` | Fixture's `test as base` re-export + `test.skip(...)` inside helper threw `ReferenceError` instead of skipping cleanly when ST was offline. Direct `import { test }` resolves it. Caught at code-review time, before trusting the harness. |
| 2 | `no-hardcoded-colors` JS guard | `12aa073` | Third CSS-hygiene invariant joining `no-leaky-css` and `style-css-invariants`. Walks `src/integration/**/*.js`, regexes `.style.X = '...'` / `.style.cssText = '...'` / `setAttribute('style', '...')` for hex/rgb/rgba/hsl literals. `// exempt: <reason>` opt-out. Tripwire-verified by injecting `'#ff0000'` into `indicator.js` and watching the guard fire with file:line:snippet identification. Sentinel reverted via `git checkout` on the single tracked file (clean alternative to `patch()` here since the only other uncommitted work was the new untracked test file itself). |
| 3 | `style.css` theme-token audit | `aca9841` | Three audit hits resolved: `--starmem-bg-elevated` derived via `color-mix(in srgb, BodyColor 6%, BlurTintColor)` instead of misusing `--SmartThemeShadowColor`; `--starmem-danger` dropped its `var(--SmartThemeErrorColor, ...)` indirection (the key doesn't exist in stock ST — verified against `public/themes.json` — so the lookup always fell through); `--starmem-overlay` introduced for the `rgba(0, 0, 0, 0.55)` modal backdrop literal at line 161. Stale `/* exempt: ::backdrop ... */` comment removed (the invariants test only scans `.X`/`#X` selectors, never did anything for `::backdrop`). Step 4 of the plan ("sweep rule bodies for direct `var(--SmartTheme*)` usages") found nothing — already DRY. |

**Total: 5 commits** across the phase (`dbb71e0..aca9841`). Phase 14 was ~13. The 5-commit count reflects the rescope, not project velocity.

### Test counts

- **Phase 14 close (entry):** 97 suites / 973 tests (jest), 58 tests (pytest bench/modal)
- **Phase 15 close:** **98 suites / 974 tests (jest, +1 suite +1 test from T2)**, 58 tests (pytest, unchanged)
- **E2E (separate runner):** 9 Playwright tests, never invoked by `npm test`. Run via `npm run test:e2e` against a live local ST.
- All green, zero regressions.

### What did NOT ship

- T4 — Memory Viewer Traces consolidation events
- T5 — Post-Phase-14 ladder relabeling in Traces tab
- T6 — Consolidation indicator visual treatment
- T7 — Memory Viewer episodic tab visual polish
- T8 — Settings panel layout pass
- T9 — ARIA + keyboard navigation for viewer tabs

T4, T5, and T9 are functional/structural and survive as candidates for a future phase. T6/T7/T8 are dropped entirely; the visual eyeball verdict was that they are corncob-polishing inside ST's own visual ceiling.

---

## 2. The rescope (the central event of this phase)

After T3 shipped clean, Eva opened ST locally with the extension loaded and shared a screenshot for the visual smoke that T3 Step 6 had asked for. Vision read: *"a tall, narrow dark-themed configuration panel laid out as a single column of labeled form controls grouped under three collapsible headings... mostly **calm** throughout — generous spacing, single column, no competing visual elements."* Vision flagged the trivia (default-styled slider thumbs, `▼` glyphs on `<details>`, the blue Debug play-icon as the only saturated color) but no real visual problems.

Eva's read of the screenshot: *"It's, hm, very SillyTavern. Let's be honest, ST isn't known for its looks."* Then: *"Throw it away. Forget the plan's general idea. It's just plain not good... what about it if the extension looks horrendous on its own? Mostly throwing shade at myself here."*

The honest read: **STARmem is a guest in ST's house.** ST's UI is intentionally information-dense — `<details>` drawers, multiple-select dropdowns, sliders without custom thumbs, generic icon buttons — because the product surfaces a lot of state (chat, characters, world info, prompts, samplers, three drawers full of toggles). That's not a flaw to polish *around*; it's the product's identity. Trying to make our corner of the house "designed" while the rest is `<details>` and `select` is exactly the corncob.

T2 and T3 had already done the load-bearing part of what we *thought* we needed: the JS-side theme contract is now structurally enforced (T2), and the CSS-side token sweep is honest about what `--SmartTheme*` keys actually exist (T3). Visual polish T6/T7/T8 was downstream of those, and once the structural ceiling was visible, the polish work had nowhere meaningful to go.

The rescope chose the honest exit over momentum: close the phase at T3, retitle to match what shipped, write this retro, file the structural-but-not-cosmetic survivors (T4, T9) as honestly-named candidates for a future phase.

---

## 3. Lessons

### 3.1 Don't bundle structural work with cosmetic work as a single phase

This is the central lesson. The Phase 15 plan packaged three structural items (Playwright harness, JS color guard, CSS token audit) with six cosmetic items (T6–T9 visual tweaks, T4–T5 trace UI extensions) under a unifying "UI/UX polish" banner. The structural work was the *real* deliverable; the cosmetic work was the carrot that justified spending a phase on it.

The packaging masked two distinct acceptance criteria:

- **Structural work** ships when tests pass and invariants hold. Acceptance is mechanical.
- **Cosmetic work** ships when a human eyeballs it and says "good enough." Acceptance is judgement.

When the eyeball check landed on "the host UI's own ceiling caps any improvement we'd make in our corner," the cosmetic acceptance criterion failed — but the structural acceptance criterion had already succeeded. Without separation, the phase would have either (a) shipped cosmetic work the eyeball check would reject, or (b) sat in limbo until someone forced a verdict.

**For Phase 16+:** when a phase contains both, file two separate plans (or two clearly-bounded sub-phases) so the verdicts can land independently. If structural work has its own justification ("we need this test infra," "we need this token discipline"), it doesn't need cosmetic work to ride along.

### 3.2 Eyeball checks are valid acceptance gates — schedule them earlier in cosmetic phases

T3 Step 6 specified the eyeball check, and that step is exactly what surfaced the rescope. The check worked as designed. The retrospective shape of the lesson is: **schedule the eyeball check as the first downstream task, not the last upstream verification.** If T3 Step 6's eyeball had run before T6/T7/T8 were drafted in detail, the plan would have collapsed two days earlier and the 2291-line draft would have been a 600-line one.

For phases that mix structural and cosmetic: treat the cosmetic eyeball as a **gate** (does cosmetic work make sense here?) rather than a **smoke** (did our cosmetic work land cleanly?). Same tool, different position in the pipeline.

### 3.3 Visual ceilings are real and host-imposed

STARmem's visual surface is bounded by ST's CSS contract (we use `var(--SmartTheme*)` so we inherit ST's theme) and by ST's own visual identity (info-dense, utilitarian, drawer-heavy). Both are deliberate constraints, not accidents we can polish around.

When designing visual work for a host-embedded extension:
- **Identify the host's visual ceiling first.** What's the host's design language? What are the user's expectations of the host?
- **Ask whether visual polish would fight the ceiling or complement it.** STARmem polish would fight: a "designed" corner inside an undesigned house reads worse than a consistent house.
- **Default to inheriting** when the answer is "fight."

The structural work (theme inheritance via `var(--SmartTheme*)`, hardcoded-color guard, overlay token) is exactly the right shape: it makes us a *better-behaved* guest, not a *prettier* one.

### 3.4 The plan-preflight-audit skill caught a structural gap, but not the framing gap

The plan was preflight-audited and the structural specifics were sound: regex patterns, line numbers, file paths, exempt-comment formats. What the audit didn't catch was the *framing*: that the phase had two acceptance criteria, that the cosmetic-side criterion would reject under visual reality, and that the structural-side criterion didn't need the cosmetic side to justify itself.

**Candidate plan-preflight-audit skill datapoint:** *"When a phase plan mixes structural work with cosmetic/visual work under a single banner, separate them into independent plans (or sub-phases) before drafting tasks. Different acceptance criteria require different verdicts; bundling them masks the verdict on either side. Field-validated by Phase 15 STARmem rescope."*

I'd file this as a candidate but defer the actual skill patch — one datapoint isn't a pattern yet, and the two-acceptance-criteria framing might be redundant with the existing scope-mismodel content. Re-evaluate after the next phase that mixes the two.

---

## 4. Notes for Phase 16+ (or whichever phase next)

### Pull-forward candidates surviving rescope

- **Memory Viewer Traces tab — consolidation events.** T4's content survives. Trace shape was scoped (`{kind, timestamp, chatId, summary, durationMs, extractor}`). Worth shipping when there's a concrete consumer (e.g., debugging a consolidation issue, or surfacing extractor-cost rollup). **Not** as polish.
- **Post-Phase-14 ladder relabeling in Traces tab.** T5's content survives. Mechanical label change; valuable for honesty (Tier 2 is gone; the user-visible label should reflect that). Cheap to ship in a small mixed-bag phase.
- **ARIA + keyboard navigation for viewer tabs.** T9's content survives. Real accessibility value, distinct from cosmetic polish. Worth shipping when there's a decision to commit to a11y as a project value (we haven't made that commitment yet — Phase 15 was implicitly going to via T9).

### What to NOT do

- **Do not re-attempt T6/T7/T8** as written. The visual ceiling makes them corncob work.
- **Do not bundle structural work with cosmetic work** as a single phase plan again without explicitly tagging acceptance criteria per task.
- **Do not write a phase header that promises both** (e.g., "polish + foundation"). Pick one as the lede.

### Test infrastructure now available downstream

- Playwright E2E harness at `tests/e2e/`. Phase 16+ can extend with broader behavioral tests (interceptor pipeline, consolidation triggers, persistence, theme matrix) without re-installing or re-configuring. Adding a new spec file is the unit of growth. The "skip cleanly when ST is offline" contract is enforced (post-`7c2a8b3`).
- Three CSS-hygiene invariants (`no-leaky-css`, `style-css-invariants`, `no-hardcoded-colors`) form a structural triad. Future visual work that's *worth shipping* will pass through these; future visual work that *isn't* will be caught.
- `--starmem-overlay` token is in place for any future modal-style surface; reuse it rather than re-introducing `rgba(0, 0, 0, 0.X)` literals.

---

## 5. v2.1 candidates filed from Phase 15

1. **Two-criteria phase decomposition rule** (lesson 3.1 above). Candidate skill datapoint for `plan-preflight-audit` — file under skill-update-candidates if a second confirming case lands.
2. **Eyeball-as-gate-not-smoke rule** (lesson 3.2). Candidate planning practice for cosmetic-heavy phases. May be obvious enough not to formalize.
3. **T4 — Traces consolidation events** when a concrete consumer surfaces. Trace shape is pre-scoped in `phase-15-ui-ux.md` Task 4.
4. **T9 — Viewer ARIA + keyboard nav** when a11y becomes an explicit project value. Plan content is reusable.
5. **T5 — Tier label honesty in Traces tab.** Mechanical, ship when convenient.

---

---

## 6. Amendment 2026-04-29 — host-ceiling lesson is conditional on use mode

The §3.3 lesson ("Visual ceilings are real and host-imposed") and the §4
prohibition ("Do not re-attempt T6/T7/T8") were correct under the framing
in effect when this retro was written: STARmem as a private internal tool,
where polish-fighting-host-ceiling is corncob work because no one outside
the author sees the result.

**Public ship inverts the calculus.** The extension installer experiences
STARmem's surface *as the product*, not as "ST with a corner that doesn't
matter." First impressions of a public release weight visual quality high
enough that the ceiling argument no longer dominates. Phase 16
(`docs/plans/phase-16-public-ship.md`) re-opens T6/T7/T8 as cosmetic tasks
under a custom visual identity ("Quiet Library") and ships the
public-readiness pass alongside.

**The amended lesson.** *Visual ceilings are real and host-imposed —
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

---

**End of retro.**
