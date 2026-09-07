import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'brand-ref/**', 'fixtures/**']
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node, chrome: 'readonly' }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-eval': 'error',
      'no-implicit-globals': 'error',
      'no-restricted-properties': [
        'error',
        { object: 'window', property: 'eval', message: 'eval is forbidden in AUVYQ.' },
        { object: 'document', property: 'write', message: 'document.write is forbidden in AUVYQ.' },
        { object: 'window', property: 'localStorage', message: 'localStorage is forbidden in AUVYQ; use chrome.storage.' },
        { object: 'element', property: 'innerHTML', message: 'innerHTML is forbidden in AUVYQ; build DOM with createElement/textContent.' },
        { object: 'element', property: 'outerHTML', message: 'outerHTML is forbidden in AUVYQ.' }
      ],
      'no-restricted-syntax': [
        'error',
        { selector: 'CallExpression[callee.name=Function]', message: 'Function() dynamic code execution is forbidden in AUVYQ.' },
        { selector: 'NewExpression[callee.name=Function]', message: 'new Function is forbidden in AUVYQ.' },
        { selector: 'MemberExpression[object.name=document][property.name=/^(write|writeln)$/]', message: 'document.write is forbidden in AUVYQ.' }
      ]
    }
  }
];
