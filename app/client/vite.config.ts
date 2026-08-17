import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Vite, with the two settings that matter and nothing else.
 *
 * `/api` is proxied to the server in development so the client fetches
 * same-origin and there is no CORS layer to reason about. One fewer thing to
 * suspect when a test goes flaky is the whole basis on which this application is
 * built.
 *
 * The bundle lands in `dist-bundle` rather than `dist`, which is where
 * `tsc --build` already writes this workspace's declaration files. Sharing the
 * directory would have the two tools delete each other's output depending on
 * which ran last — an intermittent build failure, in the repository about
 * intermittent failures.
 */
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: 'dist-bundle', emptyOutDir: true },
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    proxy: { '/api': process.env.VITE_API_URL ?? 'http://localhost:3001' },
  },
})
