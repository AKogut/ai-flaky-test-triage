import { simpleGit, type SimpleGit } from 'simple-git'

/**
 * The only module in the repository allowed to import `simple-git`.
 *
 * `docs/limitations-and-guardrails.md` promises that agents never push, tag, or
 * commit. A promise kept by discipline is not a guardrail — it is a habit, and
 * habits fail in six months, in a hurry, to somebody who was not there when the
 * promise was made.
 *
 * So the guarantee is made structural: agents are handed an object that has no
 * write methods on it. Not a client with the dangerous parts documented as
 * off-limits, and not a wrapper holding a public field somebody could reach
 * through — four closures over a private client, and nothing else in scope. The
 * capability is absent rather than forbidden, and #69 asserts that the lint rule
 * enforcing this file's monopoly is itself working.
 *
 * Everything here is read-only in the strongest sense available: `diff`, `log`,
 * `show`, `fileAtRef`. There is no branch, no checkout, no fetch. A caller that
 * wants one has to change this file, in a diff a reviewer will see.
 */

/**
 * Ceiling on any single read, in characters.
 *
 * Not the cap that shapes a prompt — `agents/sanitise.ts` does that, at 12,000
 * characters for diff hunks, and it is the one a reader of the report feels.
 * This is a ceiling on what enters the process at all. A merge that touches ten
 * thousand files produces a diff measured in hundreds of megabytes, and reading
 * it into a string to throw 99.99% of it away downstream is how a triage job
 * that takes eleven seconds starts getting OOM-killed on the one run where
 * something interesting happened.
 *
 * Generous on purpose: it must never be the cap that decides what the model
 * sees, or there would be two answers to "why was this diff cut short".
 */
export const GIT_OUTPUT_CAP = 1_000_000

/** Marked rather than silent: a diff that stops mid-hunk must not read as a diff that ended. */
export const GIT_TRUNCATED = '\n[... truncated: git output exceeded the read ceiling]'

export interface Commit {
  hash: string
  subject: string
  authorDate: string
}

export interface DiffOptions {
  /** Defaults to the commit under test against its first parent. */
  range?: string
  /** Limit to these paths. Passed after `--`, so a path that looks like a flag stays a path. */
  paths?: string[]
  /** `--stat` instead of the patch text. */
  summaryOnly?: boolean
}

/**
 * Four reads. No writes, and no way to reach one.
 *
 * Deliberately not extending `SimpleGit`, and deliberately not holding it on a
 * field. The client exists only in the closure `openRepository` creates, so
 * there is no property to reach through, no cast that recovers it, and no
 * autocomplete that suggests `.push`.
 */
export interface GitReader {
  /** Patch text for a range, capped and marked. */
  diff(options?: DiffOptions): Promise<string>
  /** Recent commits, newest first. */
  log(options?: { maxCount?: number; range?: string }): Promise<Commit[]>
  /** A commit, as `git show` renders it. Capped and marked. */
  show(ref: string): Promise<string>
  /** One file's contents at a ref, or `null` when the path did not exist there. */
  fileAtRef(ref: string, path: string): Promise<string | null>
}

/**
 * A read that failed because the checkout does not have the history it needs.
 *
 * The distinction matters more than it looks. On a shallow clone — which is what
 * `actions/checkout` gives you by default — `git diff HEAD~1` does not return an
 * empty diff, it fails, and the failure text is about a bad object rather than
 * about depth. Reported as an ordinary git error it sends whoever is on the
 * pipeline looking for a corrupt repository; reported as this, it names the one
 * line of YAML that fixes it.
 */
export class ShallowCheckoutError extends Error {
  constructor(
    readonly command: string,
    readonly failure: Error,
  ) {
    super(
      [
        `${command} failed on a shallow checkout: ${failure.message.trim()}`,
        '',
        'The history this needs was not fetched. In GitHub Actions:',
        '',
        '    - uses: actions/checkout@v7',
        '      with:',
        '        fetch-depth: 0',
        '',
        'Reporting this as a git error instead would send whoever is on the pipeline',
        'looking for a corrupt repository.',
      ].join('\n'),
    )
    this.name = 'ShallowCheckoutError'
  }
}

/** Applied to every read, so no path returns unbounded text. */
function capped(text: string): string {
  return text.length <= GIT_OUTPUT_CAP ? text : text.slice(0, GIT_OUTPUT_CAP) + GIT_TRUNCATED
}

/**
 * Recognises the shapes git uses for "that object is not here".
 *
 * Matched on the message because git does not distinguish these by exit code —
 * every one of them is 128. The shallow check that follows is what makes the
 * match safe: a bad ref in a full checkout is a caller error and stays one.
 */
const MISSING_OBJECT = /bad object|unknown revision|not a valid object|does not have any commits/i

export interface OpenOptions {
  /** Exposed for tests; production reads the checkout it is running in. */
  cwd?: string
}

/**
 * Open a repository for reading.
 *
 * The returned object is the whole capability. Nothing else in `agents/` may
 * import `simple-git`, which `eslint.config.js` enforces and `tests/unit/lint-guardrails.test.ts`
 * checks by feeding the config a violation.
 */
export function openRepository(options: OpenOptions = {}): GitReader {
  const git: SimpleGit = simpleGit({ baseDir: options.cwd ?? process.cwd() })

  /** Every read goes through here, so the shallow diagnosis cannot be forgotten on one of them. */
  const read = async <T>(command: string, body: () => Promise<T>): Promise<T> => {
    try {
      return await body()
    } catch (error) {
      const failure = error as Error
      if (MISSING_OBJECT.test(failure.message) && (await isShallow(git))) {
        throw new ShallowCheckoutError(command, failure)
      }
      throw failure
    }
  }

  return {
    async diff(diffOptions: DiffOptions = {}): Promise<string> {
      const args = [
        ...(diffOptions.summaryOnly === true ? ['--stat'] : []),
        diffOptions.range ?? 'HEAD~1..HEAD',
        // `--` first, so a path that begins with a dash is still a path.
        ...(diffOptions.paths === undefined ? [] : ['--', ...diffOptions.paths]),
      ]
      return capped(await read(`git diff ${args.join(' ')}`, () => git.diff(args)))
    },

    async log(logOptions: { maxCount?: number; range?: string } = {}): Promise<Commit[]> {
      const result = await read('git log', () =>
        git.log({
          maxCount: logOptions.maxCount ?? 20,
          ...(logOptions.range === undefined ? {} : { from: logOptions.range }),
          format: { hash: '%H', subject: '%s', authorDate: '%aI' },
        }),
      )
      return result.all.map((entry) => ({
        hash: entry.hash,
        subject: entry.subject,
        authorDate: entry.authorDate,
      }))
    },

    async show(ref: string): Promise<string> {
      return capped(await read(`git show ${ref}`, () => git.show([ref])))
    },

    /**
     * `null` rather than a throw when the path is absent at that ref.
     *
     * A file that did not exist yet is the ordinary case when the diff added it,
     * and making the caller distinguish that from a real failure by parsing an
     * error message is how a missing file becomes a crashed run.
     */
    async fileAtRef(ref: string, path: string): Promise<string | null> {
      try {
        return capped(await read(`git show ${ref}:${path}`, () => git.show([`${ref}:${path}`])))
      } catch (error) {
        if (error instanceof ShallowCheckoutError) throw error
        if (
          /exists on disk, but not in|does not exist|bad object/i.test((error as Error).message)
        ) {
          return null
        }
        throw error
      }
    },
  }
}

/** `true` when the checkout was cloned with `--depth`, so history is missing by design. */
async function isShallow(git: SimpleGit): Promise<boolean> {
  try {
    return (await git.raw(['rev-parse', '--is-shallow-repository'])).trim() === 'true'
  } catch {
    // Older gits do not know the flag. Not knowing is not evidence of shallowness,
    // and guessing "yes" here would mislabel every ordinary bad-ref mistake.
    return false
  }
}
