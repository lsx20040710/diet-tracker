import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'electron/main.ts'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'electron/preload.ts'),
        // sandbox preload 只能使用受限 CommonJS require，显式输出 CJS 才能注入安全桥。
        output: {
          format: 'cjs',
          entryFileNames: 'preload.cjs',
        },
      },
    },
  },
  renderer: {
    root: '.',
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'index.html'),
      },
    },
  },
});
