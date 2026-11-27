# Glossary

> Repository: [AKogut/ai-flaky-test-triage](https://github.com/AKogut/ai-flaky-test-triage).

Project-specific terms. Where a term has a general meaning too, the definition here is the one that
applies in this repository.

---

**Ablation** — re-running the evaluation with one part of the context removed, to measure what that
part actually contributes. A field that changes nothing is cost and latency with no return.

**`alternativeHypothesis`** — the root-cause field that states a second explanation. The schema
requires it whenever the agent's confidence is below 0.7, so a single confident-sounding story
cannot reach a reader unchallenged. Not the same number as the confidence threshold.

**`analysis.json`** — the seam between the statistical half of the pipeline and the AI half. Written
by `flakemetry-lib`, read by the agents. Also a committed fixture format, so changing it is a
breaking change.

**`app_code`** — value on the `owner` axis. The product is wrong and the test correctly caught it.

**Baseline** — the deliberately simple, model-free heuristic classifier that every agent number is
reported against. It is the control, it is the only classifier available on fork pull requests,
and until the project has an API key it is the only classifier that has run at all.

**Bucket** — a difficulty category in the golden dataset (hard quadrant, misleading history,
straightforward, …). Metrics are reported per bucket so a high headline cannot come purely from easy
cases.

**Budget** — the per-run token ceiling. When it is hit the orchestrator stops dispatching and the
report says how many failures went unclassified, rather than truncating silently.

**Captured** — fixture provenance: taken from a real CI run and labelled after the fact. Contrast
`synthetic` and `mutated`.

**Cassette** — a recorded model request/response pair, committed to the repository so the agent
can be replayed with no key and no network. None are recorded yet: recording needs an API key
(#38), so the demo runs the baseline meanwhile and the integration tests use a scripted transport.

**Chaos (`SENTRA_CHAOS`)** — seeded latency injection in the demo app's API, used to reproduce a
specific race interleaving on demand. Off by default. Seeded rather than random so failures are
reproducible.

**Confidence threshold** — the triage confidence above which an `app_code` classification goes on
to the root-cause agent. It is to be read off a model's reliability curve, not chosen, and no model
has been scored yet, so `agents:analyze` runs with it unset and the root-cause and fix-suggestion
agents stay off.

**Context bundle** — everything the triage agent sees for one failure: error, stack, snippet,
flakiness history, diff, whether the diff touches the file under test, the test's own source, and
the tests that ran before it on the same worker. Because the agents have no tools, the ceiling on
accuracy is set here rather than in the prompt.

**Definition of Done** — the list in the README that `v1.0.0` is tagged against. Each line is a
command to run or a thing to look at, and every one of them has to hold on a clean clone; that is
M10's exit criterion.

**`determinism`** — the second classification axis: `deterministic` or `intermittent`. Answers "will
rerunning help?".

**`deterministic`** — value on the `determinism` axis. The failure reproduces on every run of the
same code, so rerunning will not help.

**Development slice** — the fixtures that are not held out: the part of the dataset prompt
iteration may look at, and what `npm run eval` scores unless asked otherwise. Contrast held-out
slice.

**ECE (Expected Calibration Error)** — how far stated confidence is from observed accuracy. If it is
large, the confidence number carries no information and the threshold that depends on it is
decorative.

**Emergent flakiness** — flakiness that arises from how a system behaves rather than from a sleep
or a random number written into a test. The source may be the application (a race in its
optimistic updates), the network (a response that takes longer than usual), or the runner (which
file a worker happened to pick up next). What it is never is scripted: a test that fails on purpose
poses a classification problem that is trivial and worthless.

**`environment`** — value on the `owner` axis. Neither the product nor the test; the run itself was
broken.

**EWMA** — exponentially weighted moving average, used for the flakiness score so that recent runs
count more than old ones.

**Exit criterion** — the one condition that makes a milestone done. Closing its issues does not; it
is done when the criterion holds. Each milestone's is in `ROADMAP.md`, and the current one is in
the status banner on Home.

**Fix-suggestion agent** — the third agent. Given a root cause, it proposes an approach, an
illustrative patch, the `risks` it carries and, where there is one, the test that would have caught
it. It returns an object and nothing applies it. Off for as long as the root-cause agent is.

**Fixture** — one labelled case in the golden dataset, kept as two files: `<name>.run.json`, the
payload a classifier is shown, and `<name>.labels.json`, the answer it never is.

**`flakemetry-lib`** — the statistical half of the pipeline, as a workspace. It merges a run into
the stored history and scores each test against it — flakiness score, streak, `isNew` — and its
output is `analysis.json`. No model is involved, and a pull-request run reads the history without
writing it.

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

**`intermittent`** — value on the `determinism` axis. The same code passes on one run and fails on
another, so a rerun may go green — which, in the hard quadrant, hides a real bug rather than
clearing a flake.

**`isNew`** — flag meaning the test appears for the first time in the available history. Often means
history was unavailable rather than that the test is genuinely new.

**Joint accuracy** — both axes correct on the same fixture. Always lower than either axis alone, and
the headline metric for exactly that reason.

**Label leakage** — ground truth reaching what the classifier is shown: a fixture name, test title
or payload string that gives the answer away. The quietest way to inflate an accuracy number.
`npm run eval:lint` fails on a list of giveaway words; semantic leakage gets past any list.

**`lowConfidenceGroundTruth`** — a fixture whose label is genuinely arguable. Excluded from headline
metrics and reported separately, rather than being quietly resolved in the project's favour.

**Merge gate** — `npm run eval -- --gate`, run on every pull request as the required Evaluation
gate check. It fails when the committed report no longer matches a fresh run or a threshold in
`eval/gate.ts` is crossed, and it compares interval lower bounds, never point estimates.

**Mutated** — fixture provenance: a captured run with an injected defect.

**`owner`** — the first classification axis: `app_code`, `test_code`, `environment`. Answers "is this
mine?".

**Provenance** — where a fixture came from. Reported as a metric breakdown so a classifier that only
performs on invented failures is visible.

**Replay mode** — running with `SENTRA_REPLAY=1`, serving model responses from cassettes with no
network. A cassette miss is a loud error, never a silent live call.

**`report.md`** — the triage report: one markdown document, written by `agents:analyze` or
`npm run demo`, posted as the pull request's comment and edited in place on later pushes. Not
`eval/report.md`, which is the committed evaluation report.

**Root-cause agent** — the second agent. For an `app_code` classification above the confidence
threshold, it states a hypothesis, the files and symbols it implicates, a mechanism, and an
`alternativeHypothesis` when it is unsure. Implemented and tested; off until a confidence threshold
exists.

**Rubric** — the classification rules the triage prompt carries and the golden dataset was
labelled by. One file, `prompts/rubric.md`; `docs/taxonomy.md` carries a generated copy, and CI
fails when the two differ.

**Scripted transport** — a stand-in for the model API in tests, answering each call with a reply
the test wrote. It is how the agents are tested with no key and no cassettes.

**Self-consistency** — how often the same fixture receives the same label across repeated runs. A
first-class metric: an unstable classifier cannot be trusted on an individual pull request even if
its average is good.

**Sentra** — this project. The triage layer, not the app being tested.

**`SENTRA_E2E_RETRIES`** — how many times Playwright retries a failing spec. Zero unless set, and
CI never sets it: a retry erases the intermittency the pipeline reads. It exists for a local
investigation, typed on purpose.

**Squash merge** — the only merge strategy on `main`. One issue, one branch, one commit.

**`statusHistory`** — a compact string like `PPPFPFPPF` recording a test's recent outcomes, most
recent last.

**Streak (`consecutiveFailures`)** — how many runs in a row a test has failed. A long streak points
towards `deterministic`.

**Synthetic** — fixture provenance: hand-authored, with no CI run behind it. Contrast `captured`
and `mutated`.

**TaskFlow** — the small task-board application in `app/`. The system under test. Deliberately not
good software; it exists to fail tests.

**`test_code`** — value on the `owner` axis. The product is fine; the test is wrong, stale, or badly
synchronised.

**`TestRun`** — the normalised representation of one test execution, produced from either
Playwright's or Vitest's reporter output. Everything downstream is reporter-agnostic.

**Triage agent** — the first agent, and the only one switched on: one model call per failing or
newly flaky test, returning the two-axis classification with a confidence and the evidence it
quotes. With no API key the baseline runs in its place, and the report says which ran.

**Unclassified** — a failing test the report lists without a classification, with the reason: the
call failed, the token budget refused it, it was `not-dispatched` because the budget had already
stopped the run, or no classifier ran. Listed rather than left out, because a missing row reads as
"nothing was wrong with this test".

**Wilson interval** — the confidence interval used for every reported proportion. Chosen over the
normal approximation because at this dataset's size and a high accuracy the normal interval is
visibly wrong and can extend past 1.0 — publishing a broken interval in a document about statistical honesty would be
self-defeating.
