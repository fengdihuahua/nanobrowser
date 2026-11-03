---
name: fill-signup
description: Fill the signup form on the Fill a form fixture page.
whenToUse: When you need to fill the signup fixture form with a name, email, country and note, without submitting.
---

# fill-signup

Fill the signup form on the Fill a form fixture page.

Origin: http://127.0.0.1:8787

Params:

- `name` (string, required)
- `email` (string, required)
- `country` (string, required)
- `notes` (string, required)

Steps:

1. navigate http://127.0.0.1:8787/d-fill.html
2. set textbox «Full name» = «{{name}}»
3. set textbox «Email» = «{{email}}»
4. set combobox «Country» = «{{country}}»
5. set textbox «Notes» = «{{notes}}»
6. set checkbox «I agree» = true

Safety:

- A write step (submit, send, delete, upload) still asks the user for approval in the side panel.
- This skill only runs on http://127.0.0.1:8787.
- Values are recorded literally. A secret is never stored; leave that step to the user.
- A failed step stops the replay; do not retry a write blindly.

Run with `browser_skill_run({ name: "fill-signup", params: { ... } })`.
