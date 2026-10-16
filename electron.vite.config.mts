import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    build: {
      // Bundle everything: the packaged app ships no node_modules at all.
      externalizeDeps: false,
      rollupOptions: {
        // helper.js: the privileged helper, run by the same Electron binary as plain Node.
        input: { index: 'src/main/index.ts', helper: 'src/helper/index.ts' },
      },
    },
  },
  preload: {},
  renderer: {
    plugins: [react(), tailwindcss()],
    build: { minify: true },
  },
});
