// Where the backend lives. Set in .env.local (see .env.example); the defaults are the local dev stack.
export const CONVEX_URL: string = import.meta.env.VITE_CONVEX_URL ?? 'http://127.0.0.1:3210'
