# Sentra

**An AI triage layer for CI test failures — packaged as a pipeline step, not a service.**

<!-- status:start -->

> **Project status: M3 — Triage agent & replay mode.**
> 3 of 11 milestones complete.
> Current exit criterion: the triage agent beats the baseline on joint accuracy by a margin that survives its confidence interval — or the finding that it does not is documented in the README. Either way, `npm run demo` runs the classifier end to end with no API key.
>
> Progress is tracked as [milestones](https://github.com/AKogut/ai-flaky-test-triage/milestones), not dates.
> Commands marked 🚧 below are not implemented yet. Running one names the milestone it
> arrives in rather than failing with a missing-script error.

<!-- status:end -->

Flaky-test detectors tell you _which_ tests are unstable. They do not tell you what to do about it.
After every red CI run somebody still has to open the trace, read the stack, look at the diff, and
decide: is this a real bug, a badly written test, or the runner having a bad day? Sentra automates
that decision and posts the result as a single pull-request comment.

Everything runs inside one CI job or one terminal command. There is deliberately no box that stays
on.

---

## Where to start

**If you have five minutes** — read [Getting Started](Getting-Started), run `npm run demo`, and look
at the generated `report.md`. No API key is required.

**If you want to know whether it works** — go straight to
[Evaluation Methodology](Evaluation-Methodology) and then to
[`eval/report.md`](https://github.com/AKogut/ai-flaky-test-triage/blob/main/eval/report.md).
That is where the honest numbers live, including the ones that are unflattering.

**If you are evaluating the engineering** — [Architecture Overview](Architecture-Overview) and the
[Decision Records](Decision-Records). The ADRs explain the choices that are not obvious from the
code, including several where the easy answer was rejected.

**If you are going to contribute** — [Contributing](Contributing) and
[Branching and Release](Branching-and-Release).

---

## How this documentation is organised

Two surfaces, one rule.

|                                                                                                | Holds                                                                                      | Why                                                                                                                       |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **[`docs/`](https://github.com/AKogut/ai-flaky-test-triage/tree/main/docs)** in the repository | Normative specifications: schemas, contracts, labelling rules, ADRs                        | Versioned with the code, so it must match the code exactly. A PR that changes behaviour changes these in the same commit. |
| **This wiki**                                                                                  | Orientation and narrative: how the pieces fit, why decisions were made, what to read first | Free to be discursive; nothing here is a contract                                                                         |

Nothing is duplicated between them. The wiki links into `docs/` rather than restating it, because
two copies of a specification means one of them is wrong.

---

## The idea in one table

Every test failure is classified on two orthogonal axes rather than a single flat label:

|                   | `deterministic`            | `intermittent`                             |
| ----------------- | -------------------------- | ------------------------------------------ |
| **`app_code`**    | Regression. Ship-blocking. | **Product race — the dangerous quadrant.** |
| **`test_code`**   | Stale test.                | Unsynchronised test.                       |
| **`environment`** | Broken setup.              | Infrastructure noise.                      |

The first axis answers _is this mine?_ The second answers _will rerunning help?_ Neither is
derivable from the other, and that ambiguity is precisely where triage effort goes.

Why not a single flat label: [Classification Taxonomy](Classification-Taxonomy).

---

## What makes this different from an LLM wrapper

Three things, all of which are measured rather than claimed:

1. **A non-LLM baseline.** A thirty-line heuristic classifies the same dataset. Every reported
   number is the agent _relative to that_. If the heuristic wins, the README says the heuristic
   wins.
2. **An adversarial dataset.** The fixtures deliberately over-weight cases designed to defeat the
   obvious shortcuts — real races that look like flakes, environment noise inside a suspicious
   diff, tests that have been flaky for months and today fail for a new reason.
3. **Reported uncertainty.** Accuracy on 60 fixtures carries a ±11pp interval, and model output is
   non-deterministic even at temperature 0. Every metric ships with its confidence interval, and
   the CI gate fires on the lower bound.

There is a pleasing irony in a flaky-test triage tool whose own evaluation is mildly flaky. It is
documented rather than hidden.

---

## Project status

Tracked as eleven milestones, ordered **dataset-first** — the evaluation harness lands before the
demo app, so the project's central claim is tested before time goes into UI work.

- [Milestones](https://github.com/AKogut/ai-flaky-test-triage/milestones)
- [Open issues](https://github.com/AKogut/ai-flaky-test-triage/issues)
- [Roadmap](Roadmap)

## Quick links

[Repository](https://github.com/AKogut/ai-flaky-test-triage) ·
[README](https://github.com/AKogut/ai-flaky-test-triage/blob/main/README.md) ·
[Glossary](Glossary) ·
[FAQ](FAQ)
