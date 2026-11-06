import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // '' = also read variables without the VITE_ prefix (those never reach the browser)
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          target: env.GATEWAY_URL || 'http://127.0.0.1:4000',
          changeOrigin: true,
          headers: { 'x-api-key': env.GATEWAY_API_KEY || '' },
        },
      },
    },
  };
});