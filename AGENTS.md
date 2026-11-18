# Agent guide

Read `docs/PLAN.md` for what Trioditis is, `docs/CONTRIBUTING.md` for branches,
worktrees and checks, and `docs/architecture/` for the contracts between components.

- Work in your own worktree under `.worktrees/`, on a branch from `dev`. Never commit to
  `main` or `dev` directly.
- Stored message content is always sealed (`docs/architecture/sealing.md`). Never write
  plaintext message content, chat names or contact names to Convex, a database, a log
  or disk.
- Sends are never retried automatically after an ambiguous outcome. Use the `unknown`
  delivery state.
- Keep the TypeScript and Go sides of a contract in step, in the same pull request.
- Run the checks in `docs/CONTRIBUTING.md` before opening a pull request, and report
  what you ran and what you didn't.
- Comments explain why, in plain sentences. Match the surrounding code.
