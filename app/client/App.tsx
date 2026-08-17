import { useCallback, useEffect, useState } from 'react'
import { listTasks, type Task } from './api.js'

/**
 * TaskFlow's UI. `fetch`, `useState`, and CSS.
 *
 * No component library, no state-management library, no design system. The
 * application exists to produce flakiness that is *explicable*, and every
 * dependency is one more thing somebody has to rule out when a test starts
 * failing intermittently.
 *
 * ## Which elements get a `data-testid`, and why
 *
 * This is a decision rather than an oversight, and it is worth writing down
 * because the golden dataset contains failures that only exist if it is made
 * this way.
 *
 * **Structural containers get one.** `task-list`, `task-item`, `empty-state`,
 * `error-state`, `loading-state`. These are the things a spec needs to find in
 * order to say anything at all, and a spec that finds its subject by walking the
 * DOM breaks on every layout change for no useful reason. A test id here is a
 * contract: renaming one is a deliberate act, and
 * `locator-still-uses-retired-test-id` in the golden dataset is exactly the
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

type State =
  { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; tasks: Task[] }

export function App(): React.JSX.Element {
  const [state, setState] = useState<State>({ status: 'loading' })

  const load = useCallback(async () => {
    setState({ status: 'loading' })
    try {
      setState({ status: 'ready', tasks: await listTasks() })
    } catch (failure) {
      setState({
        status: 'error',
        message: failure instanceof Error ? failure.message : 'something went wrong',
      })
    }
  }, [])

  useEffect(() => {
    // Floating on purpose, and the only place in the repository where that is
    // true: `useEffect` cannot take an async function, and the promise's failure
    // is already handled inside `load`. Nothing is left unobserved.
    void load()
  }, [load])

  return (
    <main className="app">
      <header className="app-header">
        <h1>TaskFlow</h1>
        <button type="button" onClick={() => void load()}>
          Refresh
        </button>
      </header>

      {state.status === 'loading' && (
        <p className="state" data-testid="loading-state" role="status">
          Loading tasks…
        </p>
      )}

      {state.status === 'error' && (
        <div className="state state-error" data-testid="error-state" role="alert">
          <p>{state.message}</p>
          <button type="button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}

      {state.status === 'ready' &&
        (state.tasks.length === 0 ? (
          <p className="state" data-testid="empty-state">
            Nothing to do. Add a task to get started.
          </p>
        ) : (
          <TaskList tasks={state.tasks} />
        ))}
    </main>
  )
}

export function TaskList({ tasks }: { tasks: readonly Task[] }): React.JSX.Element {
  return (
    <ul className="task-list" data-testid="task-list">
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} />
      ))}
    </ul>
  )
}

export function TaskRow({ task }: { task: Task }): React.JSX.Element {
  return (
    <li className={`task task-${task.status}`} data-testid="task-item" data-task-id={task.id}>
      <span className="task-status" data-testid="task-status">
        {task.status === 'completed' ? 'Done' : 'To do'}
      </span>
      <div className="task-text">
        <p className="task-title">{task.title}</p>
        {task.description !== '' && <p className="task-description">{task.description}</p>}
      </div>
    </li>
  )
}
