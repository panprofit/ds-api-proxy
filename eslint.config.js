'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const banComments = require('eslint-plugin-ban-comments').default || require('eslint-plugin-ban-comments');

const exportsLast = {
    rules: {
        'exports-last': {
            meta: { type: 'problem', schema: [] },
            create(context) {
                return {
                    'Program:exit'(node) {
                        const body = node.body;
                        const last = body[body.length - 1];
                        const isExports = Boolean(last)
                            && last.type === 'ExpressionStatement'
                            && last.expression.type === 'AssignmentExpression'
                            && last.expression.left.type === 'MemberExpression'
                            && last.expression.left.object.type === 'Identifier'
                            && last.expression.left.object.name === 'module'
                            && last.expression.left.property.type === 'Identifier'
                            && last.expression.left.property.name === 'exports';
                        const hasExports = body.some(statement => statement.type === 'ExpressionStatement'
                            && statement.expression.type === 'AssignmentExpression'
                            && statement.expression.left.type === 'MemberExpression'
                            && statement.expression.left.object.type === 'Identifier'
                            && statement.expression.left.object.name === 'module'
                            && statement.expression.left.property.type === 'Identifier'
                            && statement.expression.left.property.name === 'exports');
                        if (hasExports && !isExports) context.report({ node: last || node, message: 'module.exports must be the last statement' });                    },
                };
            },
        },
    },
};

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
        plugins: { 'ban-comments': banComments, local: exportsLast },
        rules: {
            'ban-comments/ban-comments': ['error', { allowEslintDirectives: true, allowJSDoc: true }],
            'local/exports-last': 'error',
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
            'no-console': 'off',
            'no-empty': ['error', { allowEmptyCatch: true }],
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            'no-multiple-empty-lines': ['error', { max: 1, maxBOF: 0, maxEOF: 1 }],
            'no-trailing-spaces': 'error',
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
