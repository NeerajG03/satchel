import { defineConfig } from 'vite';

// The hosted web build serves from the site root. The desktop shell bundles the
// same output inside the app, where assets must resolve relative to index.html.
export default defineConfig(({ mode }) => ({
  base: mode === 'desktop' ? './' : '/',
  build: { target: 'es2022' },
  server: { strictPort: true, port: 5173 },
  clearScreen: false,
}));
