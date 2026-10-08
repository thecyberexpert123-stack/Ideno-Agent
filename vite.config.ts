import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Vite configuration for the Ideno web client.
 *
 * The client never talks to an AI provider or the filesystem directly: every
 * call goes to the Ideno API over a same-origin `/api` path. In development
 * that path is proxied to the API server; in production the API server serves
 * the built client itself. Keeping the client same-origin means there is no
 * CORS surface and no provider credential ever reaches the browser.
 */
const apiPort = Number(process.env.IDENO_PORT ?? 8787);
const uiPort = Number(process.env.IDENO_UI_PORT ?? 5173);

/**
 * Hosts the dev server will answer to. Vite rejects unknown `Host` headers to
 * protect against DNS-rebinding; a leading dot allows all subdomains. Sandboxed
 * preview environments (e2b) and Codespaces serve the dev server from a
 * generated hostname, so those suffixes are allowed explicitly rather than
 * disabling the check entirely.
 */
const allowedHosts = (process.env.IDENO_DEV_ALLOWED_HOSTS ?? '.e2b.app,.app.github.dev,.gitpod.io')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  root: fileURLToPath(new URL('./src/ui', import.meta.url)),
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: uiPort,
    strictPort: true,
    allowedHosts,
    proxy: {
      /*
       * Anchored to the `/api/` namespace on purpose. A bare `/api` key is a
       * prefix match, which also captures sibling paths such as `/api.ts` —
       * and the client's own `src/ui/api.ts` module is served at exactly that
       * URL in development. The result is that the module request is proxied
       * to the API server, which answers with the SPA fallback, and the app
       * fails to boot with no useful error. The leading `^` makes Vite treat
       * the key as a regular expression.
       */
      '^/api/': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: uiPort,
    allowedHosts,
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/ui', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
});
