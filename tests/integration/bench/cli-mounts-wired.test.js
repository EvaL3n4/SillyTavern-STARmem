/**
 * Grep invariant: every bench entry-point must import AND use its declared
 * core symbols. Catches the Phase 8 class of bug where symbols ship with full
 * test coverage but no production caller.
 *
 * Rule: for every mount symbol, the entry-point file must BOTH import it AND
 * reference it at a non-import site. An import alone is not enough.
 *
 * Tripwire: delete any import line or the matching usage, run this file,
 * watch it fail.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(
    new URL('.', import.meta.url).pathname,
    '..', '..', '..',
);

/** Per-file symbols that must be imported AND used. */
const REQUIRED_WIRINGS = [
    {
        file: 'bench/cli.js',
        mounts: [
            { symbol: 'loadLocomo',    from: './loaders/locomo.js' },
            { symbol: 'runHarness',    from: './runner.js' },
        ],
    },
    {
        file: 'bench/sweeps/tau.js',
        mounts: [
            { symbol: 'sweep',      from: './_driver.js' },
            { symbol: 'loadLocomo', from: '../loaders/index.js' },
        ],
    },
    {
        file: 'bench/sweeps/graph.js',
        mounts: [
            { symbol: 'sweep',      from: './_driver.js' },
            { symbol: 'loadLocomo', from: '../loaders/index.js' },
        ],
    },
    {
        file: 'bench/sweeps/consolidation.js',
        mounts: [
            { symbol: 'sweep',      from: './_driver.js' },
            { symbol: 'loadLocomo', from: '../loaders/index.js' },
        ],
    },
    {
        file: 'bench/sweeps/bm25.js',
        mounts: [
            { symbol: 'sweep',      from: './_driver.js' },
            { symbol: 'loadLocomo', from: '../loaders/index.js' },
        ],
    },
    {
        file: 'bench/baselines.js',
        mounts: [
            { symbol: 'runHarness',     from: './runner.js' },
            { symbol: 'loadLocomo',     from: './loaders/index.js' },
            { symbol: 'computeMetrics', from: './metrics/retrieval.js' },
            { symbol: 'bm25only',       from: './baselines/index.js' },
            { symbol: 'recency',        from: './baselines/index.js' },
            { symbol: 'random',         from: './baselines/index.js' },
        ],
    },
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

/** Usage regex — symbol appears as a whole word somewhere not in an import line. */
function usageRegex(symbol) {
    return new RegExp(String.raw`\b${symbol}\b`);
}

describe('bench entry-point wiring', () => {
    for (const { file, mounts } of REQUIRED_WIRINGS) {
        describe(file, () => {
            const filePath = path.resolve(ROOT, file);
            const raw = readFileSync(filePath, 'utf8');
            const code = stripComments(raw);

            for (const { symbol, from } of mounts) {
                test(`imports ${symbol} from ${from}`, () => {
                    expect(raw).toMatch(importRegex(symbol, from));
                });

                test(`${symbol} is used in non-import code`, () => {
                    // Strip the import statement itself before checking for usage,
                    // so `import { foo } from '...'` doesn't count as usage.
                    const withoutImports = code.replace(/^import\s[^;]*;$/gm, '');
                    expect(withoutImports).toMatch(usageRegex(symbol));
                });
            }
        });
    }
});
