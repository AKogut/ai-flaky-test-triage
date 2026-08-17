/**
 * @sentra/flakemetry
 *
 * Flakiness scoring and run history. Reads a normalised test run plus the stored history and emits a per-test signal.
 *
 * The scoring half lands in #58; what is here is the history the scoring reads —
 * the file that carries the `determinism` axis from one ephemeral CI job to the
 * next.
 */

export * from './history.js'
