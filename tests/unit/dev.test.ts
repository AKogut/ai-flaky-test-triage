import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  collisionMessage,
  DEFAULT_API_PORT,
  DEFAULT_WEB_PORT,
  isFree,
  kill,
  VITE_CONFIG,
  main,
  plan,
  spawnPrefixed,
} from '../../scripts/dev.js'

/**
 * The dev command, without starting a dev server.
 *
 * `start` is injected, so these check the *plan* — which processes, with which
 * ports and which environment — rather than spending seconds proving that Vite
 * boots. The parts that must touch the machine, the port probe and the process
 * group, are the two that get real ones.
 */

/** A child that never runs, but emits like one. Its `kill` is recorded, not real. */
function fakeChild(): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as ChildProcess & { kill: ReturnType<typeof vi.fn> }
  Object.assign(child, { pid: undefined, killed: false, kill: vi.fn() })
  return child
}

interface Started {
  name: string
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

const run = async (
  env: NodeJS.ProcessEnv,
  over: { free?: (port: number) => Promise<boolean> } = {},
): Promise<{ code: number; started: Started[]; output: string }> => {
  const started: Started[] = []
  const lines: string[] = []
  const children: ChildProcess[] = []

  // Resolved once both children exist. The port probe is async, so emitting an
  // exit before then would be emitting it at nothing — a test that hangs for
  // five seconds and reports a timeout instead of the assertion it was about.
  let bothStarted: () => void = () => undefined
  const running = new Promise<void>((resolve) => {
    bothStarted = resolve
  })

  const codePromise = main({
    env,
    free: over.free ?? (() => Promise.resolve(true)),
    log: (message) => lines.push(message),
    start: (name, command, args, childEnv) => {
      started.push({ name, command, args, env: childEnv })
      const child = fakeChild()
      children.push(child)
      if (children.length === 2) bothStarted()
      return child
    },
  })

  // Nothing exits on its own, so end the run the way a stopped API would.
  const code = await Promise.race([
    codePromise,
    running.then(() => {
      children[0]?.emit('exit', 0)
      return codePromise
    }),
  ])

  return { code, started, output: lines.join('\n') }
}

describe('the plan', () => {
  it('defaults both ports', () => {
    expect(plan({})).toMatchObject({ apiPort: DEFAULT_API_PORT, webPort: DEFAULT_WEB_PORT })
  })

  it('takes the ports from the environment', () => {
    expect(plan({ PORT: '4000', VITE_PORT: '4001' })).toMatchObject({
      apiPort: 4000,
      webPort: 4001,
    })
  })

  it('reports chaos only when a seed is set', () => {
    expect(plan({}).chaos).toBeNull()
    expect(plan({ SENTRA_CHAOS: '' }).chaos).toBeNull()
    expect(plan({ SENTRA_CHAOS: '284549' }).chaos).toBe('284549')
  })
})

describe('starting both halves', () => {
  it('starts the API and the client', async () => {
    const { started } = await run({})
    expect(started.map((child) => child.name)).toEqual(['api', 'web'])
  })

  it('gives each the port it was planned for', async () => {
    const { started } = await run({ PORT: '4000', VITE_PORT: '4001' })
    expect(started[0]?.env.PORT).toBe('4000')
    expect(started[1]?.args).toContain('4001')
  })

  /**
   * Vite reads its config from the working directory, and this runs from the
   * repository root. Without `--config` it serves the root with no React plugin
   * and no `/api` proxy, and the only symptom is a 404 on a page that used to
   * work — which is exactly how it was found: by running the command, not by
   * reading the arguments.
   */
  it('points the client at its own config', async () => {
    const { started } = await run({})
    expect(started[1]?.args).toContain('--config')
    expect(started[1]?.args).toContain(VITE_CONFIG)
    expect(existsSync(VITE_CONFIG)).toBe(true)
  })

  /**
   * `--strictPort`. Vite's default is to pick the next free port silently, which
   * would leave the client on a port the message just told the developer it was
   * not on.
   */
  it('refuses to let the client wander to another port', async () => {
    const { started } = await run({})
    expect(started[1]?.args).toContain('--strictPort')
  })

  /**
   * `SENTRA_API_URL`, and the name is the whole point. Vite exposes every
   * `VITE_`-prefixed variable to the browser, and `app/client/api.ts` reads that
   * name to decide whether to fetch absolutely — so setting it here pointed the
   * proxy at the API *and* told the client to skip the proxy, which the API has
   * no CORS headers for. The board never loaded. The client's own variable is
   * cleared rather than left to whatever the shell had.
   */
  it('points the proxy at the API it just started, without telling the browser', async () => {
    const { started } = await run({ PORT: '4000' })
    expect(started[1]?.env.SENTRA_API_URL).toBe('http://localhost:4000')
    expect(started[1]?.env.VITE_API_URL).toBe('')
  })

  it('does not leak a stray VITE_API_URL from the shell into the page', async () => {
    const { started } = await run({ VITE_API_URL: 'http://somewhere-else' })
    expect(started[1]?.env.VITE_API_URL).toBe('')
  })

  /** A dev database that starts empty makes every session begin with typing. */
  it('seeds the database on start', async () => {
    const { started } = await run({})
    expect(started[0]?.args).toContain('--seed')
  })

  it('passes the chaos seed through to the API', async () => {
    const { started } = await run({ SENTRA_CHAOS: '284549' })
    expect(started[0]?.env.SENTRA_CHAOS).toBe('284549')
  })

  it('says where both are, and that Ctrl-C stops them', async () => {
    const { output } = await run({})
    expect(output).toContain('http://localhost:3001')
    expect(output).toContain('http://localhost:5173')
    expect(output).toContain('Ctrl-C stops both')
  })

  /** A server quietly injecting latency makes every test in the suite suspect. */
  it('says out loud when chaos is on, and nothing when it is not', async () => {
    expect((await run({ SENTRA_CHAOS: '284549' })).output).toContain('SENTRA_CHAOS=284549')
    expect((await run({})).output).not.toContain('SENTRA_CHAOS')
  })

  /**
   * A client left running against a dead API is a debugging session that starts
   * with a wrong hypothesis.
   */
  it('stops everything when either half exits', async () => {
    const { code } = await run({})
    expect(code).toBe(0)
  })
})

describe('a port collision', () => {
  it('exits 1 without starting anything', async () => {
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m))
    })
    try {
      const { code, started } = await run({}, { free: () => Promise.resolve(false) })
      expect(code).toBe(1)
      expect(started).toEqual([])
    } finally {
      spy.mockRestore()
    }
    expect(errors.join('')).toContain('already in use')
  })

  /** A sentence, not a stack trace from four frames down. */
  it('names the port and the flag that changes it', () => {
    const message = collisionMessage(5173, 'VITE_PORT')
    expect(message).toContain('5173')
    expect(message).toContain('VITE_PORT=<port> npm run dev')
    expect(message).not.toContain('EADDRINUSE')
  })

  it('checks the API port before the client one, so the first message is the first problem', async () => {
    const probed: number[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await run(
        {},
        {
          free: (port) => {
            probed.push(port)
            return Promise.resolve(false)
          },
        },
      )
    } finally {
      spy.mockRestore()
    }
    expect(probed).toEqual([DEFAULT_API_PORT])
  })
})

describe('the port probe', () => {
  it('says a free port is free', async () => {
    expect(await isFree(0)).toBe(true)
  })

  /** Binding and releasing is cheaper and more truthful than parsing `lsof`. */
  it('says a taken port is taken', async () => {
    const held = createServer()
    const port = await new Promise<number>((resolve) => {
      held.listen(0, '127.0.0.1', () => resolve((held.address() as { port: number }).port))
    })

    try {
      expect(await isFree(port)).toBe(false)
    } finally {
      await new Promise<void>((resolve) => held.close(() => resolve()))
    }

    // And free again once it is released, so the probe is not just always false.
    expect(await isFree(port)).toBe(true)
  })
})

/**
 * The shutdown path, which is the part that leaves orphans when it is wrong.
 *
 * A child that survives Ctrl-C holds the port the next run needs, and the next
 * run's error is a collision that has nothing to do with what the developer just
 * changed — a confusing failure two steps removed from its cause.
 */
describe('stopping a child', () => {
  it('signals the process group, not just the process', () => {
    const child = fakeChild()
    Object.assign(child, { pid: 4242 })
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true)

    try {
      kill(child)
      // Negative pid: the group, which is what reaches the children a child
      // started. Vite starts one.
      expect(spy).toHaveBeenCalledWith(-4242, 'SIGTERM')
    } finally {
      spy.mockRestore()
    }
  })

  it('falls back to the process when it has no group', () => {
    const child = fakeChild()
    Object.assign(child, { pid: 4242 })
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH')
    })

    try {
      kill(child)
      expect(child.kill.mock.calls).toEqual([['SIGTERM']])
    } finally {
      spy.mockRestore()
    }
  })

  /** A shutdown path that can throw is a shutdown path that leaves orphans. */
  it('does nothing, quietly, for a child that never started', () => {
    expect(() => kill(fakeChild())).not.toThrow()
  })
})

describe('prefixed output', () => {
  it('labels every line with the process that wrote it', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => {
      lines.push(String(m))
    })

    try {
      const child = spawnPrefixed(
        'api',
        process.execPath,
        ['-e', "console.log('listening'); console.error('and a warning')"],
        process.env,
      )
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    } finally {
      spy.mockRestore()
    }

    // Two interleaved streams with no prefixes is a log nobody reads.
    expect(lines.some((line) => line === '  [api] listening')).toBe(true)
    expect(lines.some((line) => line === '  [api] and a warning')).toBe(true)
  })
})
