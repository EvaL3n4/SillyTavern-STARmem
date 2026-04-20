import { createLogger } from '../../../src/core/logger.js';

describe('logger', () => {
    let calls;
    let fakeConsole;

    beforeEach(() => {
        calls = { log: [], warn: [], error: [], debug: [] };
        fakeConsole = {
            log: (...args) => calls.log.push(args),
            warn: (...args) => calls.warn.push(args),
            error: (...args) => calls.error.push(args),
            debug: (...args) => calls.debug.push(args),
        };
    });

    test('info prefixes messages with [STARmem]', () => {
        const log = createLogger({ console: fakeConsole, debug: false });
        log.info('hello');
        expect(calls.log).toHaveLength(1);
        expect(calls.log[0][0]).toBe('[STARmem]');
        expect(calls.log[0][1]).toBe('hello');
    });

    test('debug is silent when debug flag is false', () => {
        const log = createLogger({ console: fakeConsole, debug: false });
        log.debug('hidden');
        expect(calls.debug).toHaveLength(0);
    });

    test('debug logs when debug flag is true', () => {
        const log = createLogger({ console: fakeConsole, debug: true });
        log.debug('visible');
        expect(calls.debug).toHaveLength(1);
        expect(calls.debug[0][0]).toBe('[STARmem:debug]');
    });

    test('scoped logger appends scope to prefix', () => {
        const log = createLogger({ console: fakeConsole, debug: false });
        const scoped = log.scope('retrieval');
        scoped.info('msg');
        expect(calls.log[0][0]).toBe('[STARmem:retrieval]');
    });

    test('warn and error always fire regardless of debug flag', () => {
        const log = createLogger({ console: fakeConsole, debug: false });
        log.warn('w');
        log.error('e');
        expect(calls.warn).toHaveLength(1);
        expect(calls.error).toHaveLength(1);
    });
});
