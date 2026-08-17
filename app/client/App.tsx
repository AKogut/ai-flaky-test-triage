import { useState } from 'react'
import type { Task } from './api.js'
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
 */

export function App(): React.JSX.Element {
  const tasks = useTasks()

  return (
    <main className="app">
      <header className="app-header">
        <h1>TaskFlow</h1>
        <button type="button" onClick={() => void tasks.reload()}>
          Refresh
        </button>
      </header>

      <CreateForm onCreate={tasks.create} />

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
        (tasks.tasks.length === 0 ? (
          <p className="state" data-testid="empty-state">
            Nothing to do. Add a task to get started.
          </p>
        ) : (
          <TaskList tasks={tasks} />
        ))}
    </main>
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

function TaskList({ tasks }: { tasks: Tasks }): React.JSX.Element {
  return (
    <ul className="task-list" data-testid="task-list">
      {tasks.tasks.map((task) => (
        <TaskRow key={task.id} task={task} tasks={tasks} />
      ))}
    </ul>
  )
}

function TaskRow({ task, tasks }: { task: Task; tasks: Tasks }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)

  return (
    <li className={`task task-${task.status}`} data-testid="task-item" data-task-id={task.id}>
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
