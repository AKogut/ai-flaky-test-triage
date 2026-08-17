import { useState } from 'react'
import type { Task } from './api.js'
import { FILTERS, useFilter, visible, type Filter } from './useFilter.js'
import { useTasks, type Tasks } from './useTasks.js'

/**
 * TaskFlow's UI. `fetch`, `useState`, and CSS.
 *
 * No component library, no state-management library, no design system. The
 * application exists to produce flakiness that is *explicable*, and every
 * dependency is one more thing somebody has to rule out when a test starts
 * failing intermittently.
 *
 * All state and every write live in `useTasks`; these components render it. That
 * split is not architecture for its own sake — the optimistic completion path is
 * the seed of the race in #46, and a race spread across three components is one
 * nobody can analyse.
 *
 * ## Which elements get a `data-testid`, and why
 *
 * This is a decision rather than an oversight, and it is worth writing down
 * because the golden dataset contains failures that only exist if it is made
 * this way.
 *
 * **Structural containers get one.** `task-list`, `task-item`, `empty-state`,
 * `error-state`, `loading-state`, `create-form`, `write-error`. These are the
 * things a spec needs to find in order to say anything at all, and a spec that
 * finds its subject by walking the DOM breaks on every layout change for no
 * useful reason. A test id here is a contract: renaming one is a deliberate act,
 * and `locator-still-uses-retired-test-id` in the golden dataset is exactly the
 * failure of breaking that contract quietly.
 *
 * **Interactive controls deliberately do not.** Buttons and inputs are found by
 * their accessible role and name — which is how a user finds them, and which is
 * genuinely fragile: rewording a label moves the selector.
 * `button-lookup-uses-superseded-label` is that failure, and #53 needs a
 * realistically fragile selector to exist rather than a contrived one. Giving
 * every button an id would make the application easier to test and would delete
 * the thing this repository is about.
 *
 * **Text content never gets one.** A title is data; asserting on it is
 * asserting on the fixture, and that is the point.
 *
 * ## The list can legitimately show duplicate text, and that is deliberate
 *
 * Every row renders the same status label — "To do" or "Done" — so how many
 * elements a text locator matches depends on the filter. Under `?filter=all` the
 * seed shows three "To do" and two "Done"; under `?filter=completed` it shows two
 * "Done" and no "To do" at all. The seed also contains two tasks whose titles
 * begin "Review the", so a locator built from a partial title matches two rows
 * under one filter and one under another.
 *
 * A Playwright locator that resolves to more than one element fails in strict
 * mode. So a spec written against one filter, run under another, fails for
 * reasons that have nothing to do with timing — which is exactly the flakiness a
 * timing-focused classifier misreads, and exactly what #53 needs to exist.
 */

export function App(): React.JSX.Element {
  const tasks = useTasks()
  const { filter, setFilter } = useFilter()
  const shown = visible(tasks.tasks, filter)

  return (
    <main className="app">
      <header className="app-header">
        <h1>TaskFlow</h1>
        <button type="button" onClick={() => void tasks.reload()}>
          Refresh
        </button>
      </header>

      <CreateForm onCreate={tasks.create} />
      <FilterBar filter={filter} onChange={setFilter} />

      {tasks.writeError !== null && (
        <div className="banner banner-error" data-testid="write-error" role="alert">
          <p>{tasks.writeError}</p>
          <button type="button" onClick={tasks.dismissWriteError}>
            Dismiss
          </button>
        </div>
      )}

      {tasks.status === 'loading' && (
        <p className="state" data-testid="loading-state" role="status">
          Loading tasks…
        </p>
      )}

      {tasks.status === 'error' && (
        <div className="state state-error" data-testid="error-state" role="alert">
          <p>{tasks.loadError}</p>
          <button type="button" onClick={() => void tasks.reload()}>
            Try again
          </button>
        </div>
      )}

      {tasks.status === 'ready' &&
        (shown.length === 0 ? (
          <p className="state" data-testid="empty-state">
            {EMPTY[filter]}
          </p>
        ) : (
          <TaskList tasks={tasks} shown={shown} />
        ))}
    </main>
  )
}

/**
 * Different words per filter, because "nothing here" and "nothing matches" are
 * different facts. A single message would leave a reader unable to tell an empty
 * database from a filter they forgot they set.
 */
const EMPTY: Record<Filter, string> = {
  all: 'Nothing to do. Add a task to get started.',
  active: 'No active tasks. Everything here is done.',
  completed: 'Nothing completed yet.',
}

const LABEL: Record<Filter, string> = {
  all: 'All',
  active: 'Active',
  completed: 'Completed',
}

/**
 * `aria-pressed` rather than a hidden radio group.
 *
 * It gives a spec `getByRole('button', { name: 'Active', pressed: true })`, which
 * says what a user would say, and it keeps the control inside the policy: found
 * by role and name, with no test id.
 */
function FilterBar({
  filter,
  onChange,
}: {
  filter: Filter
  onChange: (next: Filter) => void
}): React.JSX.Element {
  return (
    <div className="filter-bar" role="group" aria-label="Filter tasks">
      {FILTERS.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={filter === option}
          onClick={() => onChange(option)}
        >
          {LABEL[option]}
        </button>
      ))}
    </div>
  )
}

function CreateForm({ onCreate }: { onCreate: Tasks['create'] }): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (title.trim() === '') return

    // `busy` disables the submit button while the request is in flight, and that
    // is the whole of the guard: HTML blocks implicit submission — Enter in the
    // field — when the default button is disabled, so both paths are covered by
    // one flag. An early return on `busy` here looked like a second layer and was
    // unreachable; a guard that guards nothing is worse than none, because it
    // reads as protection.
    //
    // It earns its place either way: a form that submits twice is a data bug
    // that presents as a flaky test counting rows, and these flows are the
    // control group for #51.
    setBusy(true)
    await onCreate(title.trim())
    setBusy(false)
    setTitle('')
  }

  return (
    <form className="create-form" data-testid="create-form" onSubmit={(e) => void submit(e)}>
      <label className="visually-hidden" htmlFor="new-task-title">
        New task
      </label>
      <input
        id="new-task-title"
        value={title}
        placeholder="What needs doing?"
        onChange={(event) => setTitle(event.target.value)}
      />
      <button type="submit" disabled={busy || title.trim() === ''}>
        Add task
      </button>
    </form>
  )
}

/**
 * Native HTML drag events, no library.
 *
 * Fewer moving parts, and the Playwright interaction is explicit rather than
 * mediated by a library's event synthesis. The dragged id lives in component
 * state rather than in `dataTransfer`: the payload is only needed for drags
 * between windows, and reading it back is unreliable in both jsdom and
 * Playwright's synthesised events.
 *
 * The drop index is the position in the **filtered** list mapped back to the
 * full one. Dropping onto row three of a filtered view means "after the two rows
 * above it", not "at index 3 of everything" — the latter would move a task
 * somewhere the user cannot see, which is a bug that only appears when a filter
 * is set and is therefore very hard to notice.
 */
function TaskList({ tasks, shown }: { tasks: Tasks; shown: readonly Task[] }): React.JSX.Element {
  const [dragging, setDragging] = useState<number | null>(null)

  const drop = (target: Task): void => {
    if (dragging === null || dragging === target.id) return
    void tasks.move(dragging, indexOf(tasks.tasks, target))
    setDragging(null)
  }

  return (
    <ul className="task-list" data-testid="task-list">
      {shown.map((task, position) => (
        <TaskRow
          key={task.id}
          task={task}
          tasks={tasks}
          neighbours={{ above: shown[position - 1], below: shown[position + 1] }}
          onDragStart={() => setDragging(task.id)}
          onDrop={() => drop(task)}
        />
      ))}
    </ul>
  )
}

/**
 * Where a drop onto `target` lands, as an index in the unfiltered list.
 *
 * `move` reads its index against the list with the dragged task removed, which
 * gives drag-up and drag-down the asymmetry a person expects for free: dragging
 * *down* onto a row lands after it, because removing the dragged task shifts the
 * target up one; dragging *up* lands before it, because it does not.
 */
const indexOf = (all: readonly Task[], target: Task): number =>
  Math.max(
    0,
    all.findIndex((task) => task.id === target.id),
  )

function TaskRow({
  task,
  tasks,
  neighbours,
  onDragStart,
  onDrop,
}: {
  task: Task
  tasks: Tasks
  neighbours: { above?: Task | undefined; below?: Task | undefined }
  onDragStart: () => void
  onDrop: () => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)

  /**
   * Swap with a neighbour, by index in the full list.
   *
   * The keyboard path exists because it must — a control reachable only by drag
   * is unusable without a pointer — and because HTML drag-and-drop is
   * notoriously hard to drive from Playwright. The specs in #51 and #53 use
   * these buttons; the drag is what a person uses.
   */
  const swapWith = (other: Task | undefined): void => {
    if (other === undefined) return
    void tasks.move(
      task.id,
      tasks.tasks.findIndex((row) => row.id === other.id),
    )
  }

  return (
    <li
      className={`task task-${task.status}`}
      data-testid="task-item"
      data-task-id={task.id}
      draggable
      onDragStart={onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        onDrop()
      }}
    >
      <span className="task-status" data-testid="task-status">
        {task.status === 'completed' ? 'Done' : 'To do'}
      </span>

      {editing ? (
        <EditForm
          task={task}
          onCancel={() => setEditing(false)}
          onSave={async (patch) => {
            await tasks.edit(task.id, patch)
            setEditing(false)
          }}
        />
      ) : (
        <div className="task-text">
          <p className="task-title">{task.title}</p>
          {task.description !== '' && <p className="task-description">{task.description}</p>}
        </div>
      )}

      <div className="task-actions">
        <button
          type="button"
          disabled={neighbours.above === undefined}
          onClick={() => swapWith(neighbours.above)}
        >
          Move up
        </button>
        <button
          type="button"
          disabled={neighbours.below === undefined}
          onClick={() => swapWith(neighbours.below)}
        >
          Move down
        </button>

        <button type="button" onClick={() => void tasks.toggle(task)}>
          {task.status === 'completed' ? 'Reopen' : 'Complete'}
        </button>

        {!editing && (
          <button type="button" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}

        {/*
          Two steps, in the page, rather than `window.confirm`. A native dialog
          blocks the event loop and has to be intercepted by name in Playwright,
          which is a genuine source of intermittent failures — and this
          application's intermittency is meant to come from one deliberate place.
        */}
        {confirming ? (
          <span className="confirm" data-testid="delete-confirm">
            <button type="button" onClick={() => void tasks.remove(task.id)}>
              Confirm delete
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" onClick={() => setConfirming(true)}>
            Delete
          </button>
        )}
      </div>
    </li>
  )
}

function EditForm({
  task,
  onSave,
  onCancel,
}: {
  task: Task
  onSave: (patch: { title: string; description: string }) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)

  return (
    <form
      className="task-text edit-form"
      data-testid="edit-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (title.trim() !== '') void onSave({ title: title.trim(), description })
      }}
    >
      <label className="visually-hidden" htmlFor={`title-${String(task.id)}`}>
        Title
      </label>
      <input
        id={`title-${String(task.id)}`}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />

      <label className="visually-hidden" htmlFor={`description-${String(task.id)}`}>
        Description
      </label>
      <input
        id={`description-${String(task.id)}`}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />

      <span className="edit-actions">
        <button type="submit" disabled={title.trim() === ''}>
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </form>
  )
}
