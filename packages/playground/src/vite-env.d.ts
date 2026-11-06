/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Local dev only: set to "true" to load the react-grab dev tool. */
  readonly VITE_REACT_GRAB?: string;
  /** Set to "true" at build time to disable hosted template and registry queries. */
  readonly VITE_MASTRA_STUDIO_OFFLINE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
