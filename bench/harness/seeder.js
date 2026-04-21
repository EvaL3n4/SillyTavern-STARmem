/**
 * Turn-by-turn STARmem state generator for benchmarking.
 *
 * Walks a LoCoMo-shape conversation through the real consolidation pipeline
 * (maybeConsolidate + withWriteLock + extractFacts) with a deterministic
 * rule-based fact-extraction mock installed via _setLLMClientForTests.
 * No LLM calls, no network.
 *
 * @module bench/harness/seeder
 * @see docs/plans/phase-9-benchmarking.md
 */

import { createHash } from 'node:crypto';
import { maybeConsolidate } from '../../src/consolidation/index.js';
import { loadState, persistState, setBackend, _resetBackendForTests }
    from '../../src/core/state.js';
import { withWriteLock, _resetLocksForTests } from '../../src/core/lock.js';
import { createEmptyState } from '../../src/core/schema.js';
import { createEntry } from '../../src/memory/entry.js';
import {
    _setLLMClientForTests, _resetLLMClientForTests,
} from '../../src/consolidation/llmClient.js';

/**
 * @typedef {import('../../bench/loaders/locomo.js').CorpusConversation} CorpusConversation
 */

// Duplicated from src/memory/edgeBuilder.js to avoid a breaking export change.
const STOP_WORDS = new Set([
    'A', 'I', 'The', 'It', 'Is', 'In', 'Of', 'Or', 'On', 'At', 'To', 'An',
    'As', 'Be', 'By', 'Do', 'Go', 'He', 'Me', 'My', 'No', 'So', 'Up', 'Us', 'We',
]);

const LOWER_STOP_WORDS = new Set([...STOP_WORDS].map(w => w.toLowerCase()));

/**
 * Rule-based fact extractor mock. Parses the LLM prompt's final message
 * and returns ExtractedBatch JSON matching extractFacts' schema.
 *
 * @param {string} _profileId
 * @param {{role: string, content: string}[]} messages
 * @param {number} _maxTokens
 * @returns {Promise<string>}
 */
async function ruleBasedExtractor(_profileId, messages, _maxTokens) {
    const lastMessage = messages[messages.length - 1];
    const content = lastMessage?.content ?? '';

    // Extract actual chat content from transcript lines like "[user] Alice moved..."
    const lines = content.split('\n');
    const chatContents = [];
    for (const line of lines) {
        const m = line.match(/^\[(user|assistant|system)\]\s+(.*)$/);
        if (m) {
            chatContents.push(m[2]);
        }
    }

    const textToProcess = chatContents.length > 0 ? chatContents.join(' ') : content;

    const sentences = textToProcess
        .split(/[.!?]+\s+/)
        .map(s => s.trim())
        .filter(s => s.length > 0);

    /** @type {Array<{content: string, subject: string, tags: string[], relations: []}>} */
    const entries = [];

    for (const sentence of sentences) {
        const words = sentence.split(/\s+/).filter(w => w.length > 0);
        if (words.length <= 3) continue;

        // Find first capitalized word matching /\b[A-Z][a-z]{2,}\b/ that isn't a stop word
        const matches = sentence.match(/\b[A-Z][a-z]{2,}\b/g);
        let subject = null;
        if (matches) {
            for (const match of matches) {
                if (!STOP_WORDS.has(match)) {
                    subject = match;
                    break;
                }
            }
        }

        if (!subject) continue;

        // Extract tags: up to 3 lowercase meaningful words (length >= 4, not subject, not stop words)
        const tagCandidates = [];
        for (const word of words) {
            const clean = word.toLowerCase().replace(/[^a-z]/g, '');
            if (
                clean.length >= 4
                && clean !== subject.toLowerCase()
                && !LOWER_STOP_WORDS.has(clean)
            ) {
                tagCandidates.push(clean);
            }
        }
        const uniqueTags = [...new Set(tagCandidates)].slice(0, 3);

        entries.push({
            content: sentence,
            subject,
            tags: uniqueTags,
            relations: [],
        });

        if (entries.length >= 5) break; // Cap at BATCH_SIZE
    }

    return JSON.stringify({ entries });
}

/**
 * Push a working-scope entry into state, through the write lock.
 *
 * @param {string} chatId
 * @param {string} content
 * @param {number} msgIdx
 * @param {Date} now
 */
async function pushWorking(chatId, content, msgIdx, now) {
    await withWriteLock(chatId, async () => {
        const s = await loadState(chatId);
        const e = createEntry({
            scope: 'working',
            content,
            subject: null,
            tags: [],
            relations: [],
            provenance: { sourceMessages: [msgIdx], extractor: 'bench-seeder' },
            now,
        });
        const next = {
            ...s,
            entries: { ...s.entries, [e.id]: e },
            workingBuffer: [...s.workingBuffer, e.id],
        };
        await persistState(chatId, next);
    });
}

/**
 * Seed a conversation through the STARmem consolidation pipeline.
 *
 * @param {CorpusConversation} conv
 * @param {object} [opts]
 * @param {string} [opts.chatIdPrefix='bench']
 * @param {Date} [opts.now=new Date('2026-04-20T10:00:00Z')]
 * @param {boolean} [opts.keepBackend=false]
 * @returns {Promise<{ chatId: string, stateHash: string, factCount: number, turnsProcessed: number, consolidationStats: { added: number, updated: number, drained: number, batches: number, factLengths: number[] } }>}
 */
export async function seedConversation(conv, opts = {}) {
    const {
        chatIdPrefix = 'bench',
        now = new Date('2026-04-20T10:00:00Z'),
        keepBackend = false,
    } = opts;

    const chatId = `${chatIdPrefix}-${conv.id}`;

    // Install fresh in-memory backend
    /** @type {Map<string, unknown>} */
    const store = new Map();
    setBackend({
        read: id => store.get(id),
        write: (id, v) => { store.set(id, v); },
    });
    _resetLocksForTests();

    // Install rule-based mock LLM
    _setLLMClientForTests(ruleBasedExtractor);

    // Seed initial empty state
    store.set(chatId, createEmptyState());

    const consolidationStats = { added: 0, updated: 0, drained: 0, batches: 0, factLengths: [] };

    try {
        for (let i = 0; i < conv.turns.length; i++) {
            const turn = conv.turns[i];
            if (!turn.text || turn.text.trim().length === 0) {
                continue;
            }
            await pushWorking(chatId, turn.text, i, now);

            const consResult = await maybeConsolidate(chatId, 'buffer', {
                profileId: 'bench',
                extractorLabel: 'bench-ruleBased@v1',
                messageOf: (e) => ({ role: 'user', content: e.content }),
                now,
            });
            if (consResult && typeof consResult === 'object' && !('skipped' in consResult)) {
                consolidationStats.added   += consResult.added   ?? 0;
                consolidationStats.updated += consResult.updated ?? 0;
                consolidationStats.drained += consResult.drained ?? 0;
                consolidationStats.batches += 1;
            }
        }

        const state = await loadState(chatId);

        const hash = createHash('sha256');
        hash.update(JSON.stringify(state.entries));
        const stateHash = hash.digest('hex');

        const factCount = Object.values(state.entries).filter(
            e => e.scope === 'episodic',
        ).length;

        const episodicEntries = Object.values(state.entries).filter(e => e.scope === 'episodic');
        consolidationStats.factLengths = episodicEntries.map(e => e.content.length);

        return {
            chatId,
            stateHash,
            factCount,
            turnsProcessed: conv.turns.length,
            consolidationStats,
        };
    } finally {
        if (!keepBackend) {
            _resetBackendForTests();
            _resetLocksForTests();
            _resetLLMClientForTests();
        }
    }
}
