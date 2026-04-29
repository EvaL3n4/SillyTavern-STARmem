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
 *   element.setAttribute('style', '...color: rgba(...)')
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

/**
 * Color literal patterns. Matches what shows up in real CSS:
 *   #fff, #ffff, #ffffff, #ffffffff
 *   rgb(255, 0, 0), rgba(255, 0, 0, 0.5)
 *   hsl(0, 100%, 50%), hsla(0, 100%, 50%, 0.5)
 * Skips named CSS colors ('red', 'blue') because they're rare in JS source
 * and false-positive on string content like 'red flag' / 'blue square'.
 */
const HEX_RE = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;
const FUNC_COLOR_RE = /\b(?:rgba?|hsla?)\s*\(/;

/**
 * Style-assignment patterns. Catches both `.style.X =` and `.style.cssText =`.
 * Also matches inline-style strings passed to setAttribute('style', ...).
 */
const STYLE_ASSIGN_RES = [
    /\.style\.[a-zA-Z]+\s*=\s*(['"`])([^'"`]*)\1/g,
    /\.style\.cssText\s*=\s*(['"`])([^'"`]*)\1/g,
    /\.setAttribute\s*\(\s*(['"`])style\1\s*,\s*(['"`])([^'"`]*)\2\s*\)/g,
];

/**
 * Check whether the line above a given character offset has an `// exempt:`
 * comment. Allows opt-out for known-acceptable hardcoded colors (e.g. SVG
 * stroke for an icon that intentionally doesn't theme).
 */
function isExempted(src, charOffset) {
    const before = src.slice(0, charOffset);
    const lineStart = before.lastIndexOf('\n') + 1;
    const prevLineEnd = lineStart - 1;
    const prevLineStart = before.lastIndexOf('\n', prevLineEnd - 1) + 1;
    const prevLine = src.slice(prevLineStart, prevLineEnd);
    return /\/\/\s*exempt:/i.test(prevLine);
}

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

function scanFile(file) {
    const src = readFileSync(file, 'utf8');
    /** @type {{ kind: string, snippet: string, line: number }[]} */
    const violations = [];

    for (const re of STYLE_ASSIGN_RES) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(src)) !== null) {
            // For the .style.X = and cssText regexes, group 2 is the inner string.
            // For the setAttribute regex, group 3 is the inner string.
            const inner = m[3] !== undefined ? m[3] : m[2];
            if (!HEX_RE.test(inner) && !FUNC_COLOR_RE.test(inner)) continue;
            if (isExempted(src, m.index)) continue;
            const line = src.slice(0, m.index).split('\n').length;
            violations.push({
                kind: 'style-assignment',
                snippet: m[0].slice(0, 120),
                line,
            });
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
