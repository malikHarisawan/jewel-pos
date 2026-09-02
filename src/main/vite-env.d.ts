/// <reference types="vite/client" />

// SQL migrations are imported as raw strings (Vite `?raw`) so they inline into
// the bundle rather than being read from disk at runtime.
declare module '*.sql?raw' {
  const content: string;
  export default content;
}
