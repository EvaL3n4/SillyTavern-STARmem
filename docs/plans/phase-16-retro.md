# Phase 16 Retro—Public Ship: UI/UX Identity + Structural Survivors (2026-04-30)

**Plan:** [`phase-16-public-ship.md`](./phase-16-public-ship.md)
**Shipped:** 2026-04-30 at commit `5195b2e` (T9); this retro is the closing commit
**Tag:** `2.0.0` pushed to `origin` (commit `5195b2e`)
**Scope (as shipped):** Eleven tasks (T0–T9 + T0.5 install conventions doc) executed strict-serial. Quiet Library visual identity landed (token system + serif display face + staged viewer entrance), three Phase-15 structural survivors (T4/T5/T9-as-T2/T3/T8) wired in honestly, three cosmetic successors (T6/T7/T8-as-T5/T6/T7) shipped under per-task eyeball gates, and the public-ship pass (manifest 2.0.0-dev → 2.0.0, README rewrite + screenshot, CHANGELOG from scratch, `docs/install.md`, repo metadata + tag) closed the v2.0 cycle.

---

## 0. The honest title

The plan was filed as **"Public Ship: UI/UX Identity + Structural Survivors."** That framing held end-to-end. No rescope. The Phase 15 retro's amendment (host-ceiling lesson is conditional on internal-vs-public use) was the precondition that made this phase coherent in the first place—without it, T6/T7/T8 were corncob; with it, they're product surface. Phase 16 is the reified version of "we changed our mind about whether this matters."

The phase title survives unchanged into the ROADMAP entry.

---

## 1. What shipped

| # | Task | Tag | Commit(s) | Notes |
|---|---|---|---|---|
| 0 | Phase 16 plan + Phase 15 retro amendment + ROADMAP forward pointer | `[doc]` | `2ecbf02`, `4e6cb50` | 2837-line plan. Phase 15 retro §6 amends host-ceiling lesson as conditional on internal-vs-public use mode. ROADMAP gets a forward pointer to the new phase. `4e6cb50` applies Eva's preferences after the initial draft (dating, voice, plan-doc shape). |
| 0.5 | Extension-install conventions reference doc | `[doc]` | `37d63b0`, `fa44a26` | `docs/references/extension-install-conventions.md`. Codifies how SillyTavern installs extensions (git clone only, no build step, no `npm install` at install time, runtime-vs-devDep boundary). The doc that should have existed before Phase 15—it makes the public-ship constraints legible without re-deriving them. `fa44a26` applies Eva's voice preferences. |
| 1 | Identity mockup—Quiet Library | `[cosmetic]` | `2b949b1` | `docs/examples/identity-mockup-quiet-library.html` standalone. Eyeball-as-gate pattern: Eva approves the identity in isolation before any T4–T8 implementation work begins. Token decisions (typography, spacing, elevation, radius, motion) ratified here, applied downstream. |
| 2 | T4 Traces consolidation events | `[structural]` | `3c8d939` | Trace shape `{kind: 'consolidate', timestamp, chatId, summary, durationMs, extractor}` wired into `src/consolidation/consolidate.js`; viewer Traces tab renders consolidate-kind rows alongside retrieval-kind rows. Pre-scoped from Phase 15 T4. Tests: `tests/unit/integration/viewer/traces-consolidation.test.js` (1 suite, 6 tests). |
| 3 | T5 Tier label honesty | `[structural]` | `660ddca` | Post-Phase-14 ladder relabel: `T0 / T1 / T3 / Floor`, with legacy `T2` historical entries backfilled to `T3` since seed-into-Tier-3 is what historical Tier 2 hits exercised. New `formatTierLabel()` exposed from `src/integration/viewer/tabs/traces.js` for the test surface. Pre-scoped from Phase 15 T5. Tests: `tests/unit/integration/viewer/traces-tier-labels.test.js` (1 suite, 6 tests). |
| 4 | T4 Quiet Library token system + viewer shell | `[cosmetic]` | `3450916`, `80eb017` | `style.css` token system (typography stack with serif display face, spacing scale, elevation, radius, motion); staged 600ms viewer entrance reveal respecting `prefers-reduced-motion`; ST popup CSS-cascade fixes for the new tokens. `80eb017` files T4 deferred follow-ups (settings panel + tab layout) as a doc note rather than scope-creeping into T4. Eyeball-approved. |
| 5 | T6 Indicator visual treatment | `[cosmetic]` | `bf49233` | Quiet Library accent pulse + responsive anchor for the consolidation indicator. Eyeball-approved. |
| 6 | T7 Episodic tab visual | `[cosmetic]` | `eae87da`, `59f48aa` | Subject-grouped entry list with display headings + dotted separators using Quiet Library tokens. `59f48aa` follows up with a popup scroll-chain bounce fix surfaced during eyeball verification. Eyeball-approved. Tests: `tests/unit/integration/viewer/episodic-grouping.test.js` (1 suite, multiple tests). |
| 7 | T8 Settings panel | `[cosmetic]` | `93f0cd1`, `413ca97` | Display-font sections, 220px-label grid, tokenized inputs. `413ca97` closes an em-dash in the entry-count header per house style. Eyeball-approved. |
| 8 | T9 Viewer ARIA + keyboard navigation | `[structural]` | `55ebf67` | `tablist` / `tab` / `tabpanel` wired with `aria-selected` / `aria-controls` / `aria-labelledby`; roving `tabindex`; Arrow / Home / End / Enter handlers. Pre-scoped from Phase 15 T9; the explicit a11y commitment Phase 15 was implicitly waiting on landed here. Tests: `tests/unit/integration/viewer/viewer-aria.test.js` + `viewer-keyboard.test.js` (2 suites, ~15 tests). |
| 9 | Public-ship pass—manifest 2.0.0 + README + CHANGELOG + install + screenshot + repo metadata + tag | `[public-ship]` | `5195b2e` | manifest `2.0.0-dev` → `2.0.0`; README rewritten with three-line blockquote (option A—"no LLM on the query path" lede), screenshot embed, install block, citations footer; `CHANGELOG.md` from scratch summarizing Phases 0–16; `docs/install.md`; `docs/screenshots/viewer.png`. Six files, +198/-25. Tag `2.0.0` annotated and pushed to `origin`. |
| 10 | Phase 16 retro + ROADMAP entry | `[doc]` | _this commit_ |—|

**Total: ~12 commits** across the phase (`2ecbf02..HEAD`). Phase 15 was 5 (rescoped); Phase 14 was ~13. Phase 16 is squarely in normal-velocity territory for a non-rescoped phase.

### 1.x Test counts

- **Phase 14 close:** 97 suites / 973 tests (jest)
- **Phase 15 close (entry to Phase 16):** 98 suites / 974 tests (jest, **+1 / +1** from T2's `no-hardcoded-colors.test.js`)
- **Phase 16 close:** **105 suites / 1010 tests (jest, +7 suites / +36 tests from Phase 15 close)**, 58 (pytest bench/modal, unchanged), 9 (Playwright E2E, unchanged—runner discipline preserved)
- All green, zero regressions in the existing suite. New suites: T4 trace shape (1), T5 tier labels (1), T6 episodic grouping (1), T8 ARIA (1), T8 keyboard (1), T2 consolidation extractor wiring (1), plus minor companions.

### 1.y Lint and typecheck

- `npm run lint`: **0 errors, 10 warnings.** Baseline parity with Phase 15 close. Warnings are JSDoc-completeness drift in long-tail modules; not regression-introduced this phase.
- `npm run typecheck`: ~16 errors total. **Two are Phase-16-introduced**: T2's broader `Trace` shape (`{kind: 'consolidate', ...}`) doesn't satisfy the original `Trace` JSDoc typedef (which assumed retrieval-kind shape only); T6's `episodic-grouping.test.js` accesses `.value` on `Element` rather than `HTMLInputElement`. Both are JSDoc-narrowness issues, not runtime bugs—the runtime code is correct, the typedefs need broadening. Filed as v2.1 candidates (§5 below). The remaining ~14 errors are pre-existing `bench/` typedef gaps that predate Phase 15.

### 1.z Public-ship artifacts

- README.md—rewritten blockquote (option A: deterministic-retrieval lede), Citations footer with five papers (ByteRover, AdaMem, MAGMA, Enhanced RAPTOR, RAPTOR), screenshot under blockquote, install block.
- CHANGELOG.md—written from scratch summarizing Phases 0–16. Single 2.0.0 entry.
- docs/install.md—install / setup flow.
- docs/screenshots/viewer.png—production viewer screenshot under Quiet Library identity.
- manifest.json—version 2.0.0-dev → 2.0.0.
- Tag `2.0.0` (annotated `git tag -a 2.0.0 -m "STARmem v2.0.0—first public release"`) pushed to `origin`.

**Not yet shipped (Eva-deferred to handle outside the controller loop):** GitHub release publication (Eva is writing a custom release body separate from the CHANGELOG); `gh repo edit` description / topics. Both are independent of the retro commit and don't gate the phase boundary.

---

## 2. Decision audit

The Phase 16 plan opened with 14 framing decisions. Audit:

| # | Decision | Outcome | Notes |
|---|---|---|---|
| 1 | Strict-serial execution; no parallel work | **Held** | Per-task eyeball gates required serialization. Phase 15 lesson 3.1 (don't bundle structural with cosmetic without per-task acceptance criteria) was enforced via the `[structural] / [cosmetic] / [doc] / [gate] / [public-ship]` tagging. |
| 2 | Per-task acceptance tags drive verdict shape | **Held** | `[structural]` tasks shipped on jest-green; `[cosmetic]` tasks shipped on Eva-eyeball verdict; `[doc]` tasks shipped on internal review. No verdict-shape confusion this phase. |
| 3 | Quiet Library as the chosen identity (over alternatives) | **Held** | Identity chosen pre-T1; T1's mockup ratified it; T4–T8 implemented it. No drift. |
| 4 | Single token system, set in T4, reused throughout | **Held** | T5/T6/T7 all reference T4's `--starmem-*` tokens. No one-off literals introduced post-T4. The Phase 15 `no-hardcoded-colors` guard caught no regressions, which is the right shape—invariants quiet when followed. |
| 5 | Eyeball-as-gate (not smoke) for `[cosmetic]` tasks | **Held—and field-validated** | Eyeball verdicts ran *before* committing each cosmetic task and surfaced one in-flight followup (T6's scroll-chain bounce, `59f48aa`) and one micro-fix (T7's em-dash, `413ca97`). Both small; both caught early. Phase 15 lesson 3.2 promoted from speculative to confirmed. |
| 6 | Reference-extension calibration (MoonlitEchoes) | **Held** | Calibrated readme shape, screenshot placement, install block at T9. |
| 7 | `frontend-design` skill for identity ideation | **Held** | Used in pre-T1 ideation. Identity choice survived implementation contact—no major concept walk-back. The skill performed well at the pattern level (Quiet Library was a coherent, executable identity); see §3.3 for finer-grained notes. |
| 8 | Three structural survivors (T4/T5/T9 from P15) ship as Phase-16 T2/T3/T8 | **Held** | All three landed under their original Phase-15 specifications, with minor polish to align names/tests with current code. |
| 9 | T6/T7/T8 cosmetic successors ship under Quiet Library, not as Phase-15 drafts | **Held** | All three tasks reframed under the new identity. The Phase-15-original drafts of T6/T7/T8 are not the work that shipped here. |
| 10 | Plan-preflight-audit per task before subagent dispatch | **N/A—controller-only** | No subagents this phase (per execution-mode decision below). |
| 11 | Hybrid execution: controller for `[doc]` / `[gate]` / `[public-ship]`; subagent-friendly for `[structural]`; controller drafts + subagent dispatches for `[cosmetic]` | **Revised mid-phase** | All tasks executed controller-only. The `[structural]` tasks (T2/T3/T8) were small enough that controller overhead beat dispatch overhead, matching Phase 15's lesson on T1. The `[cosmetic]` "controller-drafts-then-dispatches" plan was correct in shape but unnecessary in practice—Eva's eyeball gate operates at the controller level naturally. Hybrid mode survives as a future-phase pattern when scope expands. |
| 12 | Phase-15 amendment (host-ceiling conditional) is the precondition | **Held** | Embedded in Phase 15 retro §6 at T0. Phase 16 doesn't make sense without it; the amendment exists so the framing question is settled before T1. |
| 13 | Manifest version bump is the single source of truth for "v2.0 ships" | **Held** | manifest 2.0.0 lands at T9; tag `2.0.0` follows the manifest. CHANGELOG / README reference `v2.0.0` per the package.json convention. (Tag uses `2.0.0`, not `v2.0.0`, per your call at ship time—both forms are valid; the choice was stylistic.) |
| 14 | Public-ship description and homepage as separate Eva-authored copy | **Held** | Eva opted to write the `gh repo edit` description independently rather than reusing the README blockquote. The new README blockquote (option A) and the repo description coexist as deliberately different surfaces—short repo description for one-liner discoverability, blockquote for landing-page first impression. |

**Net: 13 of 14 held; 1 revised (execution mode collapsed to controller-only).** The revision is honest scope-tightening, not framing failure.

---

## 3. Lessons

### 3.1 Eyeball-as-gate is the right primitive for cosmetic acceptance

Phase 15 retro §3.2 hypothesized the rule: in cosmetic-heavy phases, schedule the eyeball check as a **gate** before drafting downstream tasks in detail, not as a **smoke** after they're built. Phase 16 ran the experiment.

The verdict: **the rule works.** T1 (identity mockup) ran the eyeball check at the pre-implementation stage; the gate verdict carried through T4–T8 unchallenged. Per-task eyeball verdicts at each cosmetic commit caught two in-flight followups (`59f48aa`, `413ca97`) and zero rescopes. Compare to Phase 15, where the post-build eyeball verdict on T3 collapsed T6–T9.

The pattern promotes from "speculative practice" to "confirmed working primitive." Worth a `frontend-design` skill datapoint or a planning-skill addition; the field-validation now has both shapes (Phase 15 reactive, Phase 16 prospective).

### 3.2 Per-task acceptance tagging prevents the Phase-15 collapse shape

Phase 15 lesson 3.1 said: *don't bundle structural work with cosmetic work as a single phase without per-task acceptance criteria.* Phase 16 enforced this via the `[structural] / [cosmetic] / [doc] / [gate] / [public-ship]` tag system in the plan header.

The practical effect: when T2 (a `[structural]` task) shipped, the verdict was mechanical—does jest pass?—and didn't need an eyeball check. When T4 (a `[cosmetic]` task) shipped, the verdict was Eva's judgement, and didn't need test-count-delta evidence. The two acceptance criteria didn't have to compete for the same go/no-go decision because the tag pre-declared which one applied.

This is the structural fix to the Phase 15 framing failure. It survives Phase 16 unchallenged.

### 3.3 The `frontend-design` skill's identity-language abstraction held; its CSS-cascade specifics needed manual fix-up

The skill was used to ideate Quiet Library. The identity-language layer—typography hierarchy, spacing rhythm, motion philosophy, reduced-motion respect—translated cleanly into implementation. Token names, scale relationships, and the staged-reveal interaction all came out of the skill at high quality.

The CSS-cascade specifics were a different story. SillyTavern's popup component imposes its own CSS cascade, and the skill's general "use these tokens, write these rules" advice didn't account for the host-CSS competition that landed at T4 implementation time. T4's `3450916` commit message explicitly notes "ST popup cascade fixes" alongside the Quiet Library application—the host-cascade work was unscoped from the skill's output and had to be debugged manually.

**Datapoint for the skill:** when applying `frontend-design` output inside an embedded host context, plan additional time for cascade-conflict resolution at integration. Or, more usefully: add a "verify against host CSS in a live mock" step between `frontend-design` ideation and implementation. The Phase 15 `--starmem-overlay` token discipline and the Phase 16 `style.css` cascade fixes together suggest the gap is real and recurring; a single skill datapoint isn't enough to patch the skill yet, but the second confirming case is on file.

### 3.4 Reference-extension calibration is high-leverage and cheap

The MoonlitEchoes reference (per the install conventions doc T0.5 codified) calibrated the README shape, screenshot placement, install block, and topic discoverability. Lookup time: a few minutes. Effect: T9's `[public-ship]` pass was largely "match the reference, swap content," with no novel structural decisions. This is the right level of investment for a public-ship task—minimize novelty in surfaces where convention serves the user better than originality.

For future phases that ship publicly: do the reference-extension calibration up front. The install conventions reference doc Phase 16 created (T0.5) is the artifact; subsequent extensions can reuse it without re-deriving.

### 3.5 The Phase-15 amendment was load-bearing for Phase 16

Phase 15 retro §6 (host-ceiling lesson amended as conditional on internal-vs-public use) wasn't decorative. It was the framing precondition that made Phase 16 coherent. Without it, the cosmetic work in T4–T8 would have run into the same "ST's UI ceiling caps the upside" verdict that closed Phase 15 early.

**Lesson:** when a retro's amendment is the precondition for the next phase, the amendment lands at the start of the next phase's plan (T0), not as scattered prose elsewhere. Phase 16 T0 (`2ecbf02`) committed both the new plan *and* the Phase-15 amendment together. This is the right shape—the amendment isn't a Phase-15 artifact retroactively patched, it's a Phase-16 enabler, and the commit history reflects that.

---

## 4. Surprises

### 4.1 Hybrid execution mode collapsed to controller-only

The plan tagged some tasks for subagent dispatch and others for controller-only, intending mixed execution. In practice, every task ran under the controller. The `[structural]` tasks were small enough (one new test suite + one new function each, mostly) that dispatching to a subagent and waiting for a summary was strictly slower than direct execution. The `[cosmetic]` "controller-drafts-then-dispatches" pattern was unnecessary because Eva's eyeball gate is itself a controller-level interaction—there's no scope where the controller "writes the draft" and the subagent "applies it" that doesn't read as overhead given the per-task surface area.

Scope expansion in future phases (e.g., a graph-rebuild phase that touches twenty files at once, or a migration phase) would re-justify hybrid mode. Phase 16's surface was simply small enough that pure-controller was the right tool. This isn't a planning failure—it's calibration data for "below what scope threshold does subagent dispatch stop paying off."

### 4.2 The em-dash micro-fix at T7

`413ca97` closed an em-dash in the entry-count header. House style is closed em dashes everywhere (in prose AND user-facing UI strings). The slip happened during T7's tokenization pass—the original copy used a spaced em dash in the count header, the audit caught it on eyeball verification. Two-character commit. No drama, but worth noting as a data point: house-style invariants need the same eyeball discipline as visual tokens. A grep guard for `"—"` in user-facing strings would catch this class automatically; filing as a v2.1 candidate.

### 4.3 The popup scroll-chain bounce at T6

`59f48aa` followed up T6's episodic tab tokenization with a fix for a scroll-chain bounce caused by ST's popup overflow handling. Surfaced during eyeball verification. The followup is structural (a `overscroll-behavior: contain` style fix) rather than cosmetic, but landed inside the cosmetic-task commit chain because that's where it surfaced. No blast—but the pattern (cosmetic eyeball reveals structural integration issue) is worth noting: cosmetic work and structural integration aren't always cleanly separable, and the eyeball gate is the right time to catch the joint.

### 4.4 The repo description / blockquote distinction (Decision 14)

Eva's mid-T9 call to write the `gh repo edit` description independently from the README blockquote was a small but valuable distinction I hadn't anticipated. The README blockquote is the landing-page first impression—readable, principle-led, three lines. The repo description is the GitHub-list one-liner—discoverable, keyword-dense, ~120 chars. They're different surfaces with different audiences. Bundling them under "the same description" would have flattened both. Filing as a public-ship convention: surface-specific copy, not unified copy.

---

## 5. v2.1 candidates surfaced

1. **Pixel-snapshot tests for the viewer / settings panel.** Phase 16 shipped substantial visual surface under per-commit eyeball verdicts. Future regressions would benefit from automated snapshot comparison. Playwright-based pixel diff would extend the existing E2E harness without new tooling. Defer until a regression actually escapes the eyeball gate; the candidate is filed.
2. **`prefers-reduced-motion` test coverage.** T4's staged reveal respects the media query in CSS, but no test asserts the behavior under `forcedColors: 'active'` or reduced-motion fixtures. Add a Playwright spec covering the matrix when a11y becomes a v2.1 explicit project value.
3. **Light-theme + high-contrast theme matrix.** Phase 15 / 16 worked exclusively under Eva's local dark theme. The CSS-token discipline should make the extension theme-portable in principle, but it's untested. A theme matrix in the E2E suite would surface theme-conformance regressions early.
4. **House-style grep guard for em dashes in user-facing strings.** Phase 16 caught one slip (`413ca97`); a regex guard for `"—"` in `src/integration/**/*.js` and `src/**/*.html` would automate the catch. Companion to the existing CSS-hygiene invariants.
5. **`Trace` JSDoc typedef widening for consolidation events.** T2 introduced `{kind: 'consolidate', ...}` Trace shapes; the original typedef assumes retrieval-kind only. Two typecheck errors in `src/consolidation/consolidate.js` are the symptom. Right fix: widen `Trace` to a union `RetrievalTrace | ConsolidationTrace` and update consumers. Mechanical; defer to v2.1 typecheck-hygiene cleanup.
6. **`HTMLInputElement` cast in `episodic-grouping.test.js`.** T6's `.value` access on `Element` triggers one typecheck error. Fix: type-cast or refine the query selector return. Mechanical; same v2.1 typecheck-hygiene bucket as item 5.
7. **GitHub release body authoring as a separate ship-time task.** Phase 16 plan treated tag-and-release as one step; in practice, Eva separated them (tag at T9, release body authored independently outside the controller loop). Future public-ship phases should split: `[public-ship-tag]` for the tag, `[public-ship-release]` for the release body, with the latter explicitly Eva-authored.

---

## 6. Notes for v2.1+ phases

### Test substrate now available downstream

- **Playwright E2E harness** (since Phase 15)—extend with theme matrix, reduced-motion fixtures, pixel snapshots when v2.1 picks them up.
- **Three CSS-hygiene invariants** (`no-leaky-css`, `style-css-invariants`, `no-hardcoded-colors`)—gate visual work; held green through Phase 16 with no regressions.
- **Quiet Library token system** (`style.css`, since T4)—extend the token names rather than introducing new literals. The token discipline scales.
- **Trace shape extensibility**—T2's consolidation trace shape demonstrates the pattern for adding new trace kinds. v2.1 trace additions follow the same shape; the JSDoc typedef widening (item 5 above) makes the pattern type-clean.
- **Tier label honesty** (T3)—the `formatTierLabel()` function is the single source of truth for user-visible tier strings. Future tier additions / removals update it once.

### Public-ship discipline now available

- **Install conventions reference** (`docs/references/extension-install-conventions.md`, since T0.5)—no rederivation needed for future ST extensions.
- **README / install / CHANGELOG / screenshot shape** (since T9)—calibrated against MoonlitEchoes; subsequent public ships match the same shape.
- **Tag-then-release split discipline** (item 7 above)—future public-ship phases bake this in.

### What's still gating future visual work

- Theme matrix (light, high-contrast) untested.
- Pixel-snapshot regression catch absent—eyeball gate is the only guard.
- `prefers-reduced-motion` behavior untested.

These are honest gaps, not blockers. v2.1 picks them up if and when accessibility / cross-theme robustness becomes an explicit value commitment.

### What survives the v2.0 cycle

- The deterministic-retrieval principle (no LLM on the query path)—preserved end-to-end.
- The single-substrate context tree (ByteRover-derived)—preserved.
- The Working / Episodic / Persona scope vocabulary (AdaMem-derived)—preserved.
- The `mentions / supports / same_topic / temporal_next` edge-type set—preserved; `contradicts` stays reserved-not-produced.
- The 4-tier ladder with bounded floor (T0 / T1 / T3 / Floor)—preserved post-Phase-14 demolition.
- The latency budgets (Tier 0 <1ms, Tier 1 <5ms, Tier 3 <100ms, Floor <5ms)—preserved.

**Phase 16 closes the v2.0 cycle.** STARmem is publicly shipped at v2.0.0 (commit `5195b2e`, tag `2.0.0` on `origin`). The next phase is v2.1, scope TBD when a concrete need surfaces.

---

**End of retro.**
