import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // '' = also read variables without the VITE_ prefix (those never reach the browser)
  const env = loadEnv(mode, process.cwd(), '');
  // Voice streaming (lib/voiceStream.js): OFF unless ENABLE_VOICE_STREAMING=true. Only this yes/no reaches the app.
  const voiceStreaming = String(env.ENABLE_VOICE_STREAMING || '').trim().toLowerCase() === 'true';

  return {
    plugins: [react()],
    define: { __VOICE_STREAMING__: JSON.stringify(voiceStreaming) },
    server: {
      proxy: {
        '/api': {
          target: env.GATEWAY_URL || 'http://127.0.0.1:4000',
          changeOrigin: true,
          headers: { 'x-api-key': env.GATEWAY_API_KEY || '' },
          // voice streaming only: WebSockets go through this proxy too, which adds the same access key (the
          // browser never has it)
          ws: voiceStreaming,
        },
      },
    },
  };
});
