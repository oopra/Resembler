// Flat ESLint config. js/ ships as plain browser scripts loaded in order into one shared global
// scope (no bundler, no build step), so no-undef / no-unused-vars would be pure noise across those
// globals. What is kept is the high-signal set that catches real bugs.
export default [
  {
    files: ['js/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script' },
    rules: {
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-func-assign': 'error',
      'no-const-assign': 'error',
      'no-redeclare': 'error',
      'no-unreachable': 'error',
      'no-cond-assign': ['error', 'always'],
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-obj-calls': 'error',
      'no-sparse-arrays': 'warn',
      'no-constant-condition': ['warn', { checkLoops: false }]
    }
  }
];
