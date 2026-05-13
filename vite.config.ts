import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
    assetsInlineLimit: 0
  },
  server: {
    host: true,
    open: false,
    strictPort: false
  }
});
