/**
 * BM25+ full-text index over entries. Hand-rolled per spec §4 dep policy—
 * no vendored libraries, no embeddings. Deterministic.
 *
 * Index is in-memory only. Phase 4 rebuilds it on chat load; no persistence.
 *
 * @module retrieval/bm25
 * @see docs/specs/2026-04-20-starmem-v2-design.md §5, §5.2
 */

import { RETRIEVAL } from '../core/constants.js';

const { BM25_K1, BM25_B, BM25_DELTA } = RETRIEVAL;

/**
 * Tokenize text into lowercase alphanumeric tokens ≥2 chars. Reused by
 * Phase 4's Tier 1 Jaccard.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
    if (typeof text !== 'string' || text.length === 0) return [];
    return text
        .toLowerCase()
        .split(/[^a-z0-9]+/u)
        .filter(t => t.length >= 2);
}

/**
 * @typedef {object} Index
 * @property {Map<string, { len: number, terms: Map<string, number>, entry: import('../core/schema.js').Entry }>} docs
 * @property {Map<string, number>} df
 * @property {number} totalDocs
 * @property {number} avgLen
 */

/**
 * Build a fresh BM25+ index over a list of entries. O(total tokens).
 *
 * @param {import('../core/schema.js').Entry[]} entries
 * @returns {Index}
 */
export function buildIndex(entries) {
    /** @type {Index} */
    const idx = {
        docs: new Map(),
        df: new Map(),
        totalDocs: 0,
        avgLen: 0,
    };
    if (!Array.isArray(entries) || entries.length === 0) return idx;

    let totalLen = 0;
    for (const entry of entries) {
        const content = tokenize(entry.content);
        const subjectTokens = entry.subject ? tokenize(entry.subject) : [];
        const tagTokens = entry.tags.flatMap(t => tokenize(t));

        const docTerms = [
            ...content,
            ...repeat(subjectTokens, RETRIEVAL.SUBJECT_BOOST),
            ...repeat(tagTokens, RETRIEVAL.TAG_BOOST),
        ];

        /** @type {Map<string, number>} */
        const termCounts = new Map();
        for (const term of docTerms) {
            termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
        }

        idx.docs.set(entry.id, { len: docTerms.length, terms: termCounts, entry });
        totalLen += docTerms.length;

        for (const term of termCounts.keys()) {
            idx.df.set(term, (idx.df.get(term) ?? 0) + 1);
        }
    }

    idx.totalDocs = idx.docs.size;
    idx.avgLen = idx.totalDocs > 0 ? totalLen / idx.totalDocs : 0;
    return idx;
}

/**
 * Query the index. Returns entries sorted by BM25+ score descending.
 *
 * @param {Index} index
 * @param {string} q
 * @param {number} [k] - If provided, caps result count. Omitted = all matches.
 * @returns {{ entry: import('../core/schema.js').Entry, bm25: number }[]}
 */
export function query(index, q, k) {
    const qTokens = Array.from(new Set(tokenize(q)));
    if (qTokens.length === 0 || index.totalDocs === 0) return [];

    /** @type {{ entry: import('../core/schema.js').Entry, bm25: number }[]} */
    const results = [];
    for (const { len, terms, entry } of index.docs.values()) {
        let score = 0;
        for (const term of qTokens) {
            const tf = terms.get(term) ?? 0;
            if (tf === 0) continue;
            const df = index.df.get(term) ?? 0;
            const idf = Math.log(1 + (index.totalDocs - df + 0.5) / (df + 0.5));
            const norm = 1 - BM25_B + BM25_B * (len / index.avgLen);
            score += idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm) + BM25_DELTA;
        }
        if (score > 0) results.push({ entry, bm25: score });
    }

    results.sort((a, b) => b.bm25 - a.bm25);
    return typeof k === 'number' ? results.slice(0, k) : results;
}

/**
 * Replicate an array `n` times. n must be a non-negative integer; fractional
 * values round down. Used for subject/tag boosting in the tokenizer.
 *
 * @template T
 * @param {T[]} arr
 * @param {number} n
 * @returns {T[]}
 */
function repeat(arr, n) {
    const times = Math.max(0, Math.floor(n));
    const out = [];
    for (let i = 0; i < times; i++) out.push(...arr);
    return out;
}
