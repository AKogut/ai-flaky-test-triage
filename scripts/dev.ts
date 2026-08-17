import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'

/**
 * `npm run dev` — the API and the client, one command, one Ctrl-C.
 *
 * A concurrently-style dependency would do this in one line of configuration.
 * It is forty lines here instead, and the trade is deliberate: this repository
 * argues that a flaky test is worth understanding, and every dependency is one
 * more thing to rule out when one appears. Forty lines of `spawn` are readable;
 * a task runner's process-tree semantics are not.
 *
 * Three things are worth more than the brevity:
 *
 * **A port collision is a sentence, not a stack trace.** Both ports are probed
 * before anything starts, so the message names the port and the flag that
 * changes it rather than surfacing an `EADDRINUSE` from four frames down.
 *
 * **Ctrl-C leaves nothing behind.** Both children are put in their own process
 * group and the group is signalled, so a child that spawned its own child — Vite
 * does — does not survive as an orphan holding the port the next run needs.
 *
 * **Output says who said it.** Two interleaved streams with no prefixes is a log
 * nobody reads.
 */

export const DEFAULT_API_PORT = 3001
export const DEFAULT_WEB_PORT = 5173

/** Relative to the repository root, which is where npm scripts run. */
export const VITE_CONFIG = 'app/client/vite.config.ts'

export interface DevDeps {
  env?: NodeJS.ProcessEnv
  /** Injected so the tests can check the plan without starting anything. */
  start?: (name: string, command: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess
  free?: (port: number) => Promise<boolean>
  log?: (message: string) => void
}

export interface Plan {
  apiPort: number
  webPort: number
  chaos: string | null
}

export function plan(env: NodeJS.ProcessEnv): Plan {
  return {
    apiPort: Number(env.PORT ?? DEFAULT_API_PORT),
    webPort: Number(env.VITE_PORT ?? DEFAULT_WEB_PORT),
    chaos: env.SENTRA_CHAOS !== undefined && env.SENTRA_CHAOS !== '' ? env.SENTRA_CHAOS : null,
  }
}

/** Bind and release. Cheaper and more truthful than parsing `lsof`. */
export const isFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '127.0.0.1')
  })

export function collisionMessage(port: number, flag: string): string {
  return [
    '',
    `  Port ${String(port)} is already in use.`,
    '',
    `  Something else is listening — most likely a dev server from an earlier run that`,
    `  did not shut down. Stop it, or start on another port:`,
    '',
    `      ${flag}=<port> npm run dev`,
    '',
  ].join('\n')
}

export async function main(deps: DevDeps = {}): Promise<number> {
  const env = deps.env ?? process.env
  const log = deps.log ?? console.log
  const free = deps.free ?? isFree
  const { apiPort, webPort, chaos } = plan(env)

  for (const [port, flag] of [
    [apiPort, 'PORT'],
    [webPort, 'VITE_PORT'],
  ] as const) {
    if (!(await free(port))) {
      console.error(collisionMessage(port, flag))
      return 1
    }
  }

  log(
    [
      '',
      `  API     http://localhost:${String(apiPort)}`,
      `  Client  http://localhost:${String(webPort)}   (/api proxied to the API)`,
      chaos === null ? '' : `  Chaos   SENTRA_CHAOS=${chaos} — seeded latency injection is ON`,
      '',
      '  Ctrl-C stops both.',
      '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  )

  const start = deps.start ?? spawnPrefixed
  const children = [
    start('api', 'npx', ['tsx', 'app/server/index.ts', '--seed'], {
      ...env,
      PORT: String(apiPort),
    }),
    // `--config` is not optional. Vite looks for its config in the *working
    // directory*, and this runs from the repository root — without it Vite
    // serves the root with no React plugin and no `/api` proxy, and the only
    // symptom is a 404 on a page that used to work. The unit tests check the
    // arguments; only running the command catches this, which is how it was
    // found.
    // `SENTRA_API_URL`, not `VITE_API_URL`. Vite exposes every `VITE_`-prefixed
    // variable to the browser, and the client reads that name to decide whether
    // to fetch absolutely — so setting it here pointed the proxy at the API and
    // told the client to skip the proxy at the same time. The API has no CORS
    // headers, on purpose, so the board never loaded. See app/client/vite.config.ts.
    start(
      'web',
      'npx',
      ['vite', '--config', VITE_CONFIG, '--port', String(webPort), '--strictPort'],
      {
        ...env,
        SENTRA_API_URL: `http://localhost:${String(apiPort)}`,
        VITE_API_URL: '',
      },
    ),
  ]

  return await supervise(children, log)
}

/**
 * Stop everything when anything stops.
 *
 * A client left running against a dead API is a debugging session that starts
 * with a wrong hypothesis, so the first exit takes the other down with it.
 */
function supervise(children: ChildProcess[], log: (message: string) => void): Promise<number> {
  return new Promise((resolve) => {
    let settled = false

    const stopAll = (code: number): void => {
      if (settled) return
      settled = true
      for (const child of children) kill(child)
      resolve(code)
    }

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        log('\n  Stopping…\n')
        stopAll(0)
      })
    }

    for (const child of children) {
      child.once('exit', (code) => stopAll(code ?? 0))
      child.once('error', () => stopAll(1))
    }
  })
}

/**
 * Signal the group, not the process.
 *
 * `spawn` with `detached` puts a child in its own process group, and a negative
 * pid signals the whole group — which is what reaches the children a child
 * started. Vite starts one. Without this, Ctrl-C leaves an orphan holding the
 * port the next run needs, and the next run's error is a collision that has
 * nothing to do with what the developer just changed.
 */
export function kill(child: ChildProcess): void {
  if (child.pid === undefined || child.killed) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    // Already gone, or never had a group. Falling back rather than throwing,
    // because a shutdown path that can fail is a shutdown path that leaves
    // orphans.
    child.kill('SIGTERM')
  }
}

export function spawnPrefixed(
  name: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const child = spawn(command, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })

  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim() !== '') console.log(`  [${name}] ${line}`)
      }
    })
  }
  return child
}

if (process.argv[1]?.endsWith('dev.ts') === true) {
  process.exitCode = await main()
}
