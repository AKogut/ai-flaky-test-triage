import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.css'

/**
 * The browser entry point, and nothing else.
 *
 * StrictMode is on. It double-invokes effects in development, which surfaces
 * the effects that are not idempotent — precisely the class of bug that becomes
 * an intermittent test later, and the class this application is meant to
 * contain honestly rather than accidentally.
 */
const root = document.getElementById('root')
if (root === null) throw new Error('index.html has no #root to mount into')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
