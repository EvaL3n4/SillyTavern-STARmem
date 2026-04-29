     1|# SillyTavern Extension Install Conventions
     2|
     3|> Reference notes for STARmem's public-ship pass (Phase 16 Task 9). Captured
     4|> from MoonlitEchoesTheme (RivelleDays) on 2026-04-29. Not normative—
     5|> STARmem deviates where the deviation is honest (e.g. our 8K+ LOC + spec
     6|> + benchmarking surface justifies a richer `docs/` tree than a typical
     7|> UI/theme extension).
     8|
     9|## 1. Reference extension
    10|
    11|- **Name:** Moonlit Echoes Theme
    12|- **Author:** RivelleDays
    13|- **URL:** <https://github.com/RivelleDays/SillyTavern-MoonlitEchoesTheme>
    14|- **Stars:** 316 (one of the most-installed visual extensions on the ST scene)
    15|- **License:** AGPL-3.0
    16|- **Latest tag at capture:** v3.1.0 (2026-01-12)
    17|- **Note on naming:** The repo slug is `SillyTavern-MoonlitEchoesTheme`,
    18|  not `SillyTavern-MoonlitEchoes`. The plan-author memory of "MoonlitEchoes"
    19|  was close but wrong; the public artifact is the canonical reference.
    20|
    21|## 2. README anatomy
    22|
    23|| Section | MoonlitEchoes | STARmem default | Action for Task 9 |
    24||---|---|---|---|
    25|| Hero image (top) | screenshot in `.github/ImagePreview/` | absent | **adopt**—viewer screenshot at `docs/screenshots/viewer.png` |
    26|| One-line tagline | bold paragraph after H1 | first paragraph of design intro | rework to one bolded line |
    27|| Cross-language link | English / 繁體中文 toggle line under H1 | absent | **skip**—STARmem is English-only at v2.0 |
    28|| Inline preview grid | UI Interface / System Messages 2-col table | absent | **skip**—single screenshot is enough at v2.0 |
    29|| Features | `## Features` with `### Core Features` subsection | partial | expand into structured list with sub-headings |
    30|| Screenshots gallery | `## Screenshots` with 8 message-style examples | absent | **skip**—reading-room product, not a theme; one screenshot suffices |
    31|| Installation | `# Installation` (H1) → `## Prerequisites` → `## Installation Steps` (numbered) | absent | **adopt the structured form** |
    32|| Termux / mobile section | included since some users run ST on Android | absent | **skip**—STARmem doesn't have a mobile-specific install path |
    33|| Usage guide | `# Usage Guide` after install | absent | **adopt minimal version** ("Verifying the install") |
    34|| FAQ | `## FAQ` with 3 entries | absent | **skip at v2.0**, revisit if support volume justifies |
    35|| Feedback & Suggestions | one-line link to Discord | absent | **skip**—GitHub Issues suffices |
    36|| Special Thanks | acknowledgments paragraph | absent (citations exist instead) | **keep our citations**; they're our equivalent |
    37|| License | `# License` H1 with one-line note | `## License` H2 with link | match—H2 + link is fine |
    38|
    39|**Section-level pattern adopted:**
    40|1. H1 title
    41|2. Bold tagline (one line)
    42|3. Hero screenshot
    43|4. Features (structured list)
    44|5. Installation (Prerequisites → numbered Steps)
    45|6. Verifying the install (one paragraph)
    46|7. Configuration (per-setting list)
    47|8. Compatibility (requires / tested-on / not-migrated-from-v1)
    48|9. Documentation (links to specs, install, wiki, bench, plans)
    49|10. Citations (our distinguishing identity—keep)
    50|11. License
    51|
    52|## 3. Install instructions shape (the load-bearing reference)
    53|
    54|MoonlitEchoes uses a numbered-step block under `## Installation Steps`:
    55|
    56|```markdown
    57|### 1. **Install Moonlit Echoes Theme**
    58|In the **SillyTavern Extension Manager**, use "Install from URL" and paste the following Git URL:
    59|   ```
    60|   https://github.com/RivelleDays/SillyTavern-MoonlitEchoesTheme
    61|   ```
    62|```
    63|
    64|For STARmem, the matched form (no extra steps needed since we don't ship
    65|sidecar theme files, presets, or config-tweaks):
    66|
    67|```markdown
    68|### Install
    69|In the SillyTavern **Extension Manager**, use "Install from URL" and paste:
    70|
    71|```
    72|https://github.com/EvaL3n4/SillyTavern-STARmem
    73|```
    74|
    75|### Local clone (development)
    76|```bash
    77|cd <SillyTavern>/public/scripts/extensions/third-party
    78|git clone https://github.com/EvaL3n4/SillyTavern-STARmem.git
    79|```
    80|```
    81|
    82|The "git URL inside a fenced code block" pattern is the load-bearing
    83|visual signal—copy-paste-ready, same shape as every other ST extension
    84|README on the scene.
    85|
    86|## 4. manifest.json conventions (real fields, real casing)
    87|
    88|MoonlitEchoes manifest:
    89|
    90|```json
    91|{
    92|    "display_name": "Moonlit Echoes Theme",
    93|    "description": "A modern, minimalist, and elegant theme for SillyTavern. Inspired by moonlit nights and gentle echoes of serenity.",
    94|    "loading_order": 10,
    95|    "requires": [],
    96|    "optional": [],
    97|    "js": "index.js",
    98|    "author": "Rivelle <rivelle.days@gmail.com>",
    99|    "version": "3.1.0",
   100|    "license": "AGPL-3.0",
   101|    "homepage": "https://github.com/RivelleDays/SillyTavern-MoonlitEchoesTheme",
   102|    "auto_update": true,
   103|    "i18n": { "...": "..." }
   104|}
   105|```
   106|
   107|Field-by-field for STARmem:
   108|
- `display_name`—adopt. Keep it terse: `STARmem`.
   112|- `description`—adopt the one-line tagline shape. Keep it under 160
   113|  chars for GitHub-card display.
   114|- `loading_order`—**adopt 10** (early loading; matches the most-installed
   115|  reference). STARmem mounts an interceptor + viewer + indicator and
   116|  benefits from loading before chats render.
   117|- `requires` / `optional`—**keep empty** (we have no soft requirements
   118|  on other extensions).
   119|- `js`—already `index.js`. Match.
   120|- `css`—already `style.css`. Match.
- `author`—name only, no email.
   123|- `version`—bump `2.0.0-dev` → `2.0.0`. Match the no-`-dev` convention.
   124|- `license`—**add** `"Apache-2.0"` (we ship Apache 2.0; not currently in manifest).
   125|- `homepage`—**add** (lowercase `homepage`, NOT `homePage`). Both
   126|  spellings work in some contexts; lowercase is the community-canonical
   127|  form and matches MoonlitEchoes.
   128|- `auto_update`—**adopt `true`**. ST's extension manager will pull
   129|  updates automatically; correct default for any actively-maintained
   130|  public extension.
   131|- `i18n`—**skip**. STARmem is English-only at v2.0.
   132|
   133|## 5. CHANGELOG conventions
   134|
   135|MoonlitEchoes does **not** ship a CHANGELOG.md—it uses GitHub Releases
   136|with auto-generated notes from commits, and Eva can read the per-version
   137|changelog at <https://github.com/.../releases>.
   138|
   139|**STARmem decision: ship a CHANGELOG.md anyway.** Reasons:
   140|- v2 is a clean break from v1 (per spec §11)—the changelog can narrate
   141|  this in a way release notes can't (release notes start at the release).
   142|- Phases 0–16 represent ~6 weeks of substantive design + implementation
   143|  work. A "since the beginning" view is valuable for first-time installers
   144|  who want to understand what's here.
   145|- Future version bumps benefit from a structured CHANGELOG from day one.
   146|  Adding it later is more work than maintaining it from the start.
   147|
   148|Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 1.1.0,
   149|semver headings, ISO dates. First entry: `[2.0.0]—2026-04-29`.
   150|
   151|## 6. Screenshot conventions
   152|
   153|| Choice | MoonlitEchoes | STARmem (Task 9) |
   154||---|---|---|
   155|| Location | `.github/ImagePreview/` | `docs/screenshots/` |
   156|| Format | PNG | PNG |
   157|| Width | mixed (mostly 1200–1600) | ~1200px |
   158|| Count | 12+ (one per major UI variant) | **1** (Memory Viewer, episodic tab populated) |
   159|| Capture method | hand-taken via macOS screenshot | Playwright `page.screenshot()` against fixture state |
   160|| Linked from | hero + grid in README | hero in README only |
   161|
   162|Why `docs/screenshots/` and not `.github/ImagePreview/`:
   163|- We have a `docs/` tree as a first-class part of the project; new
   164|  visuals live there for findability.
   165|- `.github/` is a GitHub-specific path that signals "this is for the
   166|  GitHub UI"—STARmem's screenshot is for the README, fine to live
   167|  in `docs/`.
   168|- Either works; STARmem just picks the convention that matches the
   169|  rest of our repo.
   170|
   171|## 7. Repo metadata (gh CLI commands for Eva—Task 9 Step 7)
   172|
   173|```bash
   174|gh repo edit EvaL3n4/SillyTavern-STARmem \
   175|  --description "A memory extension for SillyTavern—deterministic 4-tier retrieval, three memory scopes, offline-only extraction, first-class benchmarking." \
   176|  --homepage "https://github.com/EvaL3n4/SillyTavern-STARmem" \
   177|  --add-topic sillytavern \
   178|  --add-topic memory \
   179|  --add-topic roleplay \
   180|  --add-topic llm \
   181|  --add-topic extension \
   182|  --add-topic bm25 \
   183|  --add-topic raptor
   184|
   185|# Tag the release
   186|git tag -a v2.0.0 -m "STARmem v2.0.0—first public release"
   187|git push origin v2.0.0
   188|
   189|# Optional: GitHub release with auto-generated notes
   190|gh release create v2.0.0 --title "STARmem v2.0.0" --notes-from-tag
   191|```
   192|
   193|MoonlitEchoes confirms: a public extension benefits from `topics` for
   194|discoverability via the GitHub topic pages (`sillytavern` topic surfaces
   195|cross-extension browsing).
   196|
   197|## 8. Deviations from convention STARmem will keep
   198|
   199|- **Citation-heavy README.** Most ST extensions don't cite papers; we do
   200|  because the project's identity is academic-grounded. Keep.
   201|- **`docs/specs/` and `docs/wiki/`.** Most extensions don't have these.
   202|  We do because spec compliance is structurally enforced. Keep.
   203|- **`docs/plans/` and `docs/bench/`.** Most extensions don't ship dev
   204|  process artifacts. We do because the phased plan + benchmark substrate
   205|  is part of the project's discipline. Keep—they're a feature, not
   206|  noise, for technically-curious installers.
   207|- **Apache 2.0 license** vs MoonlitEchoes' AGPL-3.0. Keep our choice;
   208|  Apache 2.0 is the correct fit for a memory substrate that downstream
   209|  projects might want to embed.
   210|- **English-only.** No `i18n/`. Adopt later if community asks.
   211|
   212|## 9. Deviations from convention STARmem will adopt
   213|
   214|- **Screenshot in README hero.** We don't have one. Most polished
   215|  extensions do. Adopt in Task 9—one Memory Viewer screenshot.
   216|- **Explicit numbered-step install block.** Currently absent from our
   217|  README. Adopt the MoonlitEchoes shape.
   218|- **Version without `-dev` suffix on release.** Currently `2.0.0-dev`.
   219|  Bump to `2.0.0` in Task 9.
   220|- **`license` field in manifest.json.** Currently absent. Add `"Apache-2.0"`.
   221|- **`homepage` field in manifest.json.** Currently absent. Add the
   222|  GitHub URL. Lowercase `homepage`, not `homePage`.
   223|- **`auto_update: true` in manifest.json.** Currently absent. Adopt;
   224|  the auto-update opt-in is the right default for a public extension.
   225|- **`loading_order: 10`** in manifest.json. Currently absent (defaults
   226|  to 100). Adopt 10—STARmem's interceptor + viewer benefit from
   227|  loading early.
   228|
   229|## 10. What MoonlitEchoes does NOT have that STARmem has—and we keep
   230|
   231|- A formal design spec (`docs/specs/`)
   232|- A research wiki (`docs/wiki/`)
   233|- A benchmark harness with measured retrieval quality
   234|- A ROADMAP + phased retros
   235|- An AGENTS.md for AI assistants
   236|- A test substrate (jest + Playwright + lint + typecheck)
   237|- An invariant guard for theme tokens (`no-hardcoded-colors`,
   238|  `no-leaky-css`, `style-css-invariants`, soon `css-tokens-defined`)
   239|
   240|These represent ~80% of the bytes in the repo and are STARmem's
   241|distinctive identity. The README links to all of them under
   242|`## Documentation`.
   243|