import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Versioned prompts, and the one rubric the model and the labeller share.
 *
 * Two invariants live here, and both fail silently if they are left to
 * discipline.
 *
 * **The rubric has one copy.** `docs/agent-design.md` requires the model and the
 * human labeller to apply the same rules. If the prompt's definition of
 * `intermittent` drifts from the one the dataset was labelled by, the evaluation
 * measures agreement with a rubric nobody is applying — and it goes on producing
 * a number that looks exactly like the one that meant something. So the rubric
 * is a file, the prompt names it with a placeholder rather than quoting it, and
 * `docs/taxonomy.md` carries a generated copy that a test regenerates and
 * compares.
 *
 * **Published versions are immutable.** `eval/report.md` records which prompt
 * version produced which numbers. Editing that version in place afterwards
 * leaves the record intact and the link broken: the report still names
 * `triage.v1`, and `triage.v1` is now a different prompt. `freeze.ts` makes that
 * a build failure rather than a thing somebody notices six commits later.
 */

export const PROMPT_DIR = 'prompts'
export const RUBRIC_FILE = 'rubric.md'

/**
 * The only substitution a prompt file may contain.
 *
 * One placeholder rather than a template language on purpose. Everything else a
 * prompt needs is either fixed text — which belongs in the file, where it is
 * reviewable — or untrusted evidence, which belongs in the user message behind
 * the fences in `agents/sanitise.ts` and must never be interpolated into an
 * instruction.
 */
export const RUBRIC_PLACEHOLDER = '{{rubric}}'

/** `triage.v1` — the agent, then a major version. Minor edits do not exist: see freeze.ts. */
const VERSION_PATTERN = /^[a-z][a-z-]*\.v[1-9]\d*$/

export type Agent = 'triage' | 'root-cause' | 'fix-suggestion'

/**
 * Which version each agent uses today.
 *
 * A constant rather than "the highest version on disk". Resolving it
 * automatically means adding a file changes what every future number is measured
 * against, which is the sort of thing that should require a line in a diff.
 */
export const CURRENT_PROMPT: Partial<Record<Agent, string>> = {
  triage: 'triage.v1',
}

export class PromptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PromptError'
  }
}

export interface Prompt {
  version: string
  /** The assembled system prompt. The user message carries the evidence, and only that. */
  system: string
}

/** The rubric text, verbatim, with no trailing newline so it embeds cleanly. */
export function loadRubric(dir: string = PROMPT_DIR): string {
  return read(join(dir, RUBRIC_FILE), 'rubric').trimEnd()
}

/**
 * Assemble a prompt by version.
 *
 * Deliberately re-reads from disk on every call. A cache would save two small
 * file reads next to a model call that costs orders of magnitude more, and would
 * buy a class of bug — an edited prompt still serving its old text — that is
 * unusually hard to see, because everything downstream keeps working and only
 * the numbers move.
 */
export function loadPrompt(version: string, dir: string = PROMPT_DIR): Prompt {
  if (!VERSION_PATTERN.test(version)) {
    throw new PromptError(
      `"${version}" is not a prompt version. Expected <agent>.v<n>, as in triage.v1 — ` +
        'the version is recorded in every cassette key and in eval/report.md, so it has to be parseable.',
    )
  }

  const file = join(dir, `${version}.md`)
  let template: string
  try {
    template = readFileSync(file, 'utf8')
  } catch {
    throw new PromptError(
      `no prompt file for ${version}. Expected ${file}; found ${listPromptVersions(dir).join(', ') || 'none'}.`,
    )
  }

  const system = template.replaceAll(RUBRIC_PLACEHOLDER, loadRubric(dir)).trimEnd()

  // A leftover placeholder means the template asked for something the loader does
  // not provide. Sending it would put `{{evidence}}` in front of the model as
  // though it were an instruction, and the answer would look ordinary.
  const leftover = /\{\{\s*[\w.-]+\s*\}\}/.exec(system)?.[0]
  if (leftover !== undefined) {
    throw new PromptError(
      `${file} contains an unresolved placeholder ${leftover}. ` +
        `The only substitution available is ${RUBRIC_PLACEHOLDER}.`,
    )
  }

  return { version, system }
}

/** Every prompt file on disk, derived from the directory rather than a list to maintain. */
export function listPromptVersions(dir: string = PROMPT_DIR): string[] {
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }

  return files
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.slice(0, -'.md'.length))
    .filter((version) => VERSION_PATTERN.test(version))
    .sort()
}

function read(file: string, what: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    throw new PromptError(`the ${what} is missing: expected ${file}`)
  }
}
