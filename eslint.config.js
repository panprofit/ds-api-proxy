'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const banComments = require('eslint-plugin-ban-comments').default || require('eslint-plugin-ban-comments');

module.exports = [
    {
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
        plugins: { 'ban-comments': banComments },
        rules: {
            'ban-comments/ban-comments': ['error', { allowEslintDirectives: true, allowJSDoc: true }],
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
            'no-console': 'off',
            'no-empty': ['error', { allowEmptyCatch: true }],
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            'no-multiple-empty-lines': ['error', { max: 1, maxBOF: 0, maxEOF: 1 }],
            'prefer-const': 'error',
            'no-var': 'error',
        },
    },
    {
        files: ['test/**/*.js', 'perf/**/*.js'],
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', varsIgnorePattern: '^_' }],
        },
    },
];
