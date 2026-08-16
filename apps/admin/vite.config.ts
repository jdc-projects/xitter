import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // The edge does NOT strip /admin; the app serves under this base to match.
  base: '/admin/',
  build: { outDir: 'dist' },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    globals: true,
  },
});
