import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';
import jsdoc from 'eslint-plugin-jsdoc';

export default tseslint.config(
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
  prettier
);
