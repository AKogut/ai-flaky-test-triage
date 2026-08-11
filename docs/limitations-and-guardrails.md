# Limitations & guardrails

An honest account of what this system cannot do, what it is not allowed to do, and where it will
be wrong. This page is a deliverable, not a disclaimer.

## Capability guardrails — enforced, not promised

| Guardrail                                            | How it is enforced                                                                                                                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agents never modify the working tree                 | No filesystem-write tool is registered on any agent. The orchestrator writes exactly one file (`report.md`) and does so itself. A unit test asserts no agent module imports `fs.write*`. |
| Agents never push, tag, or open PRs                  | `simple-git` is wrapped in a read-only facade exposing `diff`, `log`, `show` only.                                                                                                       |
| Agents never approve or merge                        | The workflow's `GITHUB_TOKEN` is scoped `pull-requests: write, contents: read`. It cannot approve its own PRs or merge.                                                                  |
| Fix suggestions are never applied                    | `patch` is a string rendered inside a fenced code block. No code path reaches an apply step.                                                                                             |
| Cost cannot run away                                 | Per-run token budget; the orchestrator stops dispatching and reports truncation.                                                                                                         |
| The pipeline cannot fail the build on its own errors | The agent job is `continue-on-error`. Only the test job and the eval gate can fail CI.                                                                                                   |

## What the system genuinely cannot do

- **It cannot reproduce a failure.** It reads a trace after the fact. It cannot rerun a test in
  isolation, bisect, or check whether a fix works. Every root cause is a hypothesis.
- **It cannot see runtime state.** No heap, no logs beyond what the reporter captured, no network
  timeline. If the evidence is not in the report, the diff, or the source, it does not exist.
- **It cannot see history it was not given.** History lives in a CI cache. A cache miss (first run
  on a branch, eviction, expiry) means every test looks new, and the `determinism` axis degrades
  to within-run retry evidence only.
- **It cannot detect flakiness on a single run.** Flakiness is a property of a distribution.
  One run with one failure carries almost no intermittency signal.
- **It does not generalise beyond this repository.** Prompts, heuristics, and the dataset are
  tuned to TaskFlow's failure modes and this test stack. Nothing here claims otherwise.

## Where it will be wrong

Measured, published in `eval/report.md`, and expected:

- **`app_code + intermittent` is the weakest quadrant** and also the most consequential. A missed
  product race gets rerun until green and ships.
- **Confidence is not automatically trustworthy.** See the calibration section of
  [eval-methodology.md](eval-methodology.md#4-confidence-calibration). Until ECE is measured and
  acceptable, treat the number as a sortable hint, not a probability.
- **Misleading history is a known trap.** A test flaky for 200 runs that today fails for a new,
  deterministic reason will be under-called as `intermittent`.
- **Large diffs dilute the signal.** A 40-file refactor makes "the diff touches the file under
  test" nearly always true and the strongest heuristic feature goes flat.
- **Non-English or heavily templated assertion messages** degrade extraction quality; the dataset
  does not currently cover them.
- **Capping evidence can remove the answer.** A stack trace cut at 4000 characters may lose the
  frame that explained the failure, and the secret scrub is broad enough to redact a hard-coded
  value a test was asserting on. Neither is silent: the prompt says how much was removed and the
  report repeats it, so a classification made on partial evidence is legible as one.

## Security posture

**Threat model.** The realistic adversary is a contributor opening a PR from a fork with hostile
content in test names, assertion messages, source comments, or diff hunks — all of which flow
into a prompt.

| Concern                               | Position                                                                                                                                                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secrets in fork PRs                   | GitHub does not expose secrets to fork-triggered workflows. That is correct and is not worked around. `pull_request_target` is **not** used — it would run untrusted code with a write-scoped token.                                                                       |
| Degraded mode on forks                | With no API key the pipeline runs the baseline heuristic only and the comment says so explicitly.                                                                                                                                                                          |
| Prompt injection                      | Untrusted text is delimited, capped, and introduced as data by `agents/sanitise.ts`; harness markers are escaped out of content so nothing can close its own block. Output is schema-constrained, so the model can emit enum values and bounded strings, not instructions. |
| Hidden text in evidence               | Bidirectional overrides and zero-width characters are removed, not escaped. Their only use here is to make a line render as something other than what it says — to the reviewer of the input first, then to the reader of the report that quotes it.                       |
| Injection impact ceiling              | Nothing executes agent output. The worst outcome is a wrong label and a misleading comment.                                                                                                                                                                                |
| Markdown/HTML injection in the report | Agent output is escaped before rendering, so injected content cannot forge report structure or embed hidden markers.                                                                                                                                                       |
| Data leaving the repository           | Source snippets and diff hunks are sent to the Anthropic API. This is stated in the README and is the one genuine data-egress path. Private forks should not enable the agent job without understanding it.                                                                |
| Secret leakage into prompts           | A secret-pattern scrub runs over every untrusted field before it enters a prompt, and before the length cap is applied so a credential cannot be sliced past its own pattern. One pattern list, shared with the cassette writer. Best-effort, not a guarantee.             |
| Token scope                           | Least privilege: `pull-requests: write`, `contents: read`. No `actions: write`, no `packages`, no org scope.                                                                                                                                                               |

## Operational limitations

- **Cache write contention.** Concurrent runs can lose a history update. Mitigation: only the
  `main` job writes history; PR jobs read. Documented in ADR-0004.
- **Cache eviction.** GitHub evicts caches after 7 days of no access and at a 10 GB repo cap.
  History is not durable storage.
- **Comment upsert relies on a marker.** If a user deletes the bot comment, the next run posts a
  fresh one. Harmless, occasionally confusing.
- **Non-determinism in the eval gate.** The classifier's own eval is mildly flaky, which is why
  the gate uses a confidence lower bound and N-sample averaging. Acknowledged irony.
- **Rate limits.** A run with many failures serialises behind API rate limits. Concurrency is
  capped at 4 and the budget aborts long tails.

## Ethical and practical caveats

- **The output is advisory.** It is a prioritisation aid for a human reviewer, not a verdict.
  Every comment carries the classifier's measured accuracy inline so nobody mistakes it for one.
- **Automation bias is a real risk.** A confident wrong classification is worse than no
  classification, because it redirects attention. This is why `alternativeHypothesis` is mandatory
  below the confidence threshold and why `risks` is a required field on fix suggestions.
- **It is not a substitute for fixing flaky tests.** A system that makes flakiness comfortable to
  live with can entrench it. The report deliberately surfaces long-lived flaky tests as
  accumulating debt rather than routine noise.
