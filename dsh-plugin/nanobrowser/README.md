# Nanobrowser for DSH

A local DSH plugin that turns the user's real Chrome into the browser for a DSH session, and turns a successful
browser task into a reusable **Browser Skill**.

## What works today

- A browser **Hub** owns the extension connection on `127.0.0.1:8790` (same protocol as the old MCP bridge).
- The plugin registers `nanobrowser_*` tools for `snapshot`, `read`, `find`, `screenshot`, `navigate`, `click`, `set`,
  `type`, `press`, `hover`, `scroll`, `wait`, `tabs`, `handle_dialog`, `console`, `network`, `say`,
  `reload-extension`, plus `nanobrowser_status`, `nanobrowser_attach`, `nanobrowser_detach`,
  `nanobrowser_audit` and `nanobrowser_wait_for_user`.
- A tab lease belongs to one session at a time. `nanobrowser_attach` takes the active tab; a second session is refused
  until it detaches.
- A page tool (`snapshot`, `click`, `read`, `navigate`, ...) is refused until its session owns a tab; `tabs`, `status`,
  `attach`, `detach`, `say` and `audit` stay available. `browser_skill_run` refuses to start without a lease.
- `nanobrowser_audit` lists the session's recent browser calls with their outcome and time.
- `nanobrowser_wait_for_user` pauses for a login, 2FA or captcha; the drawer shows the instruction and a Continue
  button, the page stays interactive, and the tool returns when the user continues. The password never reaches the
  model.
- The system prompt tells the model whether the session has a lease and that page content is data, not instructions.
- Browser Skills: `browser_skill_save`, `browser_skill_list`, `browser_skill_show`, `browser_skill_run`.
  - capture from the latest turn's real `tool/call` / `tool/result` events;
  - refs become role + name targets;
  - successful waits become checks;
  - parameters via `params: { name: literal }` in `browser_skill_save`;
  - origin lock, dry run, per-step progress through `say`, stop on the first failed step or check;
  - stored in `~/.dsh/skills/browser/<name>/SKILL.md` + `recipe.json` (the user's, so every workspace sees them); the
    ones shipped beside the plugin are read from `<repo>/skills/browser`;
  - registered through `ctx.skills.registerProvider`, so DSH lists them in its skill catalog.
- `screenshot` becomes durable image content when the active model accepts images.
- A thin MCP adapter (`mcp/adapter.mjs`) speaks the same Hub, so Qoder / Claude Code / Cursor can use the same
  browser tools. It starts its own Hub only when none is running.
- A side-panel chat channel on the same Hub: session list, history, followup/steer, stop and page context.
- In the bridge build, the side panel header has a **DSH** button that opens a drawer with the live session list,
  history, a composer, Stop and an "Include current page" toggle. It is the same live Session the DSH window shows;
  it does not create a second conversation.
- The `@local/nanobrowser-ui` bundle adds a **Nanobrowser** entry to the DSH left sidebar. Its page shows the hub
  connection, live sessions and tab leases, saved browser skills, and recent browser calls.
- While the DSH drawer is open, DSH tool approvals (`approval/request`) are offered there as **Allow once / Deny /
  Ask in DSH**. Browser write cards remain in the Chrome side panel.

## DSH left sidebar

The `nanobrowser-ui` bundle is the client half. It registers `sidebar.panellist` + `main` with the id `nanobrowser`,
and polls one same-origin, authenticated summary at `/nanobrowser/summary` (served by the Host bundle). The page is
read-only: chat and approvals stay in the Chrome side panel.

The Host and client halves are separate packages on purpose: DSH caches package metadata until a restart, while a new
package name is scanned into the client graph immediately. Installing `nanobrowser-ui` therefore shows the sidebar
entry without restarting DSH.

## Approvals

When the DSH drawer is open, the Host offers a tool approval to it before the DSH Web UI. The drawer's card answers
`allowed-once`, `rejected`, or delegates with **Ask in DSH**; an ignored card delegates after the configured timeout
(`approvalTimeoutMs`, two minutes). With no drawer connected the request goes straight to the normal DSH answerer.
The browser's own submit/send/delete/upload cards are owned by the extension and are unchanged.

## User steps

When the Agent needs the user to log in, finish 2FA or pass a captcha, it calls `nanobrowser_wait_for_user` with a
short instruction. The DSH drawer shows the instruction and a **Continue** button; the page stays interactive; the tool
returns when the user presses Continue. A request without a connected drawer fails instead of blocking, and a timeout
ends the wait.

## Using the drawer

1. Build the extension with `WXT_BRIDGE=1` (see below) and reload it.
2. Open the side panel; click **DSH**.
3. Pick a live session, type a message, and press Enter. While the Agent runs, Enter steers the same Session; Stop
   cancels it.
4. Tick "Include current page" to prepend the DSH session's active tab as a bounded `<page_context>` block.

## Build the panel

```powershell
$env:WXT_BRIDGE='1'
$env:WXT_BRIDGE_PORT='8790'
$env:WXT_BRIDGE_TOKEN='dev-token'
pnpm build
```

On Windows the build and tests need full access because SWC writes its native cache under `%LOCALAPPDATA%\swc`.

## Chat channel (host side)

The panel talks to the same Hub over a WebSocket:

```text
ws://127.0.0.1:8790/client/chat/ws?token=<token>&sessionId=<optional>
```

On connect the server sends `{ type: 'hello', sessions, sessionId, history }`. The panel sends JSON messages:

- `{ "type": "sessions" }` → `{ type: 'sessions', sessions }`
- `{ "type": "select", "sessionId": "..." }` → `{ type: 'history', sessionId, live, messages }`
- `{ "type": "send", "text": "...", "mode": "auto|followup|steer", "includePage": true }` → `{ type: 'sent', ... }`
- `{ "type": "stop" }` → `{ type: 'stopped', ... }`

The selected session defaults to the newest live session. `mode: auto` follows `busyEnter`: steer while the Agent is
running, followup while idle. `includePage` prepends a bounded `<page_context url title>` block fetched with the
browser tools. Committed session events arrive as `{ type: 'hub', event: { type: 'chat', sessionId, event } }`.

HTTP fallback: `GET /client/chat/sessions`, `GET /client/chat/history?sessionId=`, `POST /client/chat/send`,
`POST /client/chat/stop`.

## Install

```text
plugin_manager install_bundle D:\code\nanobrowser\dsh-plugin\nanobrowser enabled:true
plugin_manager install_bundle D:\code\nanobrowser\dsh-plugin\nanobrowser-ui enabled:true
```

The Host bundle patch inserts `nanobrowser` with `port: 8790`, `token: dev-token`, `skillsDir:
D:/code/nanobrowser/skills/browser`. The UI bundle patch inserts `nanobrowser-ui` (client half only). The old
`mcp-nanobrowser` row must stay disabled while the plugin owns 8790
(`plugin_manager set_plugin include:mcp-nanobrowser enabled:false`).

## Reload after editing this package

A linked plain-JS bundle does not hot-reload its modules. Toggle the bundle off and on:

```text
plugin_manager set_bundle @local/nanobrowser enabled:false
plugin_manager set_bundle @local/nanobrowser enabled:true
```

The extension reconnects within a couple of seconds. A reload drops leases; call `nanobrowser_attach` again.

## Skills

Example flow:

1. Do the task once with the browser tools.
2. Save it:

```json
{ "name": "fill-signup", "description": "Fill the signup form.",
  "last": 6, "params": { "name": "Ada Lovelace", "email": "ada@example.test" } }
```

3. The skill is written to `~/.dsh/skills/browser/fill-signup/` and appears in the DSH skill catalog.
4. Run it:

```json
{ "name": "fill-signup",
  "params": { "name": "Grace Hopper", "email": "grace@example.test" } }
```

`dryRun: true` resolves targets without clicking, typing or navigating. `turn` selects an older turn; `last` keeps only
the last N actions from it; `overwrite: true` replaces a skill and bumps its version.

## MCP adapter

Configure an MCP client with:

```json
{
  "command": "node",
  "args": ["D:/code/nanobrowser/dsh-plugin/nanobrowser/mcp/adapter.mjs"],
  "env": {
    "NANOBROWSER_BRIDGE_PORT": "8790",
    "NANOBROWSER_BRIDGE_TOKEN": "dev-token"
  }
}
```

If the DSH plugin is running, the adapter connects to its Hub. If not, the adapter starts an embedded Hub. Start DSH
first when both are used, so the plugin owns the Hub.

## Not yet

- Side-panel UI for skills; approvals are in the drawer and the sidebar page is read-only.
- Selection capture.
- Extension protocol v2 (`clientId`, per-client session/tab, events) and true multi-client tab isolation.
- Audit timeline and version history UI; `nanobrowser_audit` and the sidebar's recent calls are the first version.

See `../../docs/design.md` for why it is built this way, `../../docs/reference.md` for the current behaviour, and `../../docs/roadmap.md` for what is left.

## Tests

```text
node dsh-plugin/nanobrowser/test/hub.test.mjs
node dsh-plugin/nanobrowser/test/chat.test.mjs
node dsh-plugin/nanobrowser/test/approval.test.mjs
node dsh-plugin/nanobrowser/test/lease-guard.test.mjs
node dsh-plugin/nanobrowser/test/user-step.test.mjs
```

Run the files directly: `node --test` spawns a child process, which the local sandbox blocks.

## Moving to another computer

The code and the skill library are in the repository; the machine state is not.

1. Commit and push `dsh-plugin/`, `skills/`, `docs/` and the `src/` changes. `skills/browser/` is the user's skill
   library, so it travels with the repository.
2. On the new machine: clone, `pnpm install`, build the bridge extension (see above), load `dist/` unpacked in Chrome,
   and log into the sites. The bridge uses the local Chrome profile; cookies and logins do not move with the code.
3. In the new DSH profile, install both local bundles and disable the old MCP row (see Install).
4. The plugin uses `<workspace>/skills/browser` by default; no absolute path has to be edited.
5. DSH session history lives under `%USERPROFILE%\.dsh\sessions`; copy it only if old conversations are needed.

## Security

- Hub binds `127.0.0.1` only; every request carries the token.
- The extension itself classifies submit/send/delete/upload and asks in the side panel; a payment, access grant, secret
  field or page prompt is the user's own step.
- A skill is limited to its recorded origin. Recipe steps can only call layer tools; there is no arbitrary JavaScript.
- Secret values are never stored. A recipe containing `{{secret:...}}` refuses to run until that step is handled by the
  user.
