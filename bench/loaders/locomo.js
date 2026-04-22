/**
 * @typedef {object} CorpusConversation
 * @property {string} id
 * @property {Turn[]} turns
 * @property {QAItem[]} qa
 *
 * @typedef {object} Turn
 * @property {string} speaker
 * @property {string} text
 * @property {number} sessionId
 * @property {number} turnIndex
 *
 * @typedef {object} QAItem
 * @property {string} question
 * @property {string} answer
 * @property {number[]} evidenceTurns
 * @property {string} category
 *
 * LoCoMo corpus loader.
 *
 * Fetches `data/locomo10.json` from snap-research/locomo on first call,
 * caches it under `bench/.cache/`, and normalizes into the harness's
 * canonical corpus shape:
 *   [{ id, turns: [{ speaker, text, sessionId, turnIndex }], qa: [...] }]
 *
 * Design decisions:
 * - Cache key is the raw GitHub URL; busting is manual (delete the cache).
 * - Offline mode skips the network even if cache is stale. Use for
 *   determinism in CI and sweep reruns.
 * - `maxConversations` truncates the corpus for quick-smoke runs. Full
 *   LoCoMo is 10 conversations; benchmarks usually want all.
 *
 * @module bench/loaders/locomo
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CANONICAL_URL =
    'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json';

const DEFAULT_CACHE = path.resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '..', '.cache', 'locomo10.json',
);

/**
 * @param {object} [opts]
 * @param {number} [opts.maxConversations] - truncate to this many
 * @param {boolean} [opts.offline=false] - skip network; require cache
 * @param {string} [opts.cachePath] - override cache location
 * @returns {Promise<CorpusConversation[]>}
 */
export async function loadLocomo(opts = {}) {
    const { maxConversations, offline = false, cachePath = DEFAULT_CACHE } = opts;

    let raw;
    if (existsSync(cachePath)) {
        raw = await readFile(cachePath, 'utf8');
    } else if (offline) {
        throw new Error(
            `loadLocomo: no cached corpus at ${cachePath} and offline=true`,
        );
    } else {
        const res = await fetch(CANONICAL_URL);
        if (!res.ok) {
            throw new Error(
                `loadLocomo: fetch failed — ${res.status} ${res.statusText}`,
            );
        }
        raw = await res.text();
        await mkdir(path.dirname(cachePath), { recursive: true });
        await writeFile(cachePath, raw, 'utf8');
    }

    const json = JSON.parse(raw);
    const corpus = normalizeLocomo(json);

    return maxConversations != null
        ? corpus.slice(0, maxConversations)
        : corpus;
}

/**
 * Normalize raw LoCoMo JSON to the canonical shape.
 *
 * LoCoMo's raw shape (observed from the dataset):
 *   [{ sample_id, conversation: { session_1: [...], session_2: [...], ... },
 *      qa: [{ question, answer, evidence, category }] }]
 *
 * Sessions are keyed `session_N`; each is an array of turns with
 * `speaker` and `text` (and sometimes `img_url` — ignored here).
 * `evidence` is an array of turn identifiers like "D1:S1:T3" — we map
 * these into flat turnIndex values.
 *
 * @param {any} json
 * @returns {CorpusConversation[]}
 */
function normalizeLocomo(json) {
    if (!Array.isArray(json)) {
        throw new Error('loadLocomo: expected top-level array');
    }
    return json.map(sample => {
        const turns = [];
        const sessionKeys = Object.keys(sample.conversation || {})
            .filter(k => k.startsWith('session_'))
            .sort((a, b) => parseInt(a.slice(8), 10) - parseInt(b.slice(8), 10));

        const turnByEvidenceKey = new Map();

        for (const sKey of sessionKeys) {
            const sessionId = parseInt(sKey.slice(8), 10);
            const sessionTurns = sample.conversation[sKey] || [];
            for (let i = 0; i < sessionTurns.length; i++) {
                const t = sessionTurns[i];
                const turnIndex = turns.length;
                turns.push({
                    speaker: t.speaker ?? 'unknown',
                    text: t.text ?? t.content ?? '',
                    sessionId,
                    turnIndex,
                });
                // Two evidence-key shapes observed in LoCoMo:
                //   "S<session>:T<index>" — legacy placeholder, never observed
                //     in the actual v10 cache but kept for forward compat.
                //   "D<day>:<turn>"       — actual v10 shape. <day> equals
                //     <session> (sessions are named session_<n> and turns
                //     carry dia_id="D<n>:<m>" where <n>===sessionId).
                //     <turn> is 1-indexed within the session.
                turnByEvidenceKey.set(`S${sessionId}:T${i}`, turnIndex);
                turnByEvidenceKey.set(`D${sessionId}:${i + 1}`, turnIndex);
                // Also index by dia_id verbatim if present — belt-and-suspenders
                // in case any future sample uses a different D<day> mapping.
                if (typeof t.dia_id === 'string') {
                    turnByEvidenceKey.set(t.dia_id, turnIndex);
                }
            }
        }

        const qa = (sample.qa || []).map(item => ({
            question: item.question,
            answer: String(item.answer ?? ''),
            evidenceTurns: parseEvidence(item.evidence, turnByEvidenceKey),
            category: item.category ?? 'unknown',
        }));

        return {
            id: String(sample.sample_id ?? sample.id ?? 'unknown'),
            turns,
            qa,
        };
    });
}

function parseEvidence(evidence, turnByEvidenceKey) {
    if (!Array.isArray(evidence)) return [];
    const out = [];
    for (const ref of evidence) {
        const s = String(ref);

        // Try direct lookup first (handles D<day>:<turn> and any raw dia_id).
        const direct = turnByEvidenceKey.get(s);
        if (direct != null) {
            out.push(direct);
            continue;
        }

        // Legacy "S<session>:T<index>" shape.
        const mLegacy = s.match(/S(\d+):T(\d+)/);
        if (mLegacy) {
            const idx = turnByEvidenceKey.get(`S${mLegacy[1]}:T${mLegacy[2]}`);
            if (idx != null) out.push(idx);
            continue;
        }

        // "D<day>:<turn>" shape (LoCoMo v10 actual).
        const mDay = s.match(/^D(\d+):(\d+)$/);
        if (mDay) {
            const idx = turnByEvidenceKey.get(`D${mDay[1]}:${mDay[2]}`);
            if (idx != null) out.push(idx);
            continue;
        }

        // Unmatched refs are silently dropped — same behavior as before,
        // kept for tolerance of malformed entries like the bare "D" observed
        // in ~4 items across the v10 corpus.
    }
    return out;
}
