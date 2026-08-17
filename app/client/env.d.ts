/// <reference types="vite/client" />

/**
 * Vite's ambient types, plus the one variable this client reads.
 *
 * Declared rather than inferred so a typo in the name is a compile error. An
 * undefined `VITE_API_URL` is a valid state — the dev proxy serves `/api`
 * same-origin — which is why it is optional rather than required.
 */
interface ImportMetaEnv {
  readonly VITE_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
