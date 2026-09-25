'use strict';
// Flat ESLint config (ESLint >= 9). The project has no build step and no
// runtime dependencies, so the config stays minimal: catch real mistakes
// (unused vars, accidental globals, loose equality) without imposing a style
// overhaul on the existing codebase.

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    {
        // Never lint generated/ignored trees.
        ignores: ['node_modules/**', '.run/**', '.auth/**'],
    },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
        rules: {
            // The proxy relies on fire-and-forget promises (remote session
            // deletes, sweeps), so no-floating-promises would be too noisy;
            // that invariant is covered by tests instead.
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
            'no-console': 'off',
            'no-empty': ['error', { allowEmptyCatch: true }],
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            'prefer-const': 'error',
            'no-var': 'error',
        },
    },
    {
        // Tests (and the perf budgets, which are test-support code) may
        // intentionally keep unused generator helpers around.
        files: ['test/**/*.js', 'perf/**/*.js'],
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', varsIgnorePattern: '^_' }],
        },
    },
];
