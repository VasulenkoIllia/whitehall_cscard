import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  build: {
    outDir: '../public/admin',
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      '/auth': 'http://127.0.0.1:3000',
      '/health': 'http://127.0.0.1:3000',
      '/admin/api': 'http://127.0.0.1:3000'
    }
  }
});
