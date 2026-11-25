# Project site

The page at trioditis.app: plain HTML and CSS, with no build and no dependencies, so it can be
served from anywhere.

To look at it locally:

```sh
python3 -m http.server --directory apps/site
```

It deploys as its own Vercel project, `trioditis-site` in `notakerbals-projects`, with **Root
Directory** set to `apps/site` and production branch `dev`. `vercel.json` here holds its headers,
deploys only `dev` from Git, and skips a commit only when git shows nothing in this folder changed
since the last deploy (`scripts/vercel-ignore.mjs site`). See
[The websites](../docs/src/content/docs/contributing/workflow.md#the-websites). It isn't part of the
web app's deployment (the root `vercel.json`).

The download page (`download/`, served at `/download`) links to the latest release's installers by
file name; `download.js` puts a button for the visitor's own system at the top.

The screenshots in `screenshots/` are of the real app running `pnpm dev --demo`, at 2x, in light
and dark. Retake both when the app's look changes. The font is DM Sans (`fonts/OFL.txt`), the
same file the app uses.
