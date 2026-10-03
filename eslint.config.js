import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['node_modules', 'out', 'release', 'coverage', '.qa*/**', '.*-gui-qa.mjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['electron/**/*.ts', '*.ts', 'tests/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Electron IPC 初次加载与受控弹窗重置必须在 effect 中同步更新本地视图状态。
      'react-hooks/set-state-in-effect': 'off',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
);
