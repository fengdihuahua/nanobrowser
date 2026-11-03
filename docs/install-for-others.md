# Getting this working on someone else's machine

Three things have to meet: the **extension** in their Chrome, the **Hub** (which the DSH plugin embeds, or the MCP
adapter starts), and a **client** — DSH or any MCP client. This page is the short version; the long version, with the
ports and the token, is [dsh-plugin-migration.md](dsh-plugin-migration.md).

## What they need

- Chrome or Edge 125 or newer. Their normal profile: the whole point is the logins that are already there.
- DSH, for the plugin path. Chromium alone is not enough: the extension carries no model.
- For the MCP-only path, any MCP client (Qoder, Claude Code, Cursor, ...).
- Node 24.22.1 or newer **only if they build the extension themselves**. The release zip needs nothing but a browser.

## Path A — the release zip (no build)

1. Download `nanobrowser-<version>.zip` from the repository's releases and unpack it somewhere permanent.
2. `chrome://extensions` → Developer mode → **Load unpacked** → the unpacked folder.
3. Install the two DSH bundles from a checkout of this repository (they are not on npm yet):

   ```text
   plugin_manager install_bundle <repo>/dsh-plugin/nanobrowser enabled:true
   plugin_manager install_bundle <repo>/dsh-plugin/nanobrowser-ui enabled:true
   ```

4. Restart DSH once, then ask for `nanobrowser_status`. It must say `connected`.
5. Open any normal page, click the extension's toolbar button (or press `Alt+Shift+N`): the side panel shows the live
   DSH session.

## Path B — from source

```bash
git clone https://github.com/fengdihuahua/nanobrowser
cd nanobrowser
pnpm install
WXT_BRIDGE=1 pnpm build     # the DSH build; without the flag the worker does not poll the Hub
```

Then steps 2–5 above, pointing `Load unpacked` at `dist/`.

## Path C — an MCP client only

```jsonc
{
  "mcpServers": {
    "nanobrowser": {
      "command": "node",
      "args": ["<repo>/dsh-plugin/nanobrowser/mcp/adapter.mjs"],
      "env": { "NANOBROWSER_BRIDGE_PORT": "8790", "NANOBROWSER_BRIDGE_TOKEN": "dev-token" }
    }
  }
}
```

The adapter connects to a Hub if one is running, and starts its own if not. Two clients can each hold their own tab.

## Check it works

With DSH open (or the adapter running) and the extension loaded:

```bash
node fixtures/hub-smoke.mjs
```

It registers as a client, opens the fixture page, snapshots it, reads console and network, and hands the tab back. Every
step prints ✓ or ✗, and the exit code is 1 if any failed. `--port` and `--token` match a non-default Hub; `--url` picks
another page.

## Skills

- The extension ships three: `add-two-rows`, `fill-signup` and `dev-harness` (open a dev-server page and wait for it).
- A skill the agent saves goes to `~/.dsh/skills/browser`, so it is the same in every project.
- The shipped ones are read in place from `<repo>/skills/browser`.

## When it does not work

| Symptom | Check |
| --- | --- |
| `nanobrowser_status` says disconnected | The extension was built without `WXT_BRIDGE=1`, or the worker was not reloaded after a build. |
| The toolbar button does nothing | The build predates the panel fix; rebuild and reload. `Alt+Shift+N` goes through the same handler. |
| Port 8790 already in use | Another MCP bridge or an old plugin owns it. Disable `include:mcp-nanobrowser`, or set another port on both sides. |
| `ERR_CONNECTION_REFUSED` from the smoke | Nothing is serving the page it opens. Start `pnpm fixtures`, or pass `--url`. |
| Build fails on SWC under the DSH sandbox | Build in a normal terminal; the native cache lives under `~/Library/Caches` (macOS) or `%LOCALAPPDATA%` (Windows). |
| Skills missing | The user's skills live in `~/.dsh/skills/browser`; the shipped ones are read from beside the plugin. Point `builtinSkillsDir` at the checkout if it was installed from somewhere else. |

## Sharing a browser skill

A skill is a directory: `SKILL.md` (what the model reads) and `recipe.json` (what the runner executes). Copy it into
another machine's `~/.dsh/skills/browser/`, or commit it under `skills/browser/` here and it ships with the next build.
Recipes are origin-locked, so a skill recorded on one site will refuse to run on another.
