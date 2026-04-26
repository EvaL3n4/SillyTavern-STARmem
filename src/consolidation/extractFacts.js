/**
 * Fact extraction. Single function `extractFacts(batch, context)` — called
 * only from consolidate(), never on the retrieval hot path.
 *
 * Pipeline:
 *   1. Render the messages batch + system prompt.
 *   2. Call callLLM(profileId, messages, maxTokens).
 *   3. Parse JSON from the response (strip fences if present).
 *   4. Validate against the entry-extraction schema:
 *       { entries: [{ content, subject, tags?, relations? }, ...] }
 *   5. Return an Entry[] with scope='episodic', provenance set from context,
 *      relations defaulted to []. Caller runs dedup + edge building.
 *
 * Errors abort the batch. consolidate() catches and releases the write lock
 * without draining the working buffer — natural retry on next trigger.
 *
 * @module consolidation/extractFacts
 * @see docs/specs/2026-04-20-starmem-v2-design.md §6.1, §6.3
 */

import { callLLM } from './llmClient.js';
import { createEntry } from '../memory/entry.js';
import { ALL_EDGE_TYPES } from '../core/schema.js';

export const EXTRACT_MAX_TOKENS = 2048;

const SYSTEM_PROMPT = `You extract durable facts from a transcript of chat messages.

Output STRICT JSON, no prose, no markdown fences, matching this schema:
{
  "entries": [
    {
      "content": "<one factual statement, 1-2 sentences, third person>",
      "subject": "<canonical subject name or null if none>",
      "tags": ["<short topical tags>", ...],
      "relations": [
        { "type": "<mentions|supports|same_topic|temporal_next>", "target": "<other entry id or stable subject string>" }
      ]
    }
  ]
}

Rules:
- Only extract facts durably relevant to the character or world. Skip pleasantries, acknowledgments, and filler.
- If nothing durable, return {"entries": []}.
- "subject" is the character, place, or entity the fact is ABOUT.
- "tags" are lowercase single words or short multi-word strings.
- Relations are optional; omit the field entirely if none.
- Do not emit "contradicts" relations; that type is reserved.`;

/**
 * @typedef {object} ExtractContext
 * @property {string} profileId        - ST connection profile id for the extractor LLM.
 * @property {string} extractorLabel   - Human-readable extractor identifier for provenance.
 * @property {number[]} sourceMessageIndices - ST chat array indices the batch was drawn from.
 * @property {Date} [now]              - Injectable clock; defaults to new Date() at call time.
 */

/**
 * @typedef {object} BatchMessage
 * @property {string} role             - 'user' | 'assistant' | 'system'
 * @property {string} content
 */

/**
 * Thrown when the model's response is unparseable as JSON (truncation,
 * malformed output, etc). Distinct from transport / 4xx / 5xx errors so
 * callers can apply different policies — e.g. `consolidate()` drops a
 * parse-failed batch and drains the buffer (treats it as "0 facts
 * extracted") rather than aborting the entire run, which would leave the
 * buffer over-threshold and re-fire on the next turn.
 *
 * Phase 12 Task 7: surfaced when the Modal vLLM warmup wrote
 * truncated responses to the on-disk cache (EXTRACT_MAX_TOKENS=2048
 * ceiling hit on dense LongMemEval-S batches), which then fail to parse
 * on cache replay during sweeps.
 */
export class ExtractionParseError extends Error {
    /**
     * @param {string} message
     * @param {{cause?: unknown, responseLength?: number}} [opts]
     */
    constructor(message, opts) {
        super(message);
        this.name = 'ExtractionParseError';
        if (opts?.cause !== undefined) this.cause = opts.cause;
        if (opts?.responseLength !== undefined) this.responseLength = opts.responseLength;
    }
}

/**
 * Try to extract a JSON object from a model response. Strips ```json ... ```
 * fences if present, trims whitespace. Does NOT attempt to repair invalid JSON.
 *
 * @param {string} raw
 * @returns {unknown}
 * @throws {ExtractionParseError} when raw cannot be parsed as JSON.
 */
export function parseLLMJson(raw) {
    if (typeof raw !== 'string') {
        throw new ExtractionParseError('parseLLMJson: expected a string');
    }
    let s = raw.trim();
    // Strip ```json ... ``` or ``` ... ``` fences
    const fenced = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    if (fenced) s = fenced[1].trim();
    try {
        return JSON.parse(s);
    } catch (err) {
        throw new ExtractionParseError(
            `parseLLMJson: invalid JSON: ${/** @type {Error} */ (err).message}`,
            { cause: err, responseLength: raw.length },
        );
    }
}

/**
 * Validate the parsed-JSON shape. Returns the valid entries plus a count
 * of entries that were skipped due to per-entry shape problems.
 *
 * Phase 12 Task 7 behavior change: per-entry validation failures are
 * skipped silently with a reason recorded, rather than aborting the
 * whole batch. Rationale — Qwen3.6 (and other well-behaved extractors)
 * occasionally emits an `entries: []`-shaped null fact (empty content,
 * usually for hypothetical / no-extractable-claims turns like logic
 * puzzles). Dropping those individual entries yields the right number
 * of facts; aborting the batch loses every other valid extraction in
 * the same response. Same policy already applies to `contradicts`
 * relations (reserved per spec §4).
 *
 * Root-level shape errors (non-object, missing entries array) still
 * throw — those signal a model/prompt mismatch we can't recover from
 * by skipping individuals.
 *
 * @param {unknown} parsed
 * @returns {{ specs: Array<{content: string, subject: string | null, tags: string[], relations: Array<{type: string, target: string}>}>, skipped: number, skipReasons: string[] }}
 * @throws when the root shape is invalid (not an object, missing entries array).
 */
export function validateExtractionShape(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('extractFacts: response must be a JSON object');
    }
    const root = /** @type {Record<string, unknown>} */ (parsed);
    if (!Array.isArray(root.entries)) {
        throw new Error('extractFacts: response.entries must be an array');
    }
    /** @type {Array<{content: string, subject: string | null, tags: string[], relations: Array<{type: string, target: string}>}>} */
    const specs = [];
    const skipReasons = [];
    for (let i = 0; i < root.entries.length; i++) {
        try {
            const raw = root.entries[i];
            if (!raw || typeof raw !== 'object') {
                throw new Error(`entries[${i}] must be an object`);
            }
            const e = /** @type {Record<string, unknown>} */ (raw);
            if (typeof e.content !== 'string' || e.content.length === 0) {
                throw new Error(`entries[${i}].content must be a non-empty string`);
            }
            const subject = e.subject === null || e.subject === undefined
                ? null
                : typeof e.subject === 'string'
                    ? e.subject
                    : null;
            if (e.subject !== null && e.subject !== undefined && typeof e.subject !== 'string') {
                throw new Error(`entries[${i}].subject must be string or null`);
            }
            const tagsRaw = e.tags ?? [];
            if (!Array.isArray(tagsRaw) || !tagsRaw.every(t => typeof t === 'string')) {
                throw new Error(`entries[${i}].tags must be string[]`);
            }
            const relsRaw = e.relations ?? [];
            if (!Array.isArray(relsRaw)) {
                throw new Error(`entries[${i}].relations must be an array`);
            }
            /** @type {Array<{type: string, target: string}>} */
            const rels = [];
            for (let j = 0; j < relsRaw.length; j++) {
                const r = /** @type {Record<string, unknown>} */ (relsRaw[j]);
                if (!r || typeof r !== 'object'
                    || typeof r.type !== 'string'
                    || typeof r.target !== 'string'
                    || r.target.length === 0) {
                    throw new Error(`entries[${i}].relations[${j}] must be { type, target }`);
                }
                if (!ALL_EDGE_TYPES.includes(/** @type {any} */ (r.type))) {
                    throw new Error(`entries[${i}].relations[${j}].type invalid: ${r.type}`);
                }
                if (r.type === 'contradicts') {
                    // Reserved per spec §4. Drop silently rather than fail.
                    continue;
                }
                // Reject relation targets that would collide with Object.prototype
                // when later looked up as state.entries[target]. Finding #14
                // (Codex 2026-04-24). Under the per-entry soft-fail wrapper this
                // throw is caught and recorded as a skip — the malformed entry
                // is dropped, the rest of the batch survives.
                if (r.target === '__proto__' || r.target === 'constructor' || r.target === 'prototype') {
                    throw new Error(
                        `entries[${i}].relations[${j}].target uses reserved key '${r.target}'`,
                    );
                }
                rels.push({ type: r.type, target: r.target });
            }
            specs.push({ content: e.content, subject, tags: [...tagsRaw], relations: rels });
        } catch (err) {
            skipReasons.push(/** @type {Error} */ (err).message);
        }
    }
    return { specs, skipped: skipReasons.length, skipReasons };
}

/**
 * Render the batch + system prompt into chat-completion messages.
 *
 * @param {BatchMessage[]} batch
 * @returns {import('./llmClient.js').ChatMessage[]}
 */
export function renderExtractionPrompt(batch) {
    const transcript = batch
        .map(m => `[${m.role}] ${m.content}`)
        .join('\n');
    return [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Transcript:\n${transcript}\n\nReturn the JSON now.` },
    ];
}

/**
 * Extract facts from a batch. Returns newly-built Episodic Entry objects
 * ready for dedup + addEdge, plus a count of per-entry validation skips.
 *
 * Throws on transport / parse / root-shape failure (still aborts batch).
 * Per-entry validation failures are absorbed silently and surfaced via
 * the `skipped` counter — see validateExtractionShape for rationale.
 *
 * @param {BatchMessage[]} batch
 * @param {ExtractContext} context
 * @returns {Promise<{ entries: import('../core/schema.js').Entry[], skipped: number }>}
 */
export async function extractFacts(batch, context) {
    if (!Array.isArray(batch) || batch.length === 0) {
        throw new Error('extractFacts: batch must be a non-empty array');
    }
    if (!context || typeof context !== 'object') {
        throw new Error('extractFacts: context required');
    }
    const { profileId, extractorLabel, sourceMessageIndices, now } = context;
    if (typeof profileId !== 'string' || profileId.length === 0) {
        throw new Error('extractFacts: context.profileId required');
    }
    if (typeof extractorLabel !== 'string' || extractorLabel.length === 0) {
        throw new Error('extractFacts: context.extractorLabel required');
    }
    if (!Array.isArray(sourceMessageIndices)) {
        throw new Error('extractFacts: context.sourceMessageIndices must be an array');
    }

    const messages = renderExtractionPrompt(batch);
    const raw = await callLLM(profileId, messages, EXTRACT_MAX_TOKENS);
    const parsed = parseLLMJson(raw);
    const { specs, skipped } = validateExtractionShape(parsed);

    const clock = now ?? new Date();
    const entries = specs.map(s => createEntry({
        scope: 'episodic',
        content: s.content,
        subject: s.subject,
        tags: s.tags,
        relations: /** @type {any} */ (s.relations),
        provenance: {
            sourceMessages: [...sourceMessageIndices],
            extractor: extractorLabel,
        },
        now: clock,
    }));
    return { entries, skipped };
}
