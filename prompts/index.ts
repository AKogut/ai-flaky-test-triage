/**
 * @sentra/prompts
 *
 * The versioned prompt files, the rubric they share with `docs/taxonomy.md`, and
 * the two checks that keep both facts true: the doc copy is generated, and a
 * version whose numbers are published cannot be edited in place.
 */

export * from './registry.js'

// Both CLIs export `main`; naming them here keeps the package surface unambiguous.

export {
  BEGIN_MARKER,
  END_MARKER,
  SyncError,
  TAXONOMY_DOC,
  syncedDoc,
  main as syncMain,
  type SyncDeps,
} from './sync.js'

export {
  METRICS_FILES,
  frozenViolations,
  gitDeps,
  publishedVersions,
  renderViolations,
  main as freezeMain,
  type FreezeDeps,
  type Violation,
} from './freeze.js'
