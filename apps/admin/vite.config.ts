import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  server: {
    // The edge strips /admin before proxying; vite serves at /.
    proxy: {},
  },
  build: { outDir: 'dist' },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    globals: true,
  },
});
