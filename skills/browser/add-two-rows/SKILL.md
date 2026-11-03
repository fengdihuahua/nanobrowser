---
name: add-two-rows
description: Add two rows on the Effects fixture page and wait for Row 2.
whenToUse: When you need a small visible browser replay on the Effects fixture page.
---

# add-two-rows

Add two rows on the Effects fixture page and wait for Row 2.

Origin: http://127.0.0.1:8787

Steps:

1. navigate http://127.0.0.1:8787/c-effects.html
2. click button «Add a row»
3. click button «Add a row»
4. wait for «Row 2»

Checks:

- after step `s4`: text «Row 2»

Safety:

- A write step (submit, send, delete, upload) still asks the user for approval in the side panel.
- This skill only runs on http://127.0.0.1:8787.
- Values are recorded literally. A secret is never stored; leave that step to the user.
- A failed step stops the replay; do not retry a write blindly.

Run with `browser_skill_run({ name: "add-two-rows", params: { ... } })`.
