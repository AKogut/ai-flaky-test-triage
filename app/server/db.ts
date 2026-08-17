import Database from 'better-sqlite3'

/**
 * TaskFlow's database. One file, one table, no migrations framework.
 *
 * TaskFlow is the system under test, not the product. It exists to produce
 * genuine async-UI flakiness for the pipeline to triage, and every hour spent
 * making it good software is an hour not spent on the part of the project that
 * carries the value. So: no auth, no pagination, no soft deletes, no service
 * layer, and a schema that fits on a screen.
 *
 * `better-sqlite3` rather than `node:sqlite`, which would have been one fewer
 * dependency. Node 22 — the floor this repository sets, and the version CI pins
 * — still prints an ExperimentalWarning for the built-in on every process start.
 * A warning on every test run is noise, and noise on stderr is how people learn
 * to stop reading stderr.
 */

export interface Task {
  id: number
  title: string
  description: string
  status: 'active' | 'completed'
  /**
   * Sort key, fractional on purpose.
   *
   * Reordering (#42) then means writing one row rather than renumbering the
   * list, and a client that drops an item between two neighbours can compute the
   * midpoint without asking. Ties are possible and are broken by `id` — which is
   * not a detail: `position-collision-orders-by-insertion-id` in the golden
   * dataset is a real failure this application is meant to be able to produce.
   */
  position: number
  createdAt: string
  updatedAt: string
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
    position    REAL    NOT NULL,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
  );
`

export type Db = Database.Database

/**
 * Open a database and make sure the schema is there.
 *
 * The path is a parameter with no default, so a test cannot reach the
 * development database by forgetting to set something. `:memory:` is the usual
 * argument in tests; the CLI passes a real file.
 */
export function open(path: string): Db {
  const db = new Database(path)

  // Without this SQLite runs with foreign keys off and, more importantly here,
  // with a rollback journal — WAL is what lets a read during a write return
  // rather than block, which is the behaviour the flaky specs need to exist.
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}

/** Every row, oldest position first. Ties break by insertion order — see `Task.position`. */
export function list(db: Db): Task[] {
  return rows(db.prepare('SELECT * FROM tasks ORDER BY position ASC, id ASC').all())
}

export function find(db: Db, id: number): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  return row === undefined ? null : toTask(row)
}

/**
 * `| undefined` on each optional field, not just `?`.
 *
 * `exactOptionalPropertyTypes` is on, so `{ description: undefined }` and
 * `{}` are different types — and a parsed request body produces the first.
 * Writing it out here is what lets a route hand its validated input straight in
 * rather than reassembling the object to satisfy the compiler.
 */
export interface NewTask {
  title: string
  description?: string | undefined
  /** Appended to the end when absent, which is what a list UI means by "add". */
  position?: number | undefined
}

export function create(db: Db, task: NewTask, now: string): Task {
  const position = task.position ?? nextPosition(db)
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO tasks (title, description, status, position, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?, ?)`,
    )
    .run(task.title, task.description ?? '', position, now, now)

  const created = find(db, Number(lastInsertRowid))
  if (created === null) throw new Error('the row that was just inserted is not there')
  return created
}

export interface TaskPatch {
  title?: string | undefined
  description?: string | undefined
  status?: Task['status'] | undefined
  position?: number | undefined
}

/** Null when the row does not exist, so the route can answer 404 without a second query. */
export function update(db: Db, id: number, patch: TaskPatch, now: string): Task | null {
  const existing = find(db, id)
  if (existing === null) return null

  db.prepare(
    `UPDATE tasks SET title = ?, description = ?, status = ?, position = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.title ?? existing.title,
    patch.description ?? existing.description,
    patch.status ?? existing.status,
    patch.position ?? existing.position,
    now,
    id,
  )
  return find(db, id)
}

/** True when a row was deleted. False means it was already gone, which is not an error twice. */
export function remove(db: Db, id: number): boolean {
  return db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0
}

export function clear(db: Db): void {
  db.exec('DELETE FROM tasks')
  // AUTOINCREMENT keeps its high-water mark in sqlite_sequence, so a seeded
  // database would otherwise hand out different ids on every reseed and no
  // fixture could name a row.
  db.exec("DELETE FROM sqlite_sequence WHERE name = 'tasks'")
}

const nextPosition = (db: Db): number => {
  const row = db.prepare('SELECT MAX(position) AS max FROM tasks').get()
  const max = (row as { max: number | null }).max
  return (max ?? 0) + 1
}

interface Row {
  id: number
  title: string
  description: string
  status: string
  position: number
  created_at: string
  updated_at: string
}

const rows = (values: unknown[]): Task[] => values.map(toTask)

const toTask = (value: unknown): Task => {
  const row = value as Row
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status === 'completed' ? 'completed' : 'active',
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
