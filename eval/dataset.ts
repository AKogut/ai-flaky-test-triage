import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  fixtureHash,
  pairFixtureFiles,
  parseFixtureLabels,
  parseFixturePayload,
  type FixtureLabels,
  type FixturePayload,
  LABELS_SUFFIX,
  PAYLOAD_SUFFIX,
} from '@sentra/contracts'

/**
 * Reading the golden dataset off disk.
 *
 * The filesystem half of the format defined in `contracts/fixture.ts`, kept
 * separate so the format itself stays pure and testable without a directory.
 *
 * Payloads and labels are loaded by **separate functions returning separate
 * types**, on purpose. Nothing in this module hands a caller both at once, so
 * feeding ground truth to a classifier requires deciding to do it rather than
 * forgetting not to.
 */

export const DATASET_DIR = 'eval/golden-dataset'

export interface DatasetEntry {
  name: string
  payload: FixturePayload
  hash: string
}

function read(dir: string, file: string): unknown {
  return JSON.parse(readFileSync(join(dir, file), 'utf8'))
}

/**
 * Names of every complete fixture in the directory.
 *
 * Throws on either kind of orphan. A payload whose labels file was never written
 * would otherwise disappear from the dataset silently, and every published
 * metric would be computed over fewer fixtures than the report claims.
 */
export function listFixtures(dir: string = DATASET_DIR): string[] {
  const paired = pairFixtureFiles(readdirSync(dir))

  if (paired.missingLabels.length > 0 || paired.orphanedLabels.length > 0) {
    const problems = [
      ...paired.missingLabels.map((n) => `  ${n}${PAYLOAD_SUFFIX} has no ${LABELS_SUFFIX}`),
      ...paired.orphanedLabels.map((n) => `  ${n}${LABELS_SUFFIX} has no ${PAYLOAD_SUFFIX}`),
    ].join('\n')
    throw new Error(`Incomplete fixtures in ${dir}:\n${problems}`)
  }

  return paired.names
}

/** What a classifier sees. Contains nothing about the answer. */
export function loadPayload(name: string, dir: string = DATASET_DIR): DatasetEntry {
  const payload = parseFixturePayload(
    read(dir, `${name}${PAYLOAD_SUFFIX}`),
    `${name}${PAYLOAD_SUFFIX}`,
  )
  if (payload.name !== name) {
    throw new Error(`${name}${PAYLOAD_SUFFIX} declares name "${payload.name}"; the two must match`)
  }
  return { name, payload, hash: fixtureHash(payload) }
}

/** The answer. Never returned alongside a payload. */
export function loadLabels(name: string, dir: string = DATASET_DIR): FixtureLabels {
  const labels = parseFixtureLabels(read(dir, `${name}${LABELS_SUFFIX}`), `${name}${LABELS_SUFFIX}`)
  if (labels.name !== name) {
    throw new Error(`${name}${LABELS_SUFFIX} declares name "${labels.name}"; the two must match`)
  }
  return labels
}

export function loadAllPayloads(dir: string = DATASET_DIR): DatasetEntry[] {
  return listFixtures(dir).map((name) => loadPayload(name, dir))
}

export function loadAllLabels(dir: string = DATASET_DIR): FixtureLabels[] {
  return listFixtures(dir).map((name) => loadLabels(name, dir))
}
