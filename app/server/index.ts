import { createApp } from './app.js'
import { open } from './db.js'
import { seed } from './seed.js'

/**
 * @sentra/taskflow-server
 *
 * TaskFlow API — the system under test. Express and SQLite, deliberately small.
 *
 * The entry point does the three things a module cannot: reads the environment,
 * opens a file, and binds a port. Everything it calls takes what it needs as an
 * argument, which is what lets the whole API be tested against `:memory:`
 * without a port or a temporary directory.
 */

export * from './db.js'
export * from './app.js'
export * from './seed.js'

/** Defaults to a file, never to `:memory:` — a dev server that forgets everything on restart. */
export const DEFAULT_DB = '.taskflow/tasks.db'
export const DEFAULT_PORT = 3001

export interface ServeOptions {
  port?: number
  database?: string
  /** Replace the contents with the deterministic seed before serving. */
  reseed?: boolean
  log?: (message: string) => void
}

export function serve(options: ServeOptions = {}): { close: () => Promise<void>; port: number } {
  const log = options.log ?? console.log
  const path = options.database ?? process.env.SENTRA_DB ?? DEFAULT_DB
  const port = options.port ?? Number(process.env.PORT ?? DEFAULT_PORT)

  const db = open(path)
  if (options.reseed === true) seed(db)

  const server = createApp({ db }).listen(port)
  const bound = address(server, port)
  log(`  TaskFlow API on http://localhost:${String(bound)} (${path})`)

  return {
    port: bound,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((failure) => {
          db.close()
          if (failure) reject(failure)
          else resolve()
        })
      }),
  }
}

/** `listen(0)` picks a free port, which is how tests avoid the collision they exist to simulate. */
function address(server: { address: () => unknown }, fallback: number): number {
  const bound = server.address()
  return typeof bound === 'object' && bound !== null && 'port' in bound
    ? (bound as { port: number }).port
    : fallback
}

if (process.argv[1]?.endsWith('index.ts') === true) {
  serve({ reseed: process.argv.includes('--seed') })
}
