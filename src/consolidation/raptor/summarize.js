/**
 * Per-cluster LLM summarization for Enhanced RAPTOR persona rebuild. Takes a
 * set of leaves assigned to the same Leiden community and produces a single
 * summary text that will become a Persona entry (after `createEntry` elsewhere).
 *
 * One LLM call per cluster. AbortSignal checked before and during the call.
 *
 * @module consolidation/raptor/summarize
 * @see docs/specs/2026-04-20-starmem-v2-design.md §6.4
 */

import { callLLM } from '../llmClient.js';
import { PERSONA_REBUILD } from '../../core/constants.js';

const { SUMMARY_MAX_TOKENS } = PERSONA_REBUILD;

const SYSTEM_PROMPT_LEAF = `You distill a cluster of related facts about a character or entity into a single concise Persona statement.

Rules:
- Read the clustered facts carefully.
- Produce ONE paragraph (2-5 sentences, third person) that captures the shared theme.
- Preserve specific names, places, and preferences. Do NOT invent details.
- If facts contradict, note both (e.g. "X, though sometimes Y"). Do not silently resolve.
- No bullet points, no lists — prose only.

Output the paragraph directly. No preamble, no JSON, no markdown.`;

const SYSTEM_PROMPT_LAYER = `You combine several Persona statements into a single broader Persona statement covering their common theme.

Rules:
- Read the statements carefully.
- Produce ONE paragraph (2-5 sentences, third person) that captures their shared essence.
- Preserve specific names and definitive facts. Condense repetitive phrasing.
- No bullet points, no lists — prose only.

Output the paragraph directly. No preamble, no JSON, no markdown.`;

/**
 * @typedef {import('./chunking.js').Leaf} Leaf
 */

/**
 * @typedef {object} SummarizeContext
 * @property {string} profileId
 * @property {string} subject                 - Target subject (for prompt framing).
 * @property {number} depth                   - 0 = leaf-layer, >0 = higher layers.
 * @property {AbortSignal} [signal]
 */

/**
 * Summarize a cluster. Returns `{ text, sourceLeafIds }`. Source ids are
 * preserved for provenance and edge-building upstream.
 *
 * @param {Leaf[]} clusterLeaves
 * @param {SummarizeContext} context
 * @returns {Promise<{ text: string, sourceLeafIds: string[] }>}
 */
export async function summarizeCluster(clusterLeaves, context) {
    if (!Array.isArray(clusterLeaves) || clusterLeaves.length === 0) {
        throw new Error('summarizeCluster: clusterLeaves must be non-empty');
    }
    if (!context || typeof context !== 'object') {
        throw new Error('summarizeCluster: context required');
    }
    const { profileId, subject, depth, signal } = context;
    if (typeof profileId !== 'string' || profileId.length === 0) {
        throw new Error('summarizeCluster: context.profileId required');
    }
    if (typeof subject !== 'string' || subject.length === 0) {
        throw new Error('summarizeCluster: context.subject required');
    }
    if (typeof depth !== 'number' || depth < 0) {
        throw new Error('summarizeCluster: context.depth must be a non-negative number');
    }
    if (signal?.aborted) {
        const err = new Error('summarizeCluster: aborted');
        err.name = 'AbortError';
        throw err;
    }

    const systemPrompt = depth === 0 ? SYSTEM_PROMPT_LEAF : SYSTEM_PROMPT_LAYER;
    const facts = clusterLeaves.map((l, i) => `${i + 1}. ${l.text}`).join('\n');
    const userPrompt = depth === 0
        ? `Subject: ${subject}\n\nClustered facts:\n${facts}\n\nWrite the Persona paragraph now.`
        : `Subject: ${subject}\n\nClustered Persona statements:\n${facts}\n\nWrite the broader Persona paragraph now.`;

    const text = await callLLM(profileId, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ], SUMMARY_MAX_TOKENS);

    if (typeof text !== 'string' || text.trim().length === 0) {
        throw new Error('summarizeCluster: LLM returned empty content');
    }

    const sourceLeafIds = clusterLeaves.flatMap(l => l.sourceEntryIds);
    return { text: text.trim(), sourceLeafIds };
}
