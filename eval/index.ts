/**
 * @sentra/eval
 *
 * Golden-dataset evaluation: the baseline heuristic, the metrics, and the harness that scores a classifier against ground truth.
 *
 * The harness and report writer land later in M2; the pieces below are the ones
 * that exist.
 */

export * from './dataset.js'
export * from './baseline.js'
export * from './metrics.js'
