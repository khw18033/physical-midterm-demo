import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist-standalone',
    emptyOutDir: true,
    rollupOptions: { input: { standalone: resolve(__dirname, 'standalone.html') } },
  },
});
