/**
 * LongMemEval-S corpus adapter.
 *
 * Dataset: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
 * Paper: https://arxiv.org/abs/2410.10813
 *
 * The _s variant has 500 items. Each item has:
 * - One question + answer
 * - A haystack of ~30-40 sessions (~115K tokens total)
 * - A question_type (6 types + abstention suffix)
 * - Evidence markers (has_answer on turns, answer_session_ids)
 *
 * This adapter flattens each haystack into a single CorpusConversation:
 * all sessions concatenated into turns[] in haystack_session_ids order,
 * with sessionId=int index and turnIndex=global position.
 *
 * Per Phase 12 Decision 8, the flatten shape intentionally collapses
 * multi-session structure so that the retrieval ladder sees LongMemEval
 * the same way SillyTavern presents chat history — as one long session.
 * Task-type slicing in Task 4 preserves the signal needed to test
 * whether this collapse harms multi-session reasoning specifically.
 *
 * @module bench/corpora/longmemeval
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAdapter } from './adapter.js';

/** @typedef {import('./adapter.js').CorpusAdapter} CorpusAdapter */
/** @typedef {import('./locomo.js').CorpusConversation} CorpusConversation */
/** @typedef {import('./locomo.js').Turn} Turn */
/** @typedef {import('./locomo.js').QAItem} QAItem */

export const CANONICAL_URL =
    'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json';

const DEFAULT_CACHE = path.resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '..', '.cache', 'longmemeval_s_cleaned.json',
);

/**
 * @typedef {object} LongMemEvalTurn
 * @property {'user' | 'assistant'} role
 * @property {string} content
 * @property {boolean} [has_answer]
 */

/**
 * @typedef {object} LongMemEvalItem
 * @property {string} question_id
 * @property {string} question_type
 * @property {string} question
 * @property {string} answer
 * @property {string} question_date
 * @property {string[]} haystack_session_ids
 * @property {string[]} haystack_dates
 * @property {LongMemEvalTurn[][]} haystack_sessions
 * @property {string[]} answer_session_ids
 */

/**
 * @param {object} [opts]
 * @param {string} [opts.cachePath] Override cache location
 * @param {boolean} [opts.offline]  Never touch the network, fail if cache missing
 * @param {number}  [opts.maxItems] Truncate for smoke runs; default is full 500
 * @returns {Promise<CorpusConversation[]>}
 */
export async function loadLongMemEvalS(opts = {}) {
    const { cachePath = DEFAULT_CACHE, offline = false, maxItems } = opts;

    let raw;
    if (existsSync(cachePath)) {
        raw = JSON.parse(await readFile(cachePath, 'utf8'));
    } else if (offline) {
        throw new Error(`loadLongMemEvalS: cache missing at ${cachePath} and offline=true`);
    } else {
        // Network fetch + cache
        const response = await fetch(CANONICAL_URL);
        if (!response.ok) {
            throw new Error(`loadLongMemEvalS: fetch ${CANONICAL_URL} returned ${response.status}`);
        }
        raw = await response.json();
        await mkdir(path.dirname(cachePath), { recursive: true });
        await writeFile(cachePath, JSON.stringify(raw));
    }

    if (!Array.isArray(raw)) {
        throw new Error(`loadLongMemEvalS: expected array at root, got ${typeof raw}`);
    }

    const items = maxItems ? raw.slice(0, maxItems) : raw;
    return items.map(normalizeItem);
}

/**
 * Flatten one LongMemEval item into a CorpusConversation.
 *
 * @param {LongMemEvalItem} item
 * @returns {CorpusConversation}
 */
export function normalizeItem(item) {
    const turns = /** @type {Turn[]} */ ([]);
    const evidenceTurns = /** @type {number[]} */ ([]);

    const evidenceSessionSet = new Set(item.answer_session_ids || []);

    for (let sessionIdx = 0; sessionIdx < item.haystack_sessions.length; sessionIdx++) {
        const session = item.haystack_sessions[sessionIdx];
        const sessionId = item.haystack_session_ids[sessionIdx];
        const isEvidenceSession = evidenceSessionSet.has(sessionId);

        for (let turnInSession = 0; turnInSession < session.length; turnInSession++) {
            const rawTurn = session[turnInSession];
            const turnIndex = turns.length;

            turns.push({
                speaker: rawTurn.role,
                text: rawTurn.content,
                sessionId: sessionIdx,
                turnIndex,
            });

            // Prefer has_answer per-turn marker; fall back to whole-session
            // evidence marking when has_answer is absent.
            if (rawTurn.has_answer === true) {
                evidenceTurns.push(turnIndex);
            }
        }

        // Fallback: if this session is flagged as evidence but NO turn had
        // has_answer, mark every turn in the session as evidence (coarser
        // but safer than returning empty evidence for a question that has
        // a known evidence location).
        const sessionHasGranularEvidence = session.some(t => t.has_answer === true);
        if (isEvidenceSession && !sessionHasGranularEvidence) {
            const sessionStart = turns.length - session.length;
            for (let i = sessionStart; i < turns.length; i++) {
                evidenceTurns.push(i);
            }
        }
    }

    const abstention = item.question_id.endsWith('_abs');

    const qa = /** @type {QAItem} */ ({
        question: item.question,
        answer: item.answer,
        evidenceTurns,
        category: item.question_type,  // Preserve for backward-compat with any LoCoMo consumer
        taskType: item.question_type,
        abstention,
    });

    return {
        id: item.question_id,
        turns,
        qa: [qa],
    };
}

/**
 * LongMemEval-S adapter.
 *
 * @type {CorpusAdapter}
 */
export const longmemevalSAdapter = {
    name: 'longmemeval-s',
    loadConversations: (opts = {}) => loadLongMemEvalS(opts),
    metadata: {
        sourceUrl: CANONICAL_URL,
        cacheKey: 'longmemeval_s_cleaned.json',
        itemCount: 500,
        taskTypes: [
            'single-session-user',
            'single-session-assistant',
            'single-session-preference',
            'temporal-reasoning',
            'knowledge-update',
            'multi-session',
        ],
        multiSession: true,
    },
};

registerAdapter(longmemevalSAdapter);
