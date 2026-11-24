import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  base: './',
  build: { outDir: '../dist', emptyOutDir: true, target: 'chrome130', chunkSizeWarningLimit: 4000 },
  server: { port: 5174, strictPort: true },
});
