import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// cc-monitor web UI: a tiny SPA served by the Fastify server (dist/web).
// It talks to the server over WebSocket using a URL derived from
// window.location.host.
export default defineConfig({
  plugins: [tailwindcss(), react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  base: './',
});
