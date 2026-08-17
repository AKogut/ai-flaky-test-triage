/**
 * @sentra/flakemetry
 *
 * Flakiness scoring and run history. Reads a normalised test run plus the stored history and emits a per-test signal.
 *
 * Two halves. `history.ts` carries the `determinism` axis from one ephemeral CI
 * job to the next; `analyze.ts` scores a run against it. The split is the seam
 * a pull-request job needs: it reads history and scores, and never writes.
 */

export * from './history.js'
export * from './analyze.js'
