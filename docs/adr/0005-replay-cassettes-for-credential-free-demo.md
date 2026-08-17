# ADR-0005: Replay cassettes for a credential-free demo

- **Status:** Accepted
- **Date:** 2026-07-28
- **Deciders:** @AKogut

## Context

The Definition of Done claims that anyone can clone the repository and reproduce the pipeline in
five minutes. As specified, they cannot: the agent stage requires `ANTHROPIC_API_KEY`. Nobody
evaluating a portfolio project will provision an API key, and nobody should have to spend money to
read someone else's code.

The same gap hurts development. Integration tests over `agents/run.ts` either mock the client at a
level so shallow they prove nothing, or make real calls — slow, non-deterministic, and billed on
every CI run.

## Decision

All model calls route through one wrapper supporting three modes:

| Mode     | Trigger                                 | Behaviour                                         |
| -------- | --------------------------------------- | ------------------------------------------------- |
| `live`   | `SENTRA_LIVE=1`, or credentials present | Real API call                                     |
| `record` | `SENTRA_RECORD=1`                       | Real call; request/response written to a cassette |
| `replay` | `SENTRA_REPLAY=1`, or no credentials    | Cassette lookup; no network                       |

Setting more than one of the three is refused rather than resolved. Any silent winner is a trap:
somebody who meant to re-record and got replay sees stale answers and concludes the model changed.

"No credentials" is judged from `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` together — and even
then it can be wrong, because the SDK also accepts an `ant auth login` profile that leaves nothing
in the environment to detect. Somebody authenticated that way would silently get replay, which is
what `SENTRA_LIVE=1` exists to override.

Cassettes live in `agents/replay/cassettes/`, are committed, and are keyed by a stable hash of
(prompt version, model, effort, token ceiling, response-schema digest, system, prompt, **sample
index**). A replay miss is a loud error, never a silent fallthrough to a live call.

The sample index is in the key because self-consistency sampling (#36) asks the same question five
times and the answers differ. Without it every sample of a fixture would hash to one cassette,
replay would hand back the same answer five times, and the harness would report perfect stability
for a classifier nobody measured. A recorded distribution has to replay as a distribution.

`npm run demo` runs the full pipeline against a bundled fixture run. Until the first recorded
evaluation lands (#38) there is nothing to replay, so it runs the model-free baseline and prints
that — the demo degrades honestly rather than failing on a clean clone, which is the one thing it
exists not to do.

## Options considered

### Option A — Mock the SDK client in tests, no demo mode

- **Pros:** no committed fixtures.
- **Cons:** does not solve the demo problem at all; mocks drift from the real response shape and
  stop catching schema errors.

### Option B — HTTP-level interception (nock/msw)

- **Pros:** exercises the real SDK, including its parsing and retry behaviour.
- **Cons:** couples fixtures to the SDK's wire format, so an SDK upgrade invalidates every
  cassette; harder to read in review.

### Option C — Wrapper-level cassettes (chosen)

- **Pros:** one interception point; cassettes are readable JSON that reviewers can inspect; the
  demo, the integration tests, and eval-harness caching all use one mechanism; deterministic and
  free.
- **Cons:** does not exercise the SDK's own request path; cassettes must be re-recorded when the
  prompt or model changes, and stale cassettes are a real maintenance cost.

## Consequences

### Positive

- The Definition of Done becomes true: no key, no network, no cost.
- Integration tests are deterministic and free, so they can run on every PR.
- Committed cassettes double as documentation — a reader can see exactly what the model returned.
- The eval harness reuses the cache to avoid re-billing unchanged fixtures.

### Negative / accepted costs

- Cassettes are committed data and grow the repository. Mitigated by capping retained responses and
  storing only normalised fields.
- Prompt changes invalidate cassettes. A CI check flags stale cassettes so replay never silently
  demos an outdated prompt.
- Replay proves the pipeline's plumbing, not the model's current behaviour. The README says so
  where the demo is described.

### What would make us revisit this

Cassette maintenance consistently costing more than the demo is worth — the signal being cassettes
routinely stale in review, or contributors bypassing replay because re-recording is painful.
