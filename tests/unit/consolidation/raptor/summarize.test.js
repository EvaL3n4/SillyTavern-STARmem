import { describe, test, expect, afterEach } from '@jest/globals';
import { summarizeCluster } from '../../../../src/consolidation/raptor/summarize.js';
import {
    _setLLMClientForTests, _resetLLMClientForTests,
} from '../../../../src/consolidation/llmClient.js';

const CTX = {
    profileId: 'test-profile',
    subject: 'alice',
    depth: 0,
};

afterEach(() => _resetLLMClientForTests());

const leaf = (id, text, sourceEntryIds = [id]) => ({
    id, sourceEntryIds, text, subject: 'alice',
});

describe('summarizeCluster', () => {
    test('leaf-layer: calls LLM and returns trimmed text', async () => {
        /** @type {{ profile: string, messages: import('../../../../src/consolidation/llmClient.js').ChatMessage[] } | null} */
        let captured = null;
        _setLLMClientForTests(async (profile, messages, _maxTokens) => {
            captured = { profile, messages };
            return '   Alice enjoys traveling through France.   ';
        });
        const r = await summarizeCluster(
            [leaf('l1', 'alice went to marseille'), leaf('l2', 'alice likes croissants')],
            CTX,
        );
        expect(r.text).toBe('Alice enjoys traveling through France.');
        expect(r.sourceLeafIds).toEqual(['l1', 'l2']);
        expect(captured?.profile).toBe('test-profile');
        expect(captured?.messages[0].role).toBe('system');
        expect(captured?.messages[0].content).toContain('distill');
        expect(captured?.messages[1].content).toContain('Subject: alice');
        expect(captured?.messages[1].content).toContain('1. alice went to marseille');
    });

    test('higher-layer: uses the combining prompt variant', async () => {
        let systemContent = null;
        _setLLMClientForTests(async (_p, messages) => {
            systemContent = messages[0].content;
            return 'Combined summary.';
        });
        await summarizeCluster(
            [leaf('l1', 'alice is adventurous'), leaf('l2', 'alice is curious')],
            { ...CTX, depth: 1 },
        );
        expect(systemContent).toContain('combine');
        expect(systemContent).not.toContain('distill');
    });

    test('throws on empty cluster', async () => {
        await expect(summarizeCluster([], CTX)).rejects.toThrow(/non-empty/);
    });

    test('throws on empty LLM response', async () => {
        _setLLMClientForTests(async () => '   ');
        await expect(summarizeCluster([leaf('l1', 'x')], CTX)).rejects.toThrow(/empty/);
    });

    test('propagates LLM errors', async () => {
        _setLLMClientForTests(async () => { throw new Error('LLM down'); });
        await expect(summarizeCluster([leaf('l1', 'x')], CTX)).rejects.toThrow(/LLM down/);
    });

    test('respects AbortSignal pre-flight', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(summarizeCluster([leaf('l1', 'x')], { ...CTX, signal: controller.signal }))
            .rejects.toThrow(/aborted/);
    });

    test('rejects bad context', async () => {
        await expect(summarizeCluster([leaf('l1', 'x')], /** @type {any} */ ({}))).rejects.toThrow(/profileId/);
        await expect(summarizeCluster([leaf('l1', 'x')], /** @type {any} */ ({ profileId: 'p', subject: '' })))
            .rejects.toThrow(/subject/);
        await expect(summarizeCluster([leaf('l1', 'x')], /** @type {any} */ ({ profileId: 'p', subject: 's', depth: -1 })))
            .rejects.toThrow(/depth/);
    });

    test('flattens sourceEntryIds from leaves carrying multiple', async () => {
        _setLLMClientForTests(async () => 'ok');
        const r = await summarizeCluster(
            [
                leaf('l1', 'x', ['ep1', 'ep2']),
                leaf('l2', 'y', ['ep3']),
            ],
            CTX,
        );
        expect(r.sourceLeafIds).toEqual(['ep1', 'ep2', 'ep3']);
    });
});
