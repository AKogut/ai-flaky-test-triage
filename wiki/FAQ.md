# FAQ

> Repository: [AKogut/ai-flaky-test-triage](https://github.com/AKogut/ai-flaky-test-triage).

## Is this just an LLM wrapper?

Partly, and the interesting question is how much value the LLM part adds — which is why the project
answers it with numbers instead of assertions.

A non-LLM heuristic of about ninety lines classifies the same dataset, and every agent number is
reported next to it. If the heuristic wins, the README says the heuristic wins. That comparison,
plus an ablation study that will measure what each piece of context contributes (🚧 M9, #78), is
the part that is not a wrapper.

No model has been scored yet. Scoring one needs an API key the project does not have, so today the
comparison has one column; the agent's arrives with #38, and the commitment above does not move.

## How is this different from Flakemetry or similar tools?

Those detect _which_ tests are unstable. This decides _what to do about a specific failure_ — is it
the product, the test, or the runner, and will rerunning help. Flakemetry-style analysis is consumed
here as a library; this project is the layer above it.

## Why two axes instead of one label?

Because a flat list overlaps with itself. A race in the product is both "a real bug" and "a race
condition", so the person labelling has to choose arbitrarily and chooses differently a week later.
Once ground truth stops being reproducible, every metric built on it is decoration.

[Classification Taxonomy](Classification-Taxonomy) ·
[ADR-0002](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/adr/0002-two-axis-classification-taxonomy.md)

## Can I run it without an API key?

Yes — nothing that runs today needs one. `npm run demo` classifies a bundled CI run offline and
free, and `npm run eval` scores the golden dataset. Both run the baseline heuristic for now, and
both say so: replay needs recorded model responses, and recording them needs a key the project
does not have yet (#38). The test suite drives the agents through a scripted transport, so it needs
no key either.

You need a key to run the model at all — live, or once, to record the cassettes that would let
everyone else replay it.

## Why is the accuracy number not higher?

Because the dataset is built to be hard on purpose. It over-weights the hard quadrant and the cases
designed specifically to defeat the obvious shortcuts — a test flaky for 200 runs that today fails
for a new reason, an environment failure inside a suspicious diff.

A dataset of clearly-flaky tests would produce a much better number and would measure nothing. The
headline is also **joint accuracy** — both axes correct on the same fixture — which is always lower
than either axis alone.

## Why do the tests deliberately fail sometimes?

The flaky specs are input, not oversight. They exist so the pipeline has realistic failures to
classify, and each one's header comment explains the mechanism and why the label is what it is —
a reader can check the ground truth rather than take it on trust.

There are ten. Three are the application's fault, two are the runner's, and three fail on every
run rather than some of the time:

| Spec                               | Owner         | Rerun           | Why it fails                                                            |
| ---------------------------------- | ------------- | --------------- | ----------------------------------------------------------------------- |
| `reorder-quick-succession.spec.ts` | `app_code`    | `intermittent`  | The client applies whichever reorder response arrives last              |
| `complete-and-reopen.spec.ts`      | `app_code`    | `intermittent`  | The same, in the completion path — found by writing the spec            |
| `back-and-forth.spec.ts`           | `app_code`    | `deterministic` | Midpoint positions run out of precision; the 55th move stores a tie     |
| `find-by-name.spec.ts`             | `test_code`   | `intermittent`  | A partial-title locator matches two rows in some list states            |
| `visible-tasks.spec.ts`            | `test_code`   | `intermittent`  | Another spec leaves a row behind — cause and symptom in different files |
| `board-updates.spec.ts`            | `test_code`   | `intermittent`  | An assertion given a fixed 120ms deadline instead of a condition        |
| `complete.spec.ts` (fixed)         | `test_code`   | `intermittent`  | Read a stored value straight after an optimistic paint                  |
| `board-on-open.spec.ts`            | `test_code`   | `deterministic` | A hand-copied list of the seed, from before the seed grew a row         |
| `board-in-webkit.spec.ts`          | `environment` | `deterministic` | Asks for WebKit on a runner that installs Chromium only                 |
| `after-a-restart.spec.ts`          | `environment` | `intermittent`  | Two tests' own servers race for one fixed port                          |

That spread is the point. A flat "flaky" label would put all of them in one bucket while they need
completely different responses, and the pair at the top — same symptom, opposite owner — is what
makes the two-axis taxonomy earn its keep.

The distinction that matters for all of them: their failures are **emergent**, not scripted. They
come from seeded latency in the server, from how the runner happens to schedule files, from
floating-point arithmetic or from what the machine has installed — never from a sleep, a `throw`
or a random number inside a test. A guard test holds every spec in the suite to that,
including the deliberate ones. Scripted flakiness makes the classification problem trivial and
worthless.

## Why aren't retries enabled in CI?

Because retrying erases intermittency, and intermittency is the signal the whole pipeline consumes.
`retries: 2` is the conventional setting and it would delete the data before it reached the
analysis.

## Why doesn't it fix things automatically?

Two reasons, one principled and one practical.

Principled: the system reads a trace after the fact. It cannot rerun a test in isolation, bisect, or
verify a fix. Every root cause is a hypothesis, and auto-applying hypotheses to a codebase is a bad
trade.

Practical: the guardrail is what makes the rest of it trustworthy. Agents have no filesystem-write
capability and no git-write capability — not as a promise, but as an absence enforced by lint rules
and asserted by tests.

## Why is there no agent loop?

Triage is one decision over a fixed, complete input — error, stack, history, diff, source. Nothing
needs discovering, so a loop would mostly re-read text the model already has, at the cost of
latency, money, and non-determinism.

That is a claim rather than an axiom, and the ablation study will test it against a bounded
multi-step variant (🚧 M9, #80). If the loop wins on the hard quadrant, the architecture changes.

## What happens on a pull request from a fork?

GitHub does not give fork-triggered workflows access to secrets, so there is no API key and the
pipeline runs the baseline heuristic only. The workflow token is read-only as well, so the report
is produced and uploaded as the `triage-report` artifact, but the comment cannot be posted. That
path has not yet been exercised by a real fork pull request.

The popular workaround, `pull_request_target`, runs untrusted code with a write-scoped token and
secrets in the environment. It is not used here and a CI check asserts it never appears.

## Will it work on my repository?

Not without work, and the project does not claim otherwise. The prompts, the heuristic, and the
dataset are tuned to one application's failure modes and one test stack. Generalising is a different
project with a different set of problems.

## Why is the evaluation itself slightly flaky?

Because model output is non-deterministic and this model exposes no sampling controls to pretend otherwise, and a
small dataset carries wide intervals — 44 fixtures today, 60 at target, and even at 60 the lower
bound of a 95% interval around 90% accuracy sits ten points below it. Rather than pretending
otherwise, the harness samples each fixture five times when a model is classifying, reports
variance and label stability, and gates CI on interval lower bounds.

A flaky-test triage tool with a mildly flaky test suite is a fair irony, and hiding it would be
worse than owning it.

## What is the project actually for?

It is a portfolio artifact, built to be evaluated by someone who clones it and runs two commands. It
is also a real attempt at a question worth asking: how much of failure triage can be automated
honestly, and how would you know?

## Where should I start reading?

[Getting Started](Getting-Started) if you want to run it,
[Evaluation Methodology](Evaluation-Methodology) if you want to know whether it works, and
[Decision Records](Decision-Records) if you want to know how it was reasoned about.
