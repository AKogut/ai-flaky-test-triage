# Limitations and Guardrails

> Normative version, with the enforcement mechanism for each guarantee:
> [`docs/limitations-and-guardrails.md`](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/limitations-and-guardrails.md).

This is a deliverable, not a disclaimer. A tool that reports on other people's failures should be
unusually clear about its own.

## What the agents are not allowed to do

The distinction that matters: these are not promises, they are **absent capabilities**, and an
executable test suite asserts each one.

| Guarantee                         | How it holds                                                                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Never modify the working tree     | No agent has a filesystem-write tool. The orchestrator writes exactly one file. A static check fails the build if any module under `agents/` imports an `fs` write API. |
| Never push, tag, or commit        | `simple-git` is reachable only through a facade exposing `diff`, `log`, `show`. Importing it elsewhere is a lint error.                                                 |
| Never approve or merge            | The workflow token is scoped `pull-requests: write, contents: read`. It cannot approve its own pull requests.                                                           |
| Fix suggestions are never applied | `patch` is a string rendered inside a fenced code block. There is no code path from it to an apply step.                                                                |
| Cost cannot run away              | A per-run token budget stops dispatch and reports the truncation.                                                                                                       |
| Cannot fail your build            | The analysis job is `continue-on-error`. Only the tests and the eval gate can turn CI red.                                                                              |

A promise enforced by discipline is not a guardrail. A promise enforced by the absence of a
capability holds in six months, in a hurry, when nobody is thinking about it.

## What it genuinely cannot do

- **Reproduce a failure.** It reads a trace after the fact. It cannot rerun a test in isolation,
  bisect, or verify that a suggested fix works. Every root cause is a hypothesis.
- **See runtime state.** No heap, no logs beyond what the reporter captured, no network timeline. If
  the evidence is not in the report, the diff, or the source, it does not exist.
- **Detect flakiness from a single run.** Flakiness is a property of a distribution. One run with one
  failure carries almost no intermittency signal.
- **Work well without history.** A CI cache miss means every test looks new and the `determinism`
  axis falls back to within-run retries.
- **Generalise beyond this repository.** Prompts, heuristics, and the dataset are tuned to one app's
  failure modes and one test stack.

## Where it will be wrong

Measured and published in `eval/report.md`, not hypothetical:

- **The hard quadrant is the weakest and the most consequential.** A missed product race gets rerun
  until green and ships.
- **Confidence may not be trustworthy** until calibration says otherwise. Treat it as a sortable
  hint.
- **Misleading history is a known trap** — a test flaky for 200 runs that today fails for a new,
  deterministic reason.
- **Large diffs dilute the signal.** In a 40-file refactor, "the diff touches the file under test" is
  almost always true, and the strongest heuristic feature goes flat.

## Security posture

The realistic adversary is someone opening a pull request from a fork with hostile content in test
names, assertion messages, comments, or diff hunks — all of which flow into a prompt.

**`pull_request_target` is not used.** It is the popular workaround for fork PRs not receiving
secrets, and combined with checking out the PR head it executes attacker-controlled code with a
write-scoped token and repository secrets in the environment. The project degrades instead: no key
means baseline-heuristic output, and the comment says so.
([ADR-0007](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/adr/0007-no-github-app-no-pull-request-target.md))

**Injection has a low ceiling by construction.** Untrusted text is delimited and length-capped;
output is schema-constrained, so the model can emit enum values and bounded strings but not
instructions; output is escaped before rendering; and nothing downstream _executes_ it. The worst
achievable outcome is a wrong label and a misleading comment.

**One real egress path.** Source snippets and diff hunks are sent to the model API during the agent
stage. A best-effort secret scrub runs first, but it is not a guarantee. Anyone adding an API key to
a private fork should understand that before doing so.

## The risk nobody puts in a README

**Automation bias.** A confident wrong classification is worse than no classification, because it
redirects attention with unearned authority. That is why `alternativeHypothesis` is mandatory below
the confidence threshold, why `risks` is a required field, and why every report states the
classifier's own measured accuracy inline.

**Making flakiness comfortable.** A tool that makes flaky tests pleasant to live with can entrench
them. The report deliberately surfaces long-lived flaky tests as accumulating debt rather than as
routine noise.

The output is advisory. It is a prioritisation aid for a human reviewer, and it is never a verdict.
