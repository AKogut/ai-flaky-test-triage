import type { GitReader } from './git.js'

/**
 * The change under test, read once per run, for every classifier to see.
 *
 * Both classifiers rest part of their answer on what a change touched. The
 * baseline has a rule for it — a product source file changed, so `app_code` —
 * and the model is given the paths, the hunks and the derived signal. Without
 * this module neither saw anything: `agents/run.ts` built its inputs from the
 * test alone, and the rule could not fire in CI.
 *
 * **Any failure is "no diff", never a crash and never an empty diff.** A
 * shallow checkout, an unreachable base, a directory that is not a repository —
 * each one returns the reason, which the caller logs and reports as a
 * degradation. Treating a failed read as an empty one would be the worse
 * mistake: "nothing changed" is evidence, and it would be false.
 *
 * Git access is the read-only facade in `agents/git.ts`, handed in by the
 * caller, so this module never holds a client of its own and a test needs no
 * repository at all.
 */

/**
 * The contract's ceiling on `ClassificationInput.diff`, from `contracts/analysis.ts`.
 *
 * Not the cap the model feels — `sanitise.ts` fences the hunks at 12,000
 * characters. This keeps the input the pipeline builds inside the contract it
 * declares, so a pull request that rewrites a lockfile does not produce one no
 * fixture could hold.
 */
export const DIFF_LIMIT = 20_000

/** Marked rather than silent: a diff cut short must not read as one that ended there. */
export const DIFF_CUT =
  '\n[diff cut here to fit the classification input; later files are not shown]'

/**
 * Which range "the change under test" means in this job.
 *
 * On a `pull_request` event GitHub names the target branch in `GITHUB_BASE_REF`,
 * and the change is everything since the merge base with it — the three dots.
 * On a push, and locally, it is the commit itself against its first parent:
 * on `main` that is the squashed pull request that just merged.
 */
export function diffRange(env: NodeJS.ProcessEnv): string {
  const base = env.GITHUB_BASE_REF ?? ''
  return base === '' ? 'HEAD~1..HEAD' : `origin/${base}...HEAD`
}

export interface DiffRead {
  range: string
  /** The patch text, capped to the contract. Absent when the read failed or the change is empty. */
  diff?: string
  /** Why the read failed, for the job log. Absent when it worked. */
  failure?: string
}

/** Never rejects. `open` is called inside the guard, so a client that fails to construct is a failure too. */
export async function readDiff(open: () => GitReader, env: NodeJS.ProcessEnv): Promise<DiffRead> {
  const range = diffRange(env)
  try {
    const text = await open().diff({ range })
    return text === '' ? { range } : { range, diff: fitDiff(text) }
  } catch (error) {
    return { range, failure: error instanceof Error ? error.message : String(error) }
  }
}

/** Cut at a line boundary, under the contract's limit, with the cut marked. */
export function fitDiff(diff: string, limit = DIFF_LIMIT): string {
  if (diff.length <= limit) return diff
  const room = limit - DIFF_CUT.length
  const boundary = diff.lastIndexOf('\n', room)
  return diff.slice(0, boundary > 0 ? boundary : room) + DIFF_CUT
}
