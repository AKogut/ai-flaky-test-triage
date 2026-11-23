# Glossary

Project-specific terms. Where a term has a general meaning too, the definition here is the one that
applies in this repository.

---

**Ablation** — re-running the evaluation with one part of the context removed, to measure what that
part actually contributes. A field that changes nothing is cost and latency with no return.

**`analysis.json`** — the seam between the statistical half of the pipeline and the AI half. Written
by `flakemetry-lib`, read by the agents. Also a committed fixture format, so changing it is a
breaking change.

**`app_code`** — value on the `owner` axis. The product is wrong and the test correctly caught it.

**Baseline** — the deliberately simple, model-free heuristic classifier that every agent number is
reported against. It is the control, it is the only classifier available on fork pull requests,
and until the project has an API key it is the only classifier that has run at all.

**Budget** — the per-run token ceiling. When it is hit the orchestrator stops dispatching and the
report says how many failures went unclassified, rather than truncating silently.

**Bucket** — a difficulty category in the golden dataset (hard quadrant, misleading history,
straightforward, …). Metrics are reported per bucket so a high headline cannot come purely from easy
cases.

**Captured** — fixture provenance: taken from a real CI run and labelled after the fact. Contrast
`synthetic` and `mutated`.

**Cassette** — a recorded model request/response pair, committed to the repository so the agent
can be replayed with no key and no network. None are recorded yet: recording needs an API key
(#38), so the demo runs the baseline meanwhile and the integration tests use a scripted transport.

**Chaos (`SENTRA_CHAOS`)** — seeded latency injection in the demo app's API, used to reproduce a
specific race interleaving on demand. Off by default. Seeded rather than random so failures are
reproducible.

**Context bundle** — everything the triage agent sees for one failure: error, stack, snippet,
flakiness history, diff, whether the diff touches the file under test, the test's own source, and
the tests that ran before it on the same worker. Because the agents have no tools, the ceiling on
accuracy is set here rather than in the prompt.

**`determinism`** — the second classification axis: `deterministic` or `intermittent`. Answers "will
rerunning help?".

**ECE (Expected Calibration Error)** — how far stated confidence is from observed accuracy. If it is
large, the confidence number carries no information and the threshold that depends on it is
decorative.

**`environment`** — value on the `owner` axis. Neither the product nor the test; the run itself was
broken.

**Emergent flakiness** — flakiness that arises from how a system behaves rather than from a sleep
or a random number written into a test. The source may be the application (a race in its
optimistic updates), the network (a response that takes longer than usual), or the runner (which
file a worker happened to pick up next). What it is never is scripted: a test that fails on purpose
poses a classification problem that is trivial and worthless.

**EWMA** — exponentially weighted moving average, used for the flakiness score so that recent runs
count more than old ones.

**Flakiness score** — a 0..1 measure of how much a test _alternates_, not how often it fails. A test
that fails every time scores near zero: it is broken, not flaky.

**Golden dataset** — the hand-labelled fixtures every metric in the project is computed against.
Ground truth lives in a sibling file, so it is structurally impossible to feed it to the classifier
by accident.

**Hard quadrant** — `app_code` + `intermittent`. A real product race caught by a correctly written
test. Indistinguishable from a flaky test by simple signals, and the one case where rerun-until-green
causes real harm. The project exists for it.

**Held-out slice** — the part of the dataset, about a fifth by design, not consulted during prompt
iteration and reported separately. Without it, twenty rounds of prompt tuning produce a number that measures effort rather
than generalisation.

**`isNew`** — flag meaning the test appears for the first time in the available history. Often means
history was unavailable rather than that the test is genuinely new.

**Joint accuracy** — both axes correct on the same fixture. Always lower than either axis alone, and
the headline metric for exactly that reason.

**`lowConfidenceGroundTruth`** — a fixture whose label is genuinely arguable. Excluded from headline
metrics and reported separately, rather than being quietly resolved in the project's favour.

**Mutated** — fixture provenance: a captured run with an injected defect.

**`owner`** — the first classification axis: `app_code`, `test_code`, `environment`. Answers "is this
mine?".

**Provenance** — where a fixture came from. Reported as a metric breakdown so a classifier that only
performs on invented failures is visible.

**Replay mode** — running with `SENTRA_REPLAY=1`, serving model responses from cassettes with no
network. A cassette miss is a loud error, never a silent live call.

**Self-consistency** — how often the same fixture receives the same label across repeated runs. A
first-class metric: an unstable classifier cannot be trusted on an individual pull request even if
its average is good.

**Sentra** — this project. The triage layer, not the app being tested.

**Squash merge** — the only merge strategy on `main`. One issue, one branch, one commit.

**`statusHistory`** — a compact string like `PPPFPFPPF` recording a test's recent outcomes, most
recent last.

**Streak (`consecutiveFailures`)** — how many runs in a row a test has failed. A long streak points
towards `deterministic`.

**TaskFlow** — the small task-board application in `app/`. The system under test. Deliberately not
good software; it exists to fail tests.

**`test_code`** — value on the `owner` axis. The product is fine; the test is wrong, stale, or badly
synchronised.

**`TestRun`** — the normalised representation of one test execution, produced from either
Playwright's or Vitest's reporter output. Everything downstream is reporter-agnostic.

**Wilson interval** — the confidence interval used for every reported proportion. Chosen over the
normal approximation because at this dataset's size and a high accuracy the normal interval is
visibly wrong and can extend past 1.0 — publishing a broken interval in a document about statistical honesty would be
self-defeating.
