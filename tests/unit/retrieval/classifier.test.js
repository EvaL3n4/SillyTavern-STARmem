import { classify } from '../../../src/retrieval/classifier.js';

describe('classify', () => {
    describe('temporal', () => {
        test.each([
            'When did Alice move to Paris?',
            'What did I say last week?',
            'Show me events from 2015',
            'Was this before or after the conference?',
            'Things that happened yesterday',
        ])('%p → temporal', q => {
            expect(classify(q)).toBe('temporal');
        });
    });

    describe('relational', () => {
        test.each([
            'Who was with Alice at the party?',
            'How is Alice related to Bob?',
            'What is the connection between Alice and Bob?',
            'Tell me about Alice and Bob',
            'Alice & Bob',
        ])('%p → relational', q => {
            expect(classify(q)).toBe('relational');
        });
    });

    describe('factual', () => {
        test.each([
            'Where does Alice live?',
            'What is Bob\'s profession?',
            'Describe the café',
            'Marseille',
            'Tell me about sculpting',
        ])('%p → factual', q => {
            expect(classify(q)).toBe('factual');
        });
    });

    describe('priority', () => {
        test('temporal cue wins over relational cue (§5 edge weights favor temporal_next on temporal)', () => {
            expect(classify('When did Alice meet Bob?')).toBe('temporal');
        });

        test('relational cue wins over bare factual', () => {
            expect(classify('Alice and Bob')).toBe('relational');
        });
    });

    describe('robustness', () => {
        test('empty query defaults to factual', () => {
            expect(classify('')).toBe('factual');
        });

        test('whitespace-only query defaults to factual', () => {
            expect(classify('   ')).toBe('factual');
        });

        test('non-string input throws', () => {
            expect(() => classify(/** @type {any} */ (null))).toThrow(/string/);
            expect(() => classify(/** @type {any} */ (123))).toThrow(/string/);
        });
    });
});
