/**
 * Grep invariant: `index.js` must actually mount the three UI surfaces it
 * declares responsibility for in its docblock. Catches the Phase 8 miss where
 * `renderSettingsPanel`, `mountIndicator`, and `openViewer` shipped with full
 * test coverage but no production caller — the extension loaded "successfully"
 * but rendered nothing in ST.
 *
 * Rule: for every mount symbol, `index.js` must BOTH import it AND reference
 * it at a non-import call site. An import alone is not enough — that's what
 * the original bug looked like on paper.
 *
 * Tripwire: delete any of the three import lines or the matching call, run
 * this file, watch it fail.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const INDEX_PATH = path.resolve(
    new URL('.', import.meta.url).pathname,
    '..', '..', '..', 'index.js',
);

/** Symbols index.js must import AND call. */
const REQUIRED_MOUNTS = [
    { symbol: 'bootstrap',           from: './src/integration/bootstrap.js' },
    { symbol: 'mountIndicator',      from: './src/integration/indicator.js' },
    { symbol: 'renderSettingsPanel', from: './src/integration/settingsPanel.js' },
    { symbol: 'openViewer',          from: './src/integration/viewer/mount.js' },
];

/** Strip line+block comments so assertions don't match docblock prose. */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')    // /* ... */
        .replace(/^\s*\/\/.*$/gm, '');       // // line
}

/** Imported-from regex — handles named imports with optional whitespace. */
function importRegex(symbol, from) {
    const fromEsc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
        String.raw`import\s*\{[^}]*\b${symbol}\b[^}]*\}\s*from\s*['"]${fromEsc}['"]`,
    );
}

/** Call regex — symbol followed by `(` somewhere not in an import line. */
function callRegex(symbol) {
    return new RegExp(String.raw`\b${symbol}\s*\(`);
}

describe('index.js mount wiring', () => {
    const raw = readFileSync(INDEX_PATH, 'utf8');
    const code = stripComments(raw);

    for (const { symbol, from } of REQUIRED_MOUNTS) {
        test(`imports ${symbol} from ${from}`, () => {
            expect(raw).toMatch(importRegex(symbol, from));
        });

        test(`calls ${symbol}() at least once (not only imported)`, () => {
            // Strip the import statement itself before checking for call sites,
            // so `import { foo } from '...'` doesn't count as a call.
            const withoutImports = code.replace(/^import\s[^;]*;$/gm, '');
            expect(withoutImports).toMatch(callRegex(symbol));
        });
    }

    test('registers globalThis.STARmemInterceptor', () => {
        // The manifest's generate_interceptor hook depends on this exact
        // global name — any rename breaks ST's generation pipeline silently.
        expect(code).toMatch(/globalThis\.STARmemInterceptor\s*=/);
    });

    test('subscribes to APP_READY on the event source', () => {
        // bootstrap + the three UI mounts all live inside the APP_READY
        // handler. Losing the subscription would orphan all four at once.
        expect(code).toMatch(/event_types\.APP_READY/);
    });
});
