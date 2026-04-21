/**
 * Self-test for the mock factory — ensures it actually behaves like
 * a minimal getContext() and the event spy has real pub/sub semantics.
 */
import { describe, test, expect, jest } from '@jest/globals';
import {
    makeStContext, makeEventSource, installGlobalSillyTavern, ET,
} from './stContextMock.js';

describe('stContextMock', () => {
    test('makeStContext returns fresh empty settings + chatMetadata', () => {
        const c = makeStContext();
        expect(c.extensionSettings).toEqual({});
        expect(c.chatMetadata).toEqual({});
        expect(c.chatId).toBe('test-chat');
        expect(typeof c.saveSettingsDebounced).toBe('function');
        expect(typeof c.saveMetadataDebounced).toBe('function');
        expect(c.event_types).toBe(ET);
    });

    test('overrides take precedence without mutating defaults', () => {
        const a = makeStContext({ chatId: 'A' });
        const b = makeStContext();
        a.extensionSettings.foo = 1;
        expect(a.chatId).toBe('A');
        expect(b.chatId).toBe('test-chat');
        expect(b.extensionSettings.foo).toBeUndefined();
    });

    test('chatId: null override is respected (logged-out-of-chat state)', () => {
        const c = makeStContext({ chatId: null });
        expect(c.chatId).toBeNull();
    });

    test('eventSource.on + emit fires handlers in order', async () => {
        const es = makeEventSource();
        const order = [];
        es.on('x', () => order.push(1));
        es.on('x', () => order.push(2));
        await es.emit('x');
        expect(order).toEqual([1, 2]);
    });

    test('eventSource.off unsubscribes the exact handler', async () => {
        const es = makeEventSource();
        const h1 = jest.fn();
        const h2 = jest.fn();
        es.on('x', h1);
        es.on('x', h2);
        es.off('x', h1);
        await es.emit('x');
        expect(h1).not.toHaveBeenCalled();
        expect(h2).toHaveBeenCalledTimes(1);
    });

    test('eventSource.emit on unknown event is a no-op', async () => {
        const es = makeEventSource();
        await expect(es.emit('never-subscribed')).resolves.toBeUndefined();
    });

    test('eventSource handler that calls off() mid-emit does not skip siblings', async () => {
        const es = makeEventSource();
        const seen = [];
        const h1 = () => { seen.push(1); es.off('x', h1); };
        const h2 = () => { seen.push(2); };
        es.on('x', h1);
        es.on('x', h2);
        await es.emit('x');
        expect(seen).toEqual([1, 2]); // both run despite h1 self-unsubbing
    });

    test('eventSource await-propagates handler rejections', async () => {
        const es = makeEventSource();
        es.on('boom', async () => { throw new Error('nope'); });
        await expect(es.emit('boom')).rejects.toThrow(/nope/);
    });

    test('installGlobalSillyTavern sets + teardown restores', () => {
        const g = /** @type {any} */ (globalThis);
        const prior = g.SillyTavern;
        const ctx = makeStContext();
        const teardown = installGlobalSillyTavern(ctx);
        expect(g.SillyTavern.getContext()).toBe(ctx);
        teardown();
        expect(g.SillyTavern).toBe(prior);
    });

    test('installGlobalSillyTavern preserves a pre-existing global', () => {
        const g = /** @type {any} */ (globalThis);
        g.SillyTavern = { sentinel: true };
        const teardown = installGlobalSillyTavern(makeStContext());
        expect(g.SillyTavern.sentinel).toBeUndefined();
        teardown();
        expect(g.SillyTavern.sentinel).toBe(true);
        delete g.SillyTavern;
    });

    test('ET has the exact set of names Phase 8 subscribes to', () => {
        expect(Object.keys(ET).sort()).toEqual([
            'APP_READY',
            'CHAT_CHANGED',
            'MESSAGE_DELETED',
            'MESSAGE_RECEIVED',
            'MESSAGE_SENT',
        ]);
        // Values must be lowercase snake_case matching ST's script.js.
        for (const [k, v] of Object.entries(ET)) {
            expect(v).toBe(k.toLowerCase());
        }
    });
});
