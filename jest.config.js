export default {
    testEnvironment: 'node',
    testMatch: ['**/tests/**/*.test.js'],
    transform: {},
    moduleFileExtensions: ['js', 'mjs'],
    collectCoverageFrom: [
        'src/**/*.js',
        '!src/**/index.js',
    ],
    coverageDirectory: 'coverage',
};
