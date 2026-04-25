import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgv } from '../../../../bench/harness/fireworks-warmup.js';

describe('fireworks-warmup enumerate', () => {
    test('parseArgv: enumerate <out-path> --corpora locomo --limit 5', () => {
        const r = parseArgv(['enumerate', '/tmp/x.jsonl', '--corpora', 'locomo', '--limit', '5']);
        expect(r.command).toBe('enumerate');
        expect(r.outPath).toBe('/tmp/x.jsonl');
        expect(r.corpora).toEqual(['locomo']);
        expect(r.limit).toBe(5);
        expect(r.model).toBe('Qwen/Qwen3.6-35B-A3B-FP8');
    });

    test('parseArgv: enumerate requires <out-path>', () => {
        expect(() => parseArgv(['enumerate'])).toThrow(/out-path/);
    });

    test('parseArgv: enumerate requires --corpora', () => {
        expect(() => parseArgv(['enumerate', '/tmp/x.jsonl'])).toThrow(/corpora/);
    });

    test('parseArgv: --model override applies to enumerate', () => {
        const r = parseArgv(['enumerate', '/tmp/x.jsonl', '--corpora', 'locomo', '--model', 'foo/bar']);
        expect(r.model).toBe('foo/bar');
    });

    test('parseArgv: --batch-size override applies to enumerate', () => {
        const r = parseArgv(['enumerate', '/tmp/x.jsonl', '--corpora', 'locomo', '--batch-size', '15']);
        expect(r.batchSize).toBe(15);
    });

    test('parseArgv: --batch-size rejects non-positive integers', () => {
        expect(() => parseArgv(['enumerate', '/tmp/x.jsonl', '--corpora', 'locomo', '--batch-size', '0'])).toThrow(/positive integer/);
        expect(() => parseArgv(['enumerate', '/tmp/x.jsonl', '--corpora', 'locomo', '--batch-size', 'abc'])).toThrow(/positive integer/);
    });
});