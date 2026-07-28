# FAQ

## Is this just an LLM wrapper?

Partly, and the interesting question is how much value the LLM part adds — which is why the project
answers it with numbers instead of assertions.

A thirty-line non-LLM heuristic classifies the same dataset, and every agent number is reported next
to it. If the heuristic wins, the README says the heuristic wins. That comparison, plus the ablation
study measuring what each piece of context contributes, is the part that is not a wrapper.

## How is this different from Flakemetry or similar tools?

Those detect *which* tests are unstable. This decides *what to do about a specific failure* — is it
the product, the test, or the runner, and will rerunning help. Flakemetry-style analysis is consumed
here as a library; this project is the layer above it.

## Why two axes instead of one label?

Because a flat list overlaps with itself. A race in the product is both "a real bug" and "a race
condition", so the person labelling has to choose arbitrarily and chooses differently a week later.
Once ground truth stops being reproducible, every metric built on it is decoration.

[Classification Taxonomy](Classification-Taxonomy) ·
[ADR-0002](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/adr/0002-two-axis-classification-taxonomy.md)

## Can I run it without an API key?

Yes — `npm run demo` runs the whole pipeline against recorded model responses, offline and free. The
test suite and the evaluation harness also run in replay mode.

You need a key only to classify a *new* failure with a live model.

## Why is the accuracy number not higher?

Because the dataset is built to be hard on purpose. Roughly 20% of fixtures are the hard quadrant,
another 20% are specifically designed to defeat the obvious shortcuts — a test flaky for 200 runs
that today fails for a new reason, an environment failure inside a suspicious diff.

A dataset of clearly-flaky tests would produce a much better number and would measure nothing. The
headline is also **joint accuracy** — both axes correct on the same fixture — which is always lower
than either axis alone.

## Why do the tests deliberately fail sometimes?

The flaky specs are input, not oversight. They exist so the pipeline has realistic failures to
classify, and each one's header comment explains the mechanism and why the label is what it is.

The distinction that matters: their flakiness is **emergent** — it comes from a real race in the app,
reproducible under a documented seed — not scripted with a random sleep in the test. Scripted
flakiness makes the classification problem trivial and worthless.

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

That is a claim rather than an axiom, and the ablation study tests it against a bounded multi-step
variant. If the loop wins on the hard quadrant, the architecture changes.

## What happens on a pull request from a fork?

GitHub does not give fork-triggered workflows access to secrets, so there is no API key and the
pipeline runs the baseline heuristic only. The comment says so explicitly.

The popular workaround, `pull_request_target`, runs untrusted code with a write-scoped token and
secrets in the environment. It is not used here and a CI check asserts it never appears.

## Will it work on my repository?

Not without work, and the project does not claim otherwise. The prompts, the heuristic, and the
dataset are tuned to one application's failure modes and one test stack. Generalising is a different
project with a different set of problems.

## Why is the evaluation itself slightly flaky?

Because model output is non-deterministic even at temperature 0, and 60 fixtures carry a ±11pp
confidence interval. Rather than pretending otherwise, the harness samples each fixture five times,
reports variance and label stability, and gates CI on interval lower bounds.

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
