/**
 * Regex invariants on style.css — not a visual test, just hygiene.
 *
 * Checks:
 *   1. Every selector token (`.foo` or `#foo`) is `starmem-*` or an exempt
 *      identifier with an inline `/* exempt: ... *\/` comment.
 *   2. No more than 3 uses of `!important` repo-wide.
 *   3. Every var(--SmartTheme…) has a fallback (second arg).
 *   4. Mobile breakpoint is exactly `(max-width: 639px)` — single breakpoint
 *      discipline per Decision 15c.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const CSS_PATH = path.resolve(
    new URL('.', import.meta.url).pathname,
    '..', '..', '..', 'style.css',
);

/**
 * A token that sits after a `.` or `#` sigil inside CSS code is only a real
 * selector if it starts with a letter AND is not a pure hex-color literal
 * (hex colors are #RGB / #RGBA / #RRGGBB / #RRGGBBAA). We strip comments
 * before the scan, so only CSS-code tokens reach this filter.
 */
function isHexColor(token) {
    return /^[0-9a-fA-F]+$/.test(token) && [3, 4, 6, 8].includes(token.length);
}

describe('style.css invariants', () => {
    const css = readFileSync(CSS_PATH, 'utf8');

    test('every selector is `starmem-*` or explicitly exempted', () => {
        // First pass — capture selectors guarded by `/* exempt: ... */`
        // comments. We do this BEFORE stripping comments so the linkage is
        // preserved.
        const exempted = new Set();
        const exemptRe = /\/\*\s*exempt:[^*]*\*\//g;
        let m;
        while ((m = exemptRe.exec(css)) !== null) {
            // Next ~4 lines after the comment — the exempted selector or
            // property block.
            const after = css.slice(m.index + m[0].length);
            const firstLines = after.split('\n').slice(0, 4).join('\n');
            for (const sub of firstLines.matchAll(/[.#]([a-zA-Z][\w-]*)/g)) {
                exempted.add(sub[1]);
            }
        }

        // Second pass — strip ALL CSS comments (/* ... */) before scanning
        // for selectors. Comments hold hex colors, decision refs, filenames,
        // and exempt hints that would otherwise trigger false positives.
        const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

        const selectors = new Set();
        for (const sub of stripped.matchAll(/[.#]([a-zA-Z][\w-]*)/g)) {
            selectors.add(sub[1]);
        }

        const violations = [];
        for (const s of selectors) {
            if (s.startsWith('starmem-')) continue;
            if (exempted.has(s)) continue;
            if (isHexColor(s)) continue;
            violations.push(s);
        }
        expect(violations).toEqual([]);
    });

    test('no more than 3 uses of !important', () => {
        const count = (css.match(/!important/g) || []).length;
        expect(count).toBeLessThanOrEqual(3);
    });

    test('every var(--SmartTheme…) has a fallback', () => {
        const bad = [];
        for (const m of css.matchAll(/var\(\s*--SmartTheme[A-Za-z]+\s*(,[^)]*)?\)/g)) {
            if (!m[1]) bad.push(m[0]);
        }
        expect(bad).toEqual([]);
    });

    test('mobile breakpoint is exactly 639px', () => {
        const mqs = [...css.matchAll(/@media[^{]+/g)].map(m => m[0].trim());
        expect(mqs).toContain('@media (max-width: 639px)');
        // prefers-reduced-motion is an a11y opt-out, not a layout breakpoint.
        // Multiple 639px blocks are fine — co-locating responsive rules with
        // their base rules is preferred over a single bottom-of-file dump.
        // The invariant is "only 639px is used as a breakpoint value."
        const nonA11y = mqs.filter(m => !m.includes('prefers-reduced-motion'));
        expect(nonA11y.length).toBeGreaterThan(0);
        for (const mq of nonA11y) {
            expect(mq).toBe('@media (max-width: 639px)');
        }
    });
});
