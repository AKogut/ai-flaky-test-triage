import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { create, find, list, remove, update, type Db, type Task } from './db.js'

/**
 * The TaskFlow API. Five routes, no service layer, no abstraction to speak of.
 *
 * Routes talk to the database module directly, which for an application this
 * size is not a shortcut but the honest shape: a layer whose every method
 * forwards one call is a layer that makes the code longer and the behaviour no
 * clearer.
 *
 * Two things here are not throwaway, because the rest of the project depends on
 * them. Validation is by schema and rejects unknown keys, so a client typo is a
 * 400 rather than a silently ignored field — a test asserting on a field the
 * server never stored is a flaky test with a very boring cause. And every error
 * has the same shape, so the client has one thing to render and the E2E specs
 * have one thing to assert on.
 */

export interface AppDeps {
  db: Db
  /** Injected so a test can pin timestamps rather than assert around them. */
  now?: () => string
}

const TitleSchema = z.string().trim().min(1).max(200)

const CreateSchema = z
  .object({
    title: TitleSchema,
    description: z.string().max(2000).optional(),
    position: z.number().finite().optional(),
  })
  .strict()

/**
 * At least one field, because `PATCH {}` is almost always a bug at the caller.
 *
 * Accepting it would touch `updated_at` and return 200, and the client would
 * conclude the write worked.
 */
const PatchSchema = z
  .object({
    title: TitleSchema.optional(),
    description: z.string().max(2000).optional(),
    status: z.enum(['active', 'completed']).optional(),
    position: z.number().finite().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'a patch must change at least one field',
  })

export interface ApiError {
  error: { code: string; message: string; details?: unknown }
}

export function createApp(deps: AppDeps): Express {
  const { db } = deps
  const now = deps.now ?? (() => new Date().toISOString())

  const app = express()
  app.use(express.json({ limit: '64kb' }))

  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok' })
  })

  app.get('/api/tasks', (_request, response) => {
    response.json({ tasks: list(db) })
  })

  app.get('/api/tasks/:id', (request, response) => {
    const task = byId(db, request, response)
    if (task !== null) response.json({ task })
  })

  app.post('/api/tasks', (request, response) => {
    const parsed = CreateSchema.safeParse(request.body)
    if (!parsed.success) return invalid(response, parsed.error)

    response.status(201).json({ task: create(db, parsed.data, now()) })
  })

  app.patch('/api/tasks/:id', (request, response) => {
    const parsed = PatchSchema.safeParse(request.body)
    if (!parsed.success) return invalid(response, parsed.error)

    const id = identifier(request)
    const updated = id === null ? null : update(db, id, parsed.data, now())
    if (updated === null) return notFound(response)
    response.json({ task: updated })
  })

  /**
   * Its own route rather than `PATCH {status}`.
   *
   * The client's completion path is the one that races a title save, and giving
   * it a distinct endpoint is what lets the chaos layer in #47 delay exactly
   * that request without touching every other write.
   */
  app.patch('/api/tasks/:id/complete', (request, response) => {
    const id = identifier(request)
    const updated = id === null ? null : update(db, id, { status: 'completed' }, now())
    if (updated === null) return notFound(response)
    response.json({ task: updated })
  })

  app.delete('/api/tasks/:id', (request, response) => {
    const id = identifier(request)
    if (id === null || !remove(db, id)) return notFound(response)
    response.status(204).end()
  })

  app.use((_request, response) => {
    response.status(404).json(error('not_found', 'no such route'))
  })

  // Four parameters, because that is how Express recognises an error handler —
  // dropping the unused `next` turns this into ordinary middleware that never
  // runs, and every malformed body becomes an HTML stack trace.
  app.use((thrown: Error, _request: Request, response: Response, _next: NextFunction) => {
    const status = 'status' in thrown && typeof thrown.status === 'number' ? thrown.status : 500
    response
      .status(status === 400 ? 400 : 500)
      .json(
        status === 400
          ? error('invalid_json', 'the request body is not valid JSON')
          : error('internal', 'something went wrong'),
      )
  })

  return app
}

const identifier = (request: Request): number | null => {
  const id = Number(request.params.id)
  return Number.isInteger(id) && id > 0 ? id : null
}

function byId(db: Db, request: Request, response: Response): Task | null {
  const id = identifier(request)
  const task = id === null ? null : find(db, id)
  if (task === null) {
    notFound(response)
    return null
  }
  return task
}

const error = (code: string, message: string, details?: unknown): ApiError => ({
  error: { code, message, ...(details !== undefined && { details }) },
})

const notFound = (response: Response): void => {
  response.status(404).json(error('not_found', 'no task with that id'))
}

/**
 * The field paths, so a 400 says what to change rather than that something is wrong.
 *
 * An unrecognised key is reported per key rather than as one issue at the root,
 * which is where Zod puts it. `path: ""` with the offending name buried in a
 * sentence is the difference between a caller fixing a typo and a caller reading
 * the source.
 */
const invalid = (response: Response, failure: z.ZodError): void => {
  const details = failure.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => ({ path: key, message: 'unrecognised field' }))
      : [{ path: issue.path.join('.'), message: issue.message }],
  )
  response.status(400).json(error('invalid_request', 'the request body is not valid', details))
}
