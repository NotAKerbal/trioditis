# Agent guide

Read `docs/PLAN.md` for what Trioditis is, `docs/CONTRIBUTING.md` for branches,
worktrees and checks, and `docs/architecture/` for the contracts between components.

- Work in your own worktree under `.worktrees/`, on a branch from `dev`. Never commit to
  `main` or `dev` directly.
- Stored message content is always sealed (`docs/architecture/sealing.md`). Never write
  plaintext message content, chat names or contact names to Convex, a database, a log
  or disk. The one exception, by the owner's choice: notifications show the sender and the
  message, and the system may keep them in its notification history.
- Sends are never retried automatically after an ambiguous outcome. Use the `unknown`
  delivery state.
- Keep the TypeScript and Go sides of a contract in step, in the same pull request.
- Every pull request adds a release note to `release-notes/`, labelled lines written for the
  people using the server (`docs/CONTRIBUTING.md`, Release notes).
- Run the checks in `docs/CONTRIBUTING.md` before opening a pull request, and report
  what you ran and what you didn't.
- Comments explain why, in plain sentences. Match the surrounding code.
