---
name: dev-harness
description: Open a page on the local dev server and wait until the app has rendered.
whenToUse: When you are testing a project on localhost: open the page, confirm it rendered, then read console and network before clicking through.
---

# dev-harness

Open the page you are working on and wait until it has actually rendered, so everything read after this is about a
fresh page rather than whatever the tab held before.

Origin: http://localhost:5173 — Vite's default. Copy this skill and change `origin` for another port; the runner only
runs it on its own origin.

Parameters:

- `url` — the page to open, on the same origin.
- `readyText` — text that only appears once the app rendered (a heading, the empty-state line).

Steps:

1. navigate `{{url}}`
2. wait for `{{readyText}}`

## After it loads

- `browser_console` — errors, warnings and uncaught exceptions. It only keeps what the page printed after the tab was
  attached, so reload (step 1 asks for a URL) before trusting an empty log.
- `browser_network` — failed requests, 4xx/5xx, and the slow ones.
- `browser_screenshot` — what it looks like; layout and rendering bugs are usually visible, not textual.
- `browser_snapshot`, then `click` / `type` / `press` — the reproduction path. Read each receipt: was the input
  dispatched, did the page react, did the expected state arrive. The step where those three disagree is the bug.
- `browser_wait` for async work; `browser_handle_dialog` for alert, confirm and beforeunload.

## Turning a reproduction into a regression check

Once you know the path, ask for it to be saved as a skill (or use `browser_skill_save`), then replay that skill after
each change. The replay stops at the first failed step or assertion, which is faster and steadier than re-describing the
path to the model.

Safety:

- A write step (submit, send, delete, upload) still asks the user for approval in the side panel.
- This skill only runs on http://localhost:5173.
- Values are recorded literally. A secret is never stored; leave that step to the user.
- A failed step stops the replay; do not retry a write blindly.
