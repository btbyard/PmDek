import { defineConfig } from 'vite';

export default defineConfig({
  // Source root is the project root; index.html lives here.
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  // Vite automatically loads .env variables prefixed with VITE_
  // so Firebase config keys are injected at build time and never
  // embedded directly in source-controlled files.
  envPrefix: 'VITE_',
});
