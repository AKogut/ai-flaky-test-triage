import type { Classification, FixturePayload } from '@sentra/contracts'

/**
 * The control.
 *
 * A deliberately simple, model-free classifier producing the same
 * `Classification` shape as the agent and scored on the same fixtures. Without
 * it the agent's accuracy is a number with nothing to compare against, and the
 * project cannot answer the only question that matters: does the model earn its
 * cost?
 *
 * The rules come from docs/eval-methodology.md and are implemented unmodified.
 * Two temptations are worth naming so they can be resisted in review: tuning
 * this down until the agent looks good, and building it up until it looks
 * impressive. It should be the classifier a competent engineer would write in an
 * afternoon, and no more.
 *
 * It has a second job. On fork pull requests there is no API key
 * (ADR-0007), so this is the only classifier the pipeline has — which is why it
 * emits real `reasoning` and `evidence` rather than a label alone.
 */

/**
 * Errors that mean the run itself broke before any assertion was reached.
 *
 * Kept narrow on purpose. Every pattern added here is a case moved out of the
 * ordinary rules, so a loose pattern quietly turns product failures into
 * `environment` — the classification that tells a developer to do nothing.
 */
const INFRASTRUCTURE = [
  /EADDRINUSE|address already in use/i,
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i,
  /Cannot find module|MODULE_NOT_FOUND/i,
  /browser(Type)?\.launch|Executable doesn't exist|browser has been closed/i,
  /JavaScript heap out of memory|ENOSPC|EMFILE/i,
  /spawn \w+ ENOENT/i,
]

/** Failures that name a selector or a wait rather than a value. */
const LOCATOR_OR_WAIT =
  /locator|getBy\w+|selector|Timed out \d+ms waiting|Timeout \d+ms exceeded|waitFor/i

/** A changed path that is a test rather than product source. */
const TEST_PATH = /(^|\/)(tests?|__tests__|e2e|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/

/**
 * A changed path counts as product source only if it looks like code.
 *
 * Without this, a commit touching only `README.md` reads as a product change and
 * the second rule fires — the right answer for entirely the wrong reason. That
 * is different from the rule's *inherent* crudeness, which is left alone: a real
 * product diff on a stale test still yields `app_code`, because narrowing that
 * would be tuning the control against the dataset it exists to control for.
 */
const SOURCE_EXTENSION = /\.(ts|tsx|js|jsx|mjs|cjs|sql|css|html)$/i
const NOT_PRODUCT = /^(\.github|docs|wiki)\/|\.config\.[cm]?js$/

/**
 * Confidence per rule, from how specific the rule is.
 *
 * An infrastructure pattern names the failure outright, so it earns more than
 * the fallback, which is a guess dressed as a rule. These are the weakest part
 * of the baseline and are expected to be badly calibrated — measuring that is
 * #37's job, and the same measurement applies to the agent.
 */
const CONFIDENCE = {
  infrastructure: 0.8,
  productDiff: 0.6,
  locator: 0.65,
  fallback: 0.35,
  streak: 0.7,
  noStreak: 0.5,
  noHistory: 0.3,
} as const

/** Product-source paths in the diff. Test and non-code paths are dropped. */
function changedProductPaths(diff: string): string[] {
  return [...diff.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)]
    .map((m) => m[1] ?? '')
    .filter(
      (p) => p !== '' && SOURCE_EXTENSION.test(p) && !TEST_PATH.test(p) && !NOT_PRODUCT.test(p),
    )
}

export function classifyWithBaseline(payload: FixturePayload): Classification {
  const { result, signal } = payload.subject
  const message = `${result.error?.message ?? ''}\n${result.error?.stack ?? ''}`
  const changedProduct = changedProductPaths(payload.diff ?? '')

  const evidence: string[] = []
  let owner: Classification['owner']
  let ownerConfidence: number
  let ownerReason: string

  const infrastructure = INFRASTRUCTURE.find((p) => p.test(message))
  if (infrastructure !== undefined) {
    owner = 'environment'
    ownerConfidence = CONFIDENCE.infrastructure
    ownerReason = 'the failure names an infrastructure error, so no assertion was reached'
    evidence.push(firstLine(message))
  } else if (changedProduct.length > 0) {
    owner = 'app_code'
    ownerConfidence = CONFIDENCE.productDiff
    ownerReason = 'the commit changes product source'
    evidence.push(`diff touches ${changedProduct.slice(0, 3).join(', ')}`)
  } else if (LOCATOR_OR_WAIT.test(message)) {
    owner = 'test_code'
    ownerConfidence = CONFIDENCE.locator
    ownerReason = 'the failure names a selector or a wait rather than a value'
    evidence.push(firstLine(message))
  } else {
    owner = 'app_code'
    ownerConfidence = CONFIDENCE.fallback
    ownerReason = 'no rule matched, so the fallback applies'
    evidence.push(firstLine(message) || `status: ${result.status}`)
  }

  const streak = signal.consecutiveFailures >= 2 && !result.flakyWithinRun
  const determinism: Classification['determinism'] = streak ? 'deterministic' : 'intermittent'
  const determinismConfidence = !payload.historyAvailable
    ? CONFIDENCE.noHistory
    : streak
      ? CONFIDENCE.streak
      : CONFIDENCE.noStreak

  evidence.push(
    payload.historyAvailable
      ? `history ${signal.statusHistory}, ${String(signal.consecutiveFailures)} consecutive failures`
      : 'no history available',
  )

  return {
    owner,
    determinism,
    confidence: round(Math.min(ownerConfidence, determinismConfidence)),
    reasoning: truncate(
      `${owner}: ${ownerReason}. ${determinism}: ${
        streak ? 'an unbroken recent failure streak' : 'no unbroken failure streak'
      }${payload.historyAvailable ? '' : ' and no history to draw on'}.`,
      400,
    ),
    evidence: evidence.filter((e) => e !== '').slice(0, 6),
  }
}

const firstLine = (s: string): string => truncate(s.split('\n')[0]?.trim() ?? '', 200)
const truncate = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s
/** Two decimal places, so a floating-point tail cannot make output non-reproducible. */
const round = (n: number): number => Math.round(n * 100) / 100
