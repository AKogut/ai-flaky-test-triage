# ADR-0004: History persistence via CI cache, `main`-only writes

- **Status:** Accepted
- **Date:** 2026-07-28
- **Deciders:** @AKogut
- **Related:** [ADR-0001](0001-single-repo-no-persistent-services.md)

## Context

The `determinism` axis needs to know how a test behaved over previous runs. ADR-0001 rules out a
database. So history has to be a file that survives between ephemeral CI jobs.

The specification proposed GitHub Actions artifacts: download the previous run's history, update,
re-upload. Artifacts are the wrong primitive for this. They are addressed by run, not by key, so
"fetch the latest history" means listing runs through the API and picking one — and they expire on
a retention policy designed for build outputs.

There is also a correctness hazard independent of the storage choice: two jobs finishing at once
both read the same history and both write. One update is silently lost, and the lost update
degrades exactly the signal the system depends on.

## Decision

History lives in `.flakemetry/history.json`, persisted with `actions/cache`:

- Cache key: `history-${{ github.ref_name }}-${{ github.run_id }}`
- Restore keys, in order: `history-${{ github.ref_name }}-`, then `history-main-`

**Only jobs running on `main` write the cache.** Pull-request jobs restore history read-only.
Writes are atomic (temp file + rename) and merge-based rather than overwrite, so a partial or
concurrent write cannot truncate the file.

## Options considered

### Option A — Actions artifacts (spec proposal)

- **Pros:** explicit, inspectable, downloadable from the UI.
- **Cons:** addressed by run rather than key; requires API listing to find the latest; retention is
  build-output-shaped; no restore-key fallback.

### Option B — `actions/cache` with restore-key fallback (chosen)

- **Pros:** keyed lookup with hierarchical fallback is exactly the semantics needed; branch
  history falls back to `main` automatically; zero external infrastructure.
- **Cons:** eviction after 7 days idle; 10 GB repository cap; caches are not readable across
  unrelated branches in all configurations; not durable storage.

### Option C — Commit history to an orphan `flakemetry-history` branch

- **Pros:** genuinely durable; auditable; diffable over time.
- **Cons:** requires write-scoped `contents` permission in CI, which weakens the guardrail posture;
  push contention needs retry-on-conflict; pollutes the commit graph with machine noise.

### Option D — Commit history to `main`

- Rejected. Every CI run mutating `main` makes the history unusable and the diff illegible.

## Consequences

### Positive

- No infrastructure, consistent with ADR-0001.
- Restore-key fallback gives new branches useful history from `main` immediately.
- `main`-only writes eliminate the lost-update race entirely rather than mitigating it.

### Negative / accepted costs

- History is not durable. Cache eviction resets it, and the pipeline must degrade gracefully —
  every test looks `isNew` and `determinism` falls back to within-run retry evidence.
- A PR that introduces a newly flaky test does not contribute to history until it merges. This is
  correct behaviour, but it means the first post-merge run carries the signal, not the PR itself.
- Cache scoping rules on GitHub are subtle enough to need a documented manual test at M6.

### What would make us revisit this

Repeated eviction making `determinism` unreliable in practice, or a need to reason over history
older than the cache retains — for example, a long-term flakiness dashboard. Option C becomes
attractive at that point, and the guardrail trade-off would need explicit re-argument.
