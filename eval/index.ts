/**
 * @sentra/eval
 *
 * Golden-dataset evaluation: the baseline heuristic, the metrics, and the harness that scores a classifier against ground truth.
 *
 * `run-eval.ts` is a CLI rather than a library entry point and is deliberately
 * not re-exported: it reads and writes committed files as a side effect of being
 * imported for its `main`, which is not something a consumer should get by
 * asking for the classifier seam.
 */

export * from './dataset.js'
export * from './baseline.js'
export * from './metrics.js'
export * from './confusion.js'
export * from './classifier.js'
export * from './consistency.js'
export * from './calibration.js'
