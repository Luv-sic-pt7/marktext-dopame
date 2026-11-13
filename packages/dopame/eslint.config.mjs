import parser from './app/node_modules/@typescript-eslint/parser/dist/index.js'
import ts from './app/node_modules/@typescript-eslint/eslint-plugin/dist/index.js'
import vue from './app/node_modules/eslint-plugin-vue/dist/index.js'
import vueParser from './app/node_modules/vue-eslint-parser/dist/index.cjs'
import globals from './app/node_modules/globals/index.js'

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/.acde/**',
      '**/dist/**',
      '**/.preview-dist/**',
      '.taste-skill/**',
      'desktop/public/runtime/**',
      'third-party-licenses/**'
    ]
  },
  {
    files: ['**/*.{ts,js,mjs}'],
    languageOptions: {
      parser,
      globals: { ...globals.browser, ...globals.node, Bun: 'readonly' },
      parserOptions: { sourceType: 'module', ecmaVersion: 'latest' }
    },
    plugins: { '@typescript-eslint': ts },
    rules: {
      ...ts.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-debugger': 'error',
      'no-eval': 'error'
    }
  },
  ...vue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: { parser, ecmaVersion: 'latest', sourceType: 'module' },
      globals: globals.browser
    },
    plugins: { '@typescript-eslint': ts },
    rules: {
      'vue/multi-word-component-names': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  }
]
