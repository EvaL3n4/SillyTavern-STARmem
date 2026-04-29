# SillyTavern Extension Install Conventions

> Reference notes for STARmem's public-ship pass (Phase 16 Task 9). Captured
> from MoonlitEchoesTheme (RivelleDays) on 2026-04-29. Not normative —
> STARmem deviates where the deviation is honest (e.g. our 8K+ LOC + spec
> + benchmarking surface justifies a richer `docs/` tree than a typical
> UI/theme extension).

## 1. Reference extension

- **Name:** Moonlit Echoes Theme
- **Author:** RivelleDays
- **URL:** <https://github.com/RivelleDays/SillyTavern-MoonlitEchoesTheme>
- **Stars:** 316 (one of the most-installed visual extensions on the ST scene)
- **License:** AGPL-3.0
- **Latest tag at capture:** v3.1.0 (2026-01-12)
- **Note on naming:** The repo slug is `SillyTavern-MoonlitEchoesTheme`,
  not `SillyTavern-MoonlitEchoes`. The plan-author memory of "MoonlitEchoes"
  was close but wrong; the public artifact is the canonical reference.

## 2. README anatomy

| Section | MoonlitEchoes | STARmem default | Action for Task 9 |
|---|---|---|---|
| Hero image (top) | screenshot in `.github/ImagePreview/` | absent | **adopt** — viewer screenshot at `docs/screenshots/viewer.png` |
| One-line tagline | bold paragraph after H1 | first paragraph of design intro | rework to one bolded line |
| Cross-language link | English / 繁體中文 toggle line under H1 | absent | **skip** — STARmem is English-only at v2.0 |
| Inline preview grid | UI Interface / System Messages 2-col table | absent | **skip** — single screenshot is enough at v2.0 |
| Features | `## Features` with `### Core Features` subsection | partial | expand into structured list with sub-headings |
| Screenshots gallery | `## Screenshots` with 8 message-style examples | absent | **skip** — reading-room product, not a theme; one screenshot suffices |
| Installation | `# Installation` (H1) → `## Prerequisites` → `## Installation Steps` (numbered) | absent | **adopt the structured form** |
| Termux / mobile section | included since some users run ST on Android | absent | **skip** — STARmem doesn't have a mobile-specific install path |
| Usage guide | `# Usage Guide` after install | absent | **adopt minimal version** ("Verifying the install") |
| FAQ | `## FAQ` with 3 entries | absent | **skip at v2.0**, revisit if support volume justifies |
| Feedback & Suggestions | one-line link to Discord | absent | **skip** — GitHub Issues suffices |
| Special Thanks | acknowledgments paragraph | absent (citations exist instead) | **keep our citations**; they're our equivalent |
| License | `# License` H1 with one-line note | `## License` H2 with link | match — H2 + link is fine |

**Section-level pattern adopted:**
1. H1 title
2. Bold tagline (one line)
3. Hero screenshot
4. Features (structured list)
5. Installation (Prerequisites → numbered Steps)
6. Verifying the install (one paragraph)
7. Configuration (per-setting list)
8. Compatibility (requires / tested-on / not-migrated-from-v1)
9. Documentation (links to specs, install, wiki, bench, plans)
10. Citations (our distinguishing identity — keep)
11. License

## 3. Install instructions shape (the load-bearing reference)

MoonlitEchoes uses a numbered-step block under `## Installation Steps`:

```markdown
### 1. **Install Moonlit Echoes Theme**
In the **SillyTavern Extension Manager**, use "Install from URL" and paste the following Git URL:
   ```
   https://github.com/RivelleDays/SillyTavern-MoonlitEchoesTheme
   ```
```

For STARmem, the matched form (no extra steps needed since we don't ship
sidecar theme files, presets, or config-tweaks):

```markdown
### Install
In the SillyTavern **Extension Manager**, use "Install from URL" and paste:

```
https://github.com/<owner>/SillyTavern-STARmem
```

### Local clone (development)
```bash
cd <SillyTavern>/public/scripts/extensions/third-party
git clone https://github.com/<owner>/SillyTavern-STARmem.git
```
```

The "git URL inside a fenced code block" pattern is the load-bearing
visual signal — copy-paste-ready, same shape as every other ST extension
README on the scene.

## 4. manifest.json conventions (real fields, real casing)

MoonlitEchoes manifest:

```json
{
    "display_name": "Moonlit Echoes Theme",
    "description": "A modern, minimalist, and elegant theme for SillyTavern. Inspired by moonlit nights and gentle echoes of serenity.",
    "loading_order": 10,
    "requires": [],
    "optional": [],
    "js": "index.js",
    "author": "Rivelle <rivelle.days@gmail.com>",
    "version": "3.1.0",
    "license": "AGPL-3.0",
    "homepage": "https://github.com/RivelleDays/SillyTavern-MoonlitEchoesTheme",
    "auto_update": true,
    "i18n": { "...": "..." }
}
```

Field-by-field for STARmem:

- `display_name` — adopt (we have it as `STARmem` already; consider
  `STARmem — literary memory` for the marketplace-readable form, or keep
  it terse).
- `description` — adopt the one-line tagline shape. Keep it under 160
  chars for GitHub-card display.
- `loading_order` — **adopt 10** (early loading; matches the most-installed
  reference). STARmem mounts an interceptor + viewer + indicator and
  benefits from loading before chats render.
- `requires` / `optional` — **keep empty** (we have no soft requirements
  on other extensions).
- `js` — already `index.js`. Match.
- `css` — already `style.css`. Match.
- `author` — adopt the `Name <email>` form, or just `Name` if Eva
  prefers no public email.
- `version` — bump `2.0.0-dev` → `2.0.0`. Match the no-`-dev` convention.
- `license` — **add** `"Apache-2.0"` (we ship Apache 2.0; not currently in manifest).
- `homepage` — **add** (lowercase `homepage`, NOT `homePage`). Both
  spellings work in some contexts; lowercase is the community-canonical
  form and matches MoonlitEchoes.
- `auto_update` — **adopt `true`**. ST's extension manager will pull
  updates automatically; correct default for any actively-maintained
  public extension.
- `i18n` — **skip**. STARmem is English-only at v2.0.

## 5. CHANGELOG conventions

MoonlitEchoes does **not** ship a CHANGELOG.md — it uses GitHub Releases
with auto-generated notes from commits, and Eva can read the per-version
changelog at <https://github.com/.../releases>.

**STARmem decision: ship a CHANGELOG.md anyway.** Reasons:
- v2 is a clean break from v1 (per spec §11) — the changelog can narrate
  this in a way release notes can't (release notes start at the release).
- Phases 0–16 represent ~6 weeks of substantive design + implementation
  work. A "since the beginning" view is valuable for first-time installers
  who want to understand what's here.
- Future version bumps benefit from a structured CHANGELOG from day one.
  Adding it later is more work than maintaining it from the start.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 1.1.0,
semver headings, ISO dates. First entry: `[2.0.0] — 2026-04-29`.

## 6. Screenshot conventions

| Choice | MoonlitEchoes | STARmem (Task 9) |
|---|---|---|
| Location | `.github/ImagePreview/` | `docs/screenshots/` |
| Format | PNG | PNG |
| Width | mixed (mostly 1200–1600) | ~1200px |
| Count | 12+ (one per major UI variant) | **1** (Memory Viewer, episodic tab populated) |
| Capture method | hand-taken via macOS screenshot | Playwright `page.screenshot()` against fixture state |
| Linked from | hero + grid in README | hero in README only |

Why `docs/screenshots/` and not `.github/ImagePreview/`:
- We have a `docs/` tree as a first-class part of the project; new
  visuals live there for findability.
- `.github/` is a GitHub-specific path that signals "this is for the
  GitHub UI" — STARmem's screenshot is for the README, fine to live
  in `docs/`.
- Either works; STARmem just picks the convention that matches the
  rest of our repo.

## 7. Repo metadata (gh CLI commands for Eva — Task 9 Step 7)

```bash
gh repo edit <owner>/SillyTavern-STARmem \
  --description "A literary memory extension for SillyTavern — deterministic 4-tier retrieval, three memory scopes, offline-only extraction, first-class benchmarking." \
  --homepage "https://github.com/<owner>/SillyTavern-STARmem" \
  --add-topic sillytavern \
  --add-topic memory \
  --add-topic roleplay \
  --add-topic llm \
  --add-topic extension \
  --add-topic bm25 \
  --add-topic raptor

# Tag the release
git tag -a v2.0.0 -m "STARmem v2.0.0 — first public release"
git push origin v2.0.0

# Optional: GitHub release with auto-generated notes
gh release create v2.0.0 --title "STARmem v2.0.0" --notes-from-tag
```

MoonlitEchoes confirms: a public extension benefits from `topics` for
discoverability via the GitHub topic pages (`sillytavern` topic surfaces
cross-extension browsing).

## 8. Deviations from convention STARmem will keep

- **Citation-heavy README.** Most ST extensions don't cite papers; we do
  because the project's identity is academic-grounded. Keep.
- **`docs/specs/` and `docs/wiki/`.** Most extensions don't have these.
  We do because spec compliance is structurally enforced. Keep.
- **`docs/plans/` and `docs/bench/`.** Most extensions don't ship dev
  process artifacts. We do because the phased plan + benchmark substrate
  is part of the project's discipline. Keep — they're a feature, not
  noise, for technically-curious installers.
- **Apache 2.0 license** vs MoonlitEchoes' AGPL-3.0. Keep our choice;
  Apache 2.0 is the correct fit for a memory substrate that downstream
  projects might want to embed.
- **English-only.** No `i18n/`. Adopt later if community asks.

## 9. Deviations from convention STARmem will adopt

- **Screenshot in README hero.** We don't have one. Most polished
  extensions do. Adopt in Task 9 — one Memory Viewer screenshot.
- **Explicit numbered-step install block.** Currently absent from our
  README. Adopt the MoonlitEchoes shape.
- **Version without `-dev` suffix on release.** Currently `2.0.0-dev`.
  Bump to `2.0.0` in Task 9.
- **`license` field in manifest.json.** Currently absent. Add `"Apache-2.0"`.
- **`homepage` field in manifest.json.** Currently absent. Add the
  GitHub URL. Lowercase `homepage`, not `homePage`.
- **`auto_update: true` in manifest.json.** Currently absent. Adopt;
  the auto-update opt-in is the right default for a public extension.
- **`loading_order: 10`** in manifest.json. Currently absent (defaults
  to 100). Adopt 10 — STARmem's interceptor + viewer benefit from
  loading early.

## 10. What MoonlitEchoes does NOT have that STARmem has — and we keep

- A formal design spec (`docs/specs/`)
- A research wiki (`docs/wiki/`)
- A benchmark harness with measured retrieval quality
- A ROADMAP + phased retros
- An AGENTS.md for AI assistants
- A test substrate (jest + Playwright + lint + typecheck)
- An invariant guard for theme tokens (`no-hardcoded-colors`,
  `no-leaky-css`, `style-css-invariants`, soon `css-tokens-defined`)

These represent ~80% of the bytes in the repo and are STARmem's
distinctive identity. The README links to all of them under
`## Documentation`.
