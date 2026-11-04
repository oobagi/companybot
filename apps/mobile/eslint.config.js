// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/**', 'ios/**', 'android/**', '.expo/**'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: '@companybot/core', message: 'Use a browser-safe core subpath; the barrel imports the server agent runtime.' },
          { name: '@companybot/core/wakeups', message: 'Use core/wakeup-display for presentation; wakeups imports the server tool runtime.' },
        ],
      }],
    },
  },
  {
    files: ['src/components/ui/**/*.{ts,tsx}', 'src/components/navigation/**/*.{ts,tsx}', 'src/design/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['@/features/*', '@/lib/api', '@/lib/convex', '@companybot/*', 'convex', 'convex/*'],
          message: 'The component library accepts data and callbacks. Keep product features and server queries in feature adapters.',
        }],
      }],
    },
  },
]);
