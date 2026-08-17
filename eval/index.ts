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
export { LEAK_TERMS } from './hygiene.js'

/**
 * Only the sampling default.
 *
 * `run-eval.ts` is a CLI, not a library entry point, and re-exporting it
 * wholesale would hand a consumer a module that reads and writes committed files
 * on import. The cassette staleness check needs this one constant and nothing
 * else: a check expecting one sample while the harness asks for five would
 * report four imaginary gaps on every run.
 */
export { DEFAULT_SAMPLES } from './run-eval.js'
