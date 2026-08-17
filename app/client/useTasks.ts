import { useCallback, useEffect, useState } from 'react'
import * as api from './api.js'
import type { Task } from './api.js'

/**
 * All of TaskFlow's state, and the only place a write happens.
 *
 * One hook rather than state scattered through the components, for a reason
 * specific to this project: the optimistic completion path is the seed of the
 * race in #46, and a race spread across three components is one nobody can
 * analyse. Here it is four lines and they are the same four lines every time.
 *
 * ## What is optimistic and what is not
 *
 * **Completion is**, because that is the interaction a user repeats and the one
 * where a round trip is felt. It paints first, sends, and rolls back that task —
 * not the whole list — if the server disagrees.
 *
 * **Create, edit and delete are not.** They apply the server's answer, and they
 * do it by patching local state with the response rather than refetching. A
 * refetch after a mutation races every other mutation in flight, and the issue
 * is explicit that these flows are the control group for the non-flaky specs in
 * #51: contaminating them would make every number in the evaluation harder to
 * read. There is exactly one deliberate race in this application and it is not
 * here.
 *
 * Rolling back one field rather than restoring a snapshot of the list is the
 * same decision in miniature. A snapshot taken before the request and restored
 * after it would silently undo anything that happened in between — a create, a
 * rename — which is a data-loss bug wearing the costume of a rollback.
 */

export type Status = 'loading' | 'ready' | 'error'

export interface TasksState {
  status: Status
  tasks: Task[]
  /** Why the list could not be loaded. Null once it has been. */
  loadError: string | null
  /** Why the last write failed. Dismissible, and never blocks the list. */
  writeError: string | null
}

export interface Tasks extends TasksState {
  reload: () => Promise<void>
  create: (title: string, description?: string) => Promise<void>
  edit: (id: number, patch: { title?: string; description?: string }) => Promise<void>
  remove: (id: number) => Promise<void>
  toggle: (task: Task) => Promise<void>
  move: (id: number, index: number) => Promise<void>
  dismissWriteError: () => void
}

const message = (failure: unknown): string =>
  failure instanceof Error ? failure.message : 'something went wrong'

export function useTasks(): Tasks {
  const [state, setState] = useState<TasksState>({
    status: 'loading',
    tasks: [],
    loadError: null,
    writeError: null,
  })

  const reload = useCallback(async () => {
    setState((current) => ({ ...current, status: 'loading', loadError: null }))
    try {
      const tasks = await api.listTasks()
      setState((current) => ({ ...current, status: 'ready', tasks, loadError: null }))
    } catch (failure) {
      setState((current) => ({ ...current, status: 'error', loadError: message(failure) }))
    }
  }, [])

  useEffect(() => {
    // Floating on purpose: `useEffect` cannot take an async function, and every
    // rejection is already handled inside `reload`.
    void reload()
  }, [reload])

  /** Every non-optimistic write, so the error handling exists once. */
  const write = useCallback(
    async (apply: () => Promise<(tasks: Task[]) => Task[]>): Promise<void> => {
      setState((current) => ({ ...current, writeError: null }))
      try {
        const update = await apply()
        setState((current) => ({ ...current, tasks: update(current.tasks) }))
      } catch (failure) {
        setState((current) => ({ ...current, writeError: message(failure) }))
      }
    },
    [],
  )

  const create = useCallback(
    async (title: string, description = ''): Promise<void> => {
      await write(async () => {
        const created = await api.createTask(title, description)
        // Appended rather than re-sorted: the server puts a new task at the end,
        // and sorting again here would be a second implementation of an order
        // that already has one.
        return (tasks) => [...tasks, created]
      })
    },
    [write],
  )

  const edit = useCallback(
    async (id: number, patch: { title?: string; description?: string }): Promise<void> => {
      await write(async () => {
        const updated = await api.updateTask(id, patch)
        return (tasks) => tasks.map((task) => (task.id === id ? updated : task))
      })
    },
    [write],
  )

  const remove = useCallback(
    async (id: number): Promise<void> => {
      await write(async () => {
        await api.deleteTask(id)
        return (tasks) => tasks.filter((task) => task.id !== id)
      })
    },
    [write],
  )

  /**
   * The optimistic one, and the only one.
   *
   * Paint, send, and put *this task's* status back if the server disagrees. The
   * rollback names the field rather than restoring a remembered list, so a
   * create that landed while the request was in flight survives it.
   */
  const toggle = useCallback(async (task: Task): Promise<void> => {
    const next: Task['status'] = task.status === 'completed' ? 'active' : 'completed'
    const set = (status: Task['status']) => (tasks: Task[]) =>
      tasks.map((row) => (row.id === task.id ? { ...row, status } : row))

    setState((current) => ({ ...current, writeError: null, tasks: set(next)(current.tasks) }))

    try {
      const updated =
        next === 'completed'
          ? await api.completeTask(task.id)
          : await api.updateTask(task.id, { status: 'active' })
      setState((current) => ({
        ...current,
        tasks: current.tasks.map((row) => (row.id === task.id ? updated : row)),
      }))
    } catch (failure) {
      setState((current) => ({
        ...current,
        writeError: message(failure),
        tasks: set(task.status)(current.tasks),
      }))
    }
  }, [])

  /**
   * Optimistic reorder — and the deliberate bug this application exists to have.
   *
   * ## What it does
   *
   * Move the row locally, send the index, then replace the list with whatever
   * the server returns. The optimistic half is why a drag feels immediate; the
   * reconciliation is what makes the client agree with the server about an order
   * the server computes.
   *
   * ## The race, and the exact interleaving that triggers it
   *
   * Responses are applied in the order they **arrive**, and nothing checks that
   * an arriving response is the newest one. So:
   *
   * 1. Drag A. The list paints order `A'`, request R1 goes out.
   * 2. Drag B, before R1 has answered. The list paints order `B'`, request R2
   *    goes out.
   * 3. The server applies R1 then R2 and is now in the order the user intended.
   * 4. **R1's response arrives after R2's.** The last `setState` wins, so the
   *    list is replaced with the server's order *as of R1* — the second drag is
   *    visibly undone, and a refresh brings it back, because the server had it
   *    all along.
   *
   * ## Why it is still here
   *
   * On purpose, and this comment is the documentation the issue asks for. It is
   * `app_code` + `intermittent` — the hard quadrant — and it is the failure the
   * whole project is built to classify. A correctly written test catches it some
   * of the time and passes the rest, which is precisely the shape a rerun-until-
   * green culture ships to users.
   *
   * It is not reproducible on a normal machine: the two responses come back in
   * microseconds and in order. `SENTRA_CHAOS=<seed>` (#47) delays the first more
   * than the second and makes the interleaving happen every time, which is what
   * separates emergent flakiness from a scripted sleep.
   *
   * **Do not fix this without deleting the fixtures that depend on it.** The
   * one-line fix is a request sequence number, ignoring any response older than
   * the newest sent.
   */
  const move = useCallback(
    async (id: number, index: number): Promise<void> => {
      setState((current) => ({
        ...current,
        writeError: null,
        tasks: reposition(current.tasks, id, index),
      }))

      try {
        const tasks = await api.reorderTask(id, index)
        setState((current) => ({ ...current, tasks }))
      } catch (failure) {
        // A failed reorder does re-read, because unlike the other writes there is
        // no single field to put back: the optimistic move already renumbered the
        // list, and guessing at the previous order would invent one.
        setState((current) => ({ ...current, writeError: message(failure) }))
        await reload()
      }
    },
    [reload],
  )

  const dismissWriteError = useCallback(() => {
    setState((current) => ({ ...current, writeError: null }))
  }, [])

  return { ...state, reload, create, edit, remove, toggle, move, dismissWriteError }
}

/** Local preview of the move the server is about to make. Same rule: index in the result. */
export function reposition(tasks: readonly Task[], id: number, index: number): Task[] {
  const moved = tasks.find((task) => task.id === id)
  if (moved === undefined) return [...tasks]

  const others = tasks.filter((task) => task.id !== id)
  const at = Math.min(Math.max(Math.trunc(index), 0), others.length)
  return [...others.slice(0, at), moved, ...others.slice(at)]
}
