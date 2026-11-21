# Project site

The page at trioditis.app: plain HTML and CSS, with no build and no dependencies, so it can be
served from anywhere.

To look at it locally:

```sh
python3 -m http.server --directory apps/site
```

It deploys as its own Vercel project, `trioditis-site` in `notakerbals-projects`, with **Root
Directory** set to `apps/site`; `vercel.json`
here holds its headers, and skips a deploy only when git shows nothing in this folder changed
since the last one. It isn't part of
the web app's deployment (the root `vercel.json`).

The screenshots in `screenshots/` are of the real app running `pnpm dev --demo`, at 2x, in light
and dark. Retake both when the app's look changes. The font is DM Sans (`fonts/OFL.txt`), the
same file the app uses.
