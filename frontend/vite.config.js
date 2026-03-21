import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backendUrl = env.VITE_BACKEND_URL || 'http://localhost:3000';

  return {
    base: '/admin/',
    plugins: [react()],
    build: {
      outDir: '../public/admin',
      emptyOutDir: true
    },
    server: {
      port: 5173,
      proxy: {
        '/auth': backendUrl,
        '/health': backendUrl,
        '/admin/api': backendUrl,
        '/admin/login': backendUrl
      }
    }
  };
});
