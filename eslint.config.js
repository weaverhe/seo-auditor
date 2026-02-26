'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');
const tseslint = require('typescript-eslint');
const jsdoc = require('eslint-plugin-jsdoc');

module.exports = tseslint.config(
  { ignores: ['node_modules/', 'audits/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  // JSDoc for TypeScript: descriptions + @param/@returns required on all functions,
  // but {type} annotations in JSDoc tags are optional (TypeScript handles types).
  jsdoc.configs['flat/recommended-typescript'],
  {
    rules: {
      'jsdoc/require-jsdoc': [
        'warn',
        {
          require: { FunctionDeclaration: true, MethodDefinition: true, ClassDeclaration: true },
          checkConstructors: false,
        },
      ],
    },
  },
  // Test files: no JSDoc required on callbacks and helpers.
  {
    files: ['tests/**/*.test.ts'],
    rules: {
      'jsdoc/require-jsdoc': 'off',
    },
  },
  // CJS config files at the root must use require() — exempt from the no-require-imports rule.
  {
    files: ['*.js', '*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  prettier
);
