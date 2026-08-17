import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Vite, with the two settings that matter and nothing else.
 *
 * The API is proxied in development so the client fetches same-origin and there
 * is no CORS layer to reason about. One fewer thing to suspect when a test goes
 * flaky is the whole basis on which this application is built.
 *
 * **The proxy target is `SENTRA_API_URL`, deliberately not `VITE_API_URL`.**
 * Vite exposes every `VITE_`-prefixed variable to the browser, and
 * `app/client/api.ts` reads exactly that name to decide whether to fetch
 * absolutely. So setting it to point the *proxy* at the API also told the
 * *client* to skip the proxy and fetch cross-origin — which the API has no CORS
 * headers for, by design. The dev command did that, so the board never loaded.
 * This name is invisible to the browser, and `VITE_API_URL` goes back to its one
 * real job: pointing a built bundle at another origin.
 *
 * The bundle lands in `dist-bundle` rather than `dist`, which is where
 * `tsc --build` already writes this workspace's declaration files. Sharing the
 * directory would have the two tools delete each other's output depending on
 * which ran last — an intermittent build failure, in the repository about
 * intermittent failures.
 */

/**
 * `^/api/` — a regular expression, and the slash on the end is load-bearing.
 *
 * A plain `'/api'` key is a **prefix** match, and this directory contains a
 * module called `api.ts`. So the dev server proxied its own source file to the
 * backend, which answered 404, the module graph never finished loading, and
 * `npm run dev` rendered an empty page. It did that from the day the proxy was
 * written.
 *
 * Nothing caught it. The component tests render in jsdom with no server at all;
 * the end-to-end suite serves the built bundle from the API, where there is no
 * proxy; and the dev command's own tests check the arguments it passes to Vite.
 * Loading the page in a browser is what found it, which is the second time that
 * has been the answer for this command.
 *
 * A test now derives the rule from the files on disk rather than restating it:
 * no module this directory serves may match the proxy.
 */
export const API_PROXY = '^/api/'

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: 'dist-bundle', emptyOutDir: true },
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    proxy: { [API_PROXY]: process.env.SENTRA_API_URL ?? 'http://localhost:3001' },
  },
})
