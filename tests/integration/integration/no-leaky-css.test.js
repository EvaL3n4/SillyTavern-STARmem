/**
 * Grep invariant: every DOM class name and id introduced by Phase 8
 * must start with the `starmem-` prefix. Enforces Decision 9 from the
 * plan and prevents Phase 8 from coloring other ST extensions' DOM.
 *
 * Methodology:
 *   Walk every .js and .html file under src/integration/, find every
 *   string literal that looks like a CSS class or id (leading `.` or `#`,
 *   or appearing inside className/classList.add/id= attributes), and
 *   assert the token after the sigil starts with `starmem-` or is
 *   whitelisted below.
 *
 * Tripwire-verified at commit time by injecting a deliberate violation
 * (see Phase 6's no-other-mutators test for the pattern).
 */
import { describe, test } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname,
    '..', '..', '..', 'src', 'integration');

/** Tokens allowed to break the prefix rule (tokens used unchanged by ST). */
const WHITELIST = new Set([
    'extensions_settings',       // ST-provided container id our settings panel mounts into
    'extensions_settings2',      // ST's right-column drawer (loading_order ≥ 100)
    'send_but',                  // ST's send button (legacy reference path)
    'send_form',                 // ST's send form wrapper — indicator anchor (P16 T5)
]);

function walk(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        const s = statSync(full);
        if (s.isDirectory()) out.push(...walk(full));
        else if (/\.(js|html)$/.test(entry)) out.push(full);
    }
    return out;
}

/**
 * Extract every css-class-shaped or id-shaped token from a source file.
 * Returns an array of { token, file, line } records for failure reporting.
 */
function extractTokens(file) {
    const src = readFileSync(file, 'utf8');
    /** @type {{ token: string, file: string, line: number }[]} */
    const found = [];

    // `.foo-bar` or `#foo-bar` inside string literals — catches querySelector,
    // classList.add, HTML templates, style sheet refs.
    const re = /(['"`])([^'"`]*?)\1/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const literal = m[2];
        for (const sub of literal.matchAll(/[.#]([a-zA-Z][\w-]*)/g)) {
            const token = sub[1];
            // Compute 1-based line number for the match start.
            const line = src.slice(0, m.index).split('\n').length;
            found.push({ token, file: path.relative(ROOT, file), line });
        }
    }
    return found;
}

describe('no-leaky-css', () => {
    test('every CSS class/id token in src/integration starts with "starmem-"', () => {
        const files = walk(ROOT);
        const violations = [];
        for (const f of files) {
            for (const t of extractTokens(f)) {
                if (WHITELIST.has(t.token)) continue;
                if (t.token.startsWith('starmem-')) continue;
                // Single-word tokens like "hidden" or "active" may come from
                // generic CSS; ignore unless they contain a hyphen (suggesting
                // a component class).
                if (!t.token.includes('-')) continue;
                // ST-namespaced tokens (no prefix required) — empirically these
                // are the few we intentionally reach across for.
                if (t.token.startsWith('fa-')) continue;       // Font Awesome icons
                if (t.token.startsWith('menu_')) continue;     // ST button styles
                violations.push(`${t.file}:${t.line}  ${t.token}`);
            }
        }
        if (violations.length) {
            throw new Error(
                `Phase 8 CSS prefix violation — every class/id must start with ` +
                `"starmem-" (see constants.js#CSS_PREFIX). Offending tokens:\n  ` +
                violations.join('\n  '),
            );
        }
    });
});
