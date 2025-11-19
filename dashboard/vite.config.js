import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',  // Important: assets will be served at /dashboard/assets/
  build: {
    outDir: '../dashboard-dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/dashboard/api': 'http://localhost:3000'
    }
  }
});
