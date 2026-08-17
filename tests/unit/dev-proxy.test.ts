import { execSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { API_PROXY } from '../../app/client/vite.config.js'

/**
 * The dev server must not proxy away its own source.
 *
 * `npm run dev` served an empty page from the day the proxy was written. Vite's
 * proxy keys are **prefix** matches unless they start with `^`, the key was
 * `/api`, and this directory contains a module called `api.ts` — so the dev
 * server forwarded its own source file to the backend, which answered 404, the
 * module graph never finished loading and React never mounted.
 *
 * Nothing caught it, and the reasons are worth listing because each one looked
 * like coverage:
 *
 * - the component tests render in jsdom, with no server and no module graph;
 * - the end-to-end suite serves the **built** bundle from the API, where there is
 *   no proxy at all;
 * - and `tests/unit/dev.test.ts` checks the arguments the command passes to Vite,
 *   which were correct.
 *
 * Loading the page in a browser is what found it. That is the second time it has
 * been the answer for this one command, so the property is checked here against
 * the files on disk rather than restated as a rule somebody has to remember.
 */

/** Vite serves this directory at the root, so `api.ts` is requested as `/api.ts`. */
const served = execSync('git ls-files "app/client/*"', { encoding: 'utf8' })
  .split('\n')
  .filter((path) => path !== '' && !path.endsWith('.test.ts') && !path.endsWith('.test.tsx'))
  .map((path) => `/${path.replace('app/client/', '')}`)

const proxied = (path: string): boolean =>
  API_PROXY.startsWith('^') ? new RegExp(API_PROXY).test(path) : path.startsWith(API_PROXY)

describe('the development proxy', () => {
  it('has files to check, so the assertion below means something', () => {
    expect(served).toContain('/api.ts')
  })

  it('never captures a module the client serves', () => {
    for (const path of served) {
      expect(proxied(path), `${path} would be proxied to the API instead of served`).toBe(false)
    }
  })

  it('still captures the requests it exists for', () => {
    for (const path of ['/api/tasks', '/api/tasks/reorder', '/api/health']) {
      expect(proxied(path), path).toBe(true)
    }
  })

  /**
   * The bug, kept as its own case. A prefix key is the natural thing to write and
   * the reason this file exists.
   */
  it('would have caught the key that was there before', () => {
    const prefix = '/api'
    expect(served.some((path) => path.startsWith(prefix))).toBe(true)
  })
})
