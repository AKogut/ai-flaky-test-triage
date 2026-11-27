# Limitations and Guardrails

> Normative version, with the enforcement mechanism for each guarantee:
> [`docs/limitations-and-guardrails.md`](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/limitations-and-guardrails.md).
> Repository: [AKogut/ai-flaky-test-triage](https://github.com/AKogut/ai-flaky-test-triage).

This is a deliverable, not a disclaimer. A tool that reports on other people's failures should be
unusually clear about its own.

## What the agents are not allowed to do

The distinction that matters: the enforced ones are not promises, they are **absent capabilities**.
All six below are enforced today. A guarantee that was only planned would be labelled as planned,
because a guardrail nobody has built yet reads exactly like one that works — and three of these
were, until #63, #65 and #66 closed.

- The agents never modify the working tree.
- The triage stages cannot fail your build.
- The agents never approve or merge.
- Cost cannot run away.
- The agents never push, tag, or commit.
- Fix suggestions are never applied.

What enforces each one — the lint rule, the token scope, the test that feeds a rule a real
violation — is in the
[guardrail table](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/limitations-and-guardrails.md#capability-guardrails).

A promise enforced by discipline is not a guardrail. A promise enforced by the absence of a
capability holds in six months, in a hurry, when nobody is thinking about it — which is why a
guarantee that is not yet enforced says so.

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

Measured and published in `eval/report.md`, not hypothetical — so far for the baseline only, since
no model has been scored yet (#38):

- **The hard quadrant is the most consequential, and a weak one.** A missed product race gets rerun
  until green and ships. It is not the baseline's weakest quadrant; the report shows which are.
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
means baseline-heuristic output, and the report says so. A fork's token is read-only too, so the
report is uploaded as the `triage-report` artifact rather than posted as a comment — a path not
yet exercised by a real fork pull request.
([ADR-0007](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/adr/0007-no-github-app-no-pull-request-target.md))

**Injection has a low ceiling by construction.** Untrusted text is delimited and length-capped;
output is schema-constrained, so the model can emit enum values and bounded strings but not
instructions; output is escaped before rendering; and nothing downstream _executes_ it. The worst
achievable outcome is a wrong label and a misleading comment.

**One real egress path.** Source snippets and diff hunks are sent to the model API whenever the
agent stage runs with a key. A best-effort secret scrub runs first, but it is not a guarantee. Anyone adding an API key to
a private fork should understand that before doing so.

## The risk nobody puts in a README

**Automation bias.** A confident wrong classification is worse than no classification, because it
redirects attention with unearned authority. That is why `alternativeHypothesis` is mandatory below
0.7 confidence, why `risks` is a required field, and why every report states the
measured accuracy of whichever classifier produced it, inline.

**Making flakiness comfortable.** A tool that makes flaky tests pleasant to live with can entrench
them. The intent is for the report to surface long-lived flaky tests as accumulating debt rather
than as routine noise. That is planned, not built: today the report classifies the failures in
front of it and says nothing about how long a test has been flaky.

The output is advisory. It is a prioritisation aid for a human reviewer, and it is never a verdict.
