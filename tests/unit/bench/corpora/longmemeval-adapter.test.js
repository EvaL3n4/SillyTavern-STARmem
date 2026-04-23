import { getAdapter, listAdapters } from '../../../../bench/corpora/index.js';
import { normalizeItem, loadLongMemEvalS } from '../../../../bench/corpora/longmemeval.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_PATH = path.resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '..', '..', '..', 'fixtures', 'bench', 'longmemeval-s-fixture.json',
);

describe('LongMemEval-S adapter (Phase 12 Task 3)', () => {
    test('longmemevalSAdapter is registered after importing the barrel', () => {
        expect(listAdapters()).toContain('longmemeval-s');
    });

    test('adapter metadata lists the 6 expected task types and multiSession=true', () => {
        const adapter = getAdapter('longmemeval-s');
        expect(adapter.metadata.taskTypes).toEqual([
            'single-session-user',
            'single-session-assistant',
            'single-session-preference',
            'temporal-reasoning',
            'knowledge-update',
            'multi-session',
        ]);
        expect(adapter.metadata.multiSession).toBe(true);
        expect(adapter.metadata.itemCount).toBe(500);
    });

    describe('normalizeItem shape', () => {
        const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
        // Fixture item 0: single-session-user, no has_answer markers, answer_session_ids don't match haystack
        // Fixture item 1: multi-session with has_answer markers across 2+ sessions
        // Fixture item 2: abstention item (_abs suffix)

        test('flattens all haystack sessions into a single turns[] array', () => {
            const conv = normalizeItem(fixture[0]);
            const totalTurns = fixture[0].haystack_sessions.reduce((n, s) => n + s.length, 0);
            expect(conv.turns.length).toBe(totalTurns);
        });

        test('assigns monotonically increasing turnIndex across sessions', () => {
            const conv = normalizeItem(fixture[0]);
            for (let i = 0; i < conv.turns.length; i++) {
                expect(conv.turns[i].turnIndex).toBe(i);
            }
        });

        test('preserves per-session sessionId through flattening', () => {
            const conv = normalizeItem(fixture[0]);
            let lastSessionId = -1;
            for (const t of conv.turns) {
                expect(t.sessionId).toBeGreaterThanOrEqual(lastSessionId);
                lastSessionId = t.sessionId;
            }
        });

        test('propagates taskType from question_type', () => {
            const conv = normalizeItem(fixture[0]);
            expect(conv.qa[0].taskType).toBe('single-session-user');
        });

        test('populates evidenceTurns from has_answer markers', () => {
            const conv = normalizeItem(fixture[1]);
            // fixture[1] has has_answer=true on specific turns; verify those
            // turns are included in evidenceTurns.
            expect(conv.qa[0].evidenceTurns.length).toBeGreaterThan(0);
            // Map which original turns had has_answer=true
            const hasAnswerTurnIndices = [];
            let globalIdx = 0;
            for (let s = 0; s < fixture[1].haystack_sessions.length; s++) {
                for (let t = 0; t < fixture[1].haystack_sessions[s].length; t++) {
                    if (fixture[1].haystack_sessions[s][t].has_answer === true) {
                        hasAnswerTurnIndices.push(globalIdx);
                    }
                    globalIdx++;
                }
            }
            expect(hasAnswerTurnIndices.length).toBeGreaterThan(0);
            for (const idx of hasAnswerTurnIndices) {
                expect(conv.qa[0].evidenceTurns).toContain(idx);
            }
        });

        test('falls back to session-level evidence when has_answer is absent', () => {
            // The fixture's item[1] has per-turn has_answer markers in all evidence
            // sessions, so it does not trigger the fallback. We construct a minimal
            // synthetic item to exercise the fallback path explicitly.
            const synthetic = {
                question_id: 'test-fallback',
                question_type: 'multi-session',
                question: 'q',
                answer: 'a',
                question_date: '2024-01-01',
                haystack_session_ids: ['s0', 's1'],
                haystack_dates: ['2024-01-01', '2024-01-02'],
                haystack_sessions: [
                    [
                        { role: 'user', content: 'hello' },
                        { role: 'assistant', content: 'world' },
                    ],
                    [
                        { role: 'user', content: 'foo' },
                        { role: 'assistant', content: 'bar' },
                    ],
                ],
                answer_session_ids: ['s1'],
            };
            const conv = normalizeItem(synthetic);
            // Session 1 has no has_answer markers but is in answer_session_ids,
            // so fallback should mark both turns in session 1 as evidence.
            expect(conv.qa[0].evidenceTurns).toEqual([2, 3]);
            expect(conv.turns[2].sessionId).toBe(1);
            expect(conv.turns[3].sessionId).toBe(1);
        });

        test('detects abstention from _abs suffix', () => {
            const conv = normalizeItem(fixture[2]);
            expect(conv.qa[0].abstention).toBe(true);
            expect(conv.id.endsWith('_abs')).toBe(true);
        });

        test('non-abstention items have abstention=false', () => {
            const conv = normalizeItem(fixture[0]);
            expect(conv.qa[0].abstention).toBe(false);
        });
    });

    test('loadLongMemEvalS({offline:true}) reads from cache without network', async () => {
        // Requires bench/.cache/longmemeval_s_cleaned.json to exist.
        // Eva warms this before running the full suite; tests that don't
        // have the cache should skip cleanly.
        const cachePath = path.resolve(
            fileURLToPath(new URL('.', import.meta.url)),
            '..', '..', '..', '..', 'bench', '.cache', 'longmemeval_s_cleaned.json',
        );
        const fs = await import('node:fs');
        if (!fs.existsSync(cachePath)) {
            console.warn('Skipping offline cache test: bench/.cache/longmemeval_s_cleaned.json missing');
            return;
        }
        const convs = await loadLongMemEvalS({ offline: true, maxItems: 3 });
        expect(convs.length).toBe(3);
        expect(convs[0].qa.length).toBe(1);
        expect(convs[0].qa[0].taskType).toBeDefined();
    });
});
