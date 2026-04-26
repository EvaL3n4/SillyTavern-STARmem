import { applyBatchSizeOverride } from '../../../../bench/harness/warmup/applyBatchSizeOverride.js';

describe('applyBatchSizeOverride', () => {
    test('undefined env → no override applied, returns null', () => {
        const calls = [];
        const setOverridesFn = (o) => { calls.push(o); return () => {}; };
        const result = applyBatchSizeOverride(undefined, setOverridesFn);
        expect(result).toBeNull();
        expect(calls).toEqual([]);
    });

    test('empty string env → no override applied, returns null', () => {
        const calls = [];
        const setOverridesFn = (o) => { calls.push(o); return () => {}; };
        const result = applyBatchSizeOverride('', setOverridesFn);
        expect(result).toBeNull();
        expect(calls).toEqual([]);
    });

    test('positive integer string → setOverridesFn called once with parsed int', () => {
        const calls = [];
        const setOverridesFn = (o) => { calls.push(o); return () => {}; };
        const result = applyBatchSizeOverride('15', setOverridesFn);
        expect(result).toBe(15);
        expect(calls).toEqual([{ BATCH_SIZE: 15 }]);
    });

    test('zero is rejected — would silently disable the pipeline', () => {
        const setOverridesFn = () => () => {};
        expect(() => applyBatchSizeOverride('0', setOverridesFn)).toThrow(
            /positive integer/,
        );
    });

    test('negative is rejected', () => {
        const setOverridesFn = () => () => {};
        expect(() => applyBatchSizeOverride('-5', setOverridesFn)).toThrow(
            /positive integer/,
        );
    });

    test('fractional is rejected — BATCH_SIZE is an integer key', () => {
        const setOverridesFn = () => () => {};
        expect(() => applyBatchSizeOverride('15.5', setOverridesFn)).toThrow(
            /positive integer/,
        );
    });

    test('non-numeric is rejected with the offending value in the error', () => {
        const setOverridesFn = () => () => {};
        expect(() => applyBatchSizeOverride('fifteen', setOverridesFn)).toThrow(
            /'fifteen'/,
        );
    });

    test('parseInt-style trailing garbage is rejected (not silently truncated)', () => {
        const setOverridesFn = () => () => {};
        // parseInt('15foo', 10) === 15 — we explicitly reject this.
        expect(() => applyBatchSizeOverride('15foo', setOverridesFn)).toThrow(
            /positive integer/,
        );
    });
});
