import { resolveMode } from '@sentra/agents'

/**
 * `npm run cassettes:record` — refresh every committed recording, in one step.
 *
 * One step because two is how they diverge. The eval harness and the demo ask
 * for different things, and a maintainer who re-records only the first leaves a
 * demo that fails for the next person to clone the repository — the exact
 * failure the staleness check exists to catch, reintroduced by the command meant
 * to fix it.
 *
 * **This one costs money.** It is the only script in the repository that does,
 * so it says so before it starts and refuses to guess: without credentials, or
 * with the environment asking for replay, it stops rather than producing a
 * confident-looking run that recorded nothing.
 */

export interface RecordDeps {
  env?: NodeJS.ProcessEnv
  runEval?: (argv: string[]) => Promise<number>
  runDemo?: () => Promise<number>
  log?: (message: string) => void
}

export async function main(deps: RecordDeps = {}): Promise<number> {
  const env = deps.env ?? process.env
  const log = deps.log ?? console.log

  // Judged before anything is set, so this reads the operator's intent rather
  // than the intent this script is about to impose.
  const mode = resolveMode(env)
  if (mode === 'replay') {
    console.error(
      [
        '',
        '  Recording needs credentials, and this environment has none —',
        '  or SENTRA_REPLAY=1 is asking for the opposite of recording.',
        '',
        '  Set ANTHROPIC_API_KEY (or SENTRA_LIVE=1 for an `ant auth login` profile)',
        '  and run again. Nothing was recorded and nothing was spent.',
        '',
      ].join('\n'),
    )
    return 1
  }

  log(
    [
      '',
      '  Recording cassettes. This calls the model and costs money.',
      '',
      '  Two passes, because the eval harness and the demo ask for different things',
      '  and re-recording only one leaves the other replaying answers to questions',
      '  nobody asks any more.',
      '',
    ].join('\n'),
  )

  env.SENTRA_RECORD = '1'

  const evaluate =
    deps.runEval ?? (async (argv) => (await import('@sentra/eval/run-eval')).main(argv))
  const demo = deps.runDemo ?? (async () => (await import('./demo.js')).main())

  log('  1/2  the golden dataset\n')
  const evalCode = await evaluate(['--classifier=agent'])
  if (evalCode !== 0) return evalCode

  log('  2/2  the bundled demo run\n')
  const demoCode = await demo()
  if (demoCode !== 0) return demoCode

  log('  Done. Commit what it wrote, then `npm run cassettes:check`.\n')
  return 0
}

if (process.argv[1]?.endsWith('record.ts') === true) {
  process.exitCode = await main()
}
