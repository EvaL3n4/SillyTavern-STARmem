/**
 * Spec §2 principle 2 enforcement: consolidate() is the ONLY function that
 * mutates long-term storage. This test greps src/ for mutation patterns and
 * fails if any appear outside the consolidation module + whitelisted graph
 * primitives.
 *
 * NOTE: this is a heuristic. It catches common patterns but a determined
 * author could still bypass via dynamic property access. The real enforcement
 * is code review + this repo's discipline — this test is a tripwire.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../../', import.meta.url).pathname;
const SRC = join(REPO_ROOT, 'src');

/**
 * Walk a directory recursively, returning all .js file paths.
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) out.push(...walk(full));
        else if (full.endsWith('.js')) out.push(full);
    }
    return out;
}

/**
 * Files that legitimately mutate the persisted state tree.
 * Everything else should be read-only.
 */
const WHITELIST_PREFIXES = [
    'src/consolidation/',
    // Graph primitives — called FROM consolidate, not direct mutators
    'src/memory/graph.js',
    'src/memory/edgeBuilder.js',
    // State I/O — serializes the tree; doesn't mutate semantically
    'src/core/state.js',
    // Retrieval cache helpers — tierCaches, not entries/graph
    'src/retrieval/tier0-exact.js',
    'src/retrieval/tier1-fuzzy.js',
    'src/retrieval/trace.js',
    // Ladder calls applyAccessEvent on returned entries — lifecycle bump,
    // same kind of long-term mutation consolidate does on dedup-update.
    // Whitelisted for Phase 4's Decision 9 ("applyAccessEvent called at
    // ladder level, once per entry in the final returned list").
    'src/retrieval/ladder.js',
    // Lifecycle helpers — the *definitions* of applyAccessEvent / applyUpdateEvent
    // live here; callers are whitelisted separately (ladder.js, consolidation/).
    'src/lifecycle/importance.js',
];

function isWhitelisted(relPath) {
    return WHITELIST_PREFIXES.some(p => relPath === p || relPath.startsWith(p));
}

/**
 * Patterns that signal long-term mutation. Each pattern matches the CALL site,
 * not the definition, and distinguishes writes from reads where possible.
 */
const MUTATION_PATTERNS = [
    // Direct entry-map WRITES: state.entries[id] = ..., state.entries[id] += ...
    // NOT reads like const e = state.entries[id].
    /state\.entries\[[^\]]*\]\s*(?:=|\+=|-=|\*=|\/=)/,
    // Direct graph-edges-list mutations
    /state\.graph\.edges\.push\b/,
    /state\.graph\.edges\.splice\b/,
    // Lifecycle writes — call sites only, not function declarations
    /(?<!function\s)(?<!\*\s)\bapplyUpdateEvent\s*\(/,
    // addEdge / removeEdge invocations
    /(?<!function\s)(?<!\*\s)\baddEdge\s*\(/,
    /(?<!function\s)(?<!\*\s)\bremoveEdge\s*\(/,
];

describe('one-path invariant — only consolidate mutates long-term state', () => {
    const files = walk(SRC);

    for (const file of files) {
        const rel = relative(REPO_ROOT, file);
        if (isWhitelisted(rel)) continue;

        test(`${rel} contains no long-term mutation patterns`, () => {
            const src = readFileSync(file, 'utf8');
            const hits = [];
            const lines = src.split('\n');
            for (let i = 0; i < lines.length; i++) {
                for (const pat of MUTATION_PATTERNS) {
                    if (pat.test(lines[i])) {
                        hits.push(`${rel}:${i + 1}: ${lines[i].trim()}  (matches ${pat})`);
                    }
                }
            }
            if (hits.length > 0) {
                throw new Error(
                    'Spec §2 principle 2 violation — long-term mutation outside consolidation:\n'
                    + hits.join('\n')
                    + '\n\nFix: route this change through consolidate() or add the file to '
                    + 'WHITELIST_PREFIXES with a comment explaining why.',
                );
            }
            expect(hits).toEqual([]);
        });
    }

    test('whitelist has at least one consolidation file', () => {
        expect(WHITELIST_PREFIXES).toContain('src/consolidation/');
    });
});
