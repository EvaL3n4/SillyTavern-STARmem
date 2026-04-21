export default {
    testEnvironment: 'node',
    testMatch: ['**/tests/**/*.test.js'],
    transform: {},
    moduleFileExtensions: ['js', 'mjs'],
    // JSDOM tests (flagged via /** @jest-environment jsdom */ docblock) load
    // this setup to polyfill globals jsdom's older global set lacks — notably
    // structuredClone, which src/core/state.js uses.
    setupFiles: ['<rootDir>/tests/helpers/jsdomSetup.js'],
    collectCoverageFrom: [
        'src/**/*.js',
        '!src/**/index.js',
    ],
    coverageDirectory: 'coverage',
};
