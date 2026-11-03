# New-machine runbook (for the next DSH session)

Hand this session the archive, unpack it, and ask the Creator-mode session to follow this file. The user does the
steps that need a person (DSH install, Chrome extension load, site logins); the agent does the local build and the
profile installation.

## Who does what

| Step | Owner | Action |
|---|---|---|
| 1 | User | Install DSH (same release as the old machine), Node 24 LTS (>= 24.22.1), Chrome or Edge, Git. |
| 2 | User | Unpack the archive to `D:\code\nanobrowser` (same path is recommended) and open it as the DSH workspace. |
| 3 | User | Create a **Creator-mode** DSH session; `plugin_manager` is enabled there. |
| 4 | Agent | Run `scripts/dsh-nanobrowser-bootstrap.ps1` from a normal terminal (or with full access). It installs dependencies and builds the bridge extension. |
| 5 | User | `chrome://extensions` → Developer mode → **Load unpacked** → `D:\code\nanobrowser\dist`; log into the sites. |
| 6 | Agent | Install the two local bundles and disable the old MCP row if it exists. |
| 7 | Agent | Verify `nanobrowser_status`, the left-sidebar entry, the Chrome drawer and the skill list. |
| 8 | Both | Run one browser task and one `wait_for_user` flow as the acceptance check. |

## 1. Unpack

```powershell
# copy the archive from the USB drive, then:
New-Item -ItemType Directory -Force D:\code | Out-Null
tar -xzf <archive>.tgz -C D:\code
```

The archive contains the repository without `node_modules`, `dist`, `.wxt`, `.output`, `.dsh-app` or `.git`.

## 2. Start a Creator-mode DSH session

Open DSH, choose the repository as the workspace, and create a new session with the **Creator mode** preset. Then say:

> 读 `docs/dsh-plugin-new-machine-runbook.md`，按里面的 Agent 步骤继续。

`plugin_manager` must be available in that session; it is enabled in Creator mode.

## 3. Agent: build

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\code\nanobrowser\scripts\dsh-nanobrowser-bootstrap.ps1
```

The script checks Node/pnpm, runs `pnpm install`, and builds with the bridge environment:

```text
WXT_BRIDGE=1
WXT_BRIDGE_PORT=8790
WXT_BRIDGE_TOKEN=dev-token
```

Run it in a normal terminal. The WXT/SWC build needs writes to `%LOCALAPPDATA%\swc` and child processes; the default
DSH file sandbox blocks both. If the agent runs it, request full access for that command.

## 4. Agent: install the bundles

```text
plugin_manager install_bundle D:\code\nanobrowser\dsh-plugin\nanobrowser enabled:true
plugin_manager install_bundle D:\code\nanobrowser\dsh-plugin\nanobrowser-ui enabled:true
```

If the profile still has the old MCP row:

```text
plugin_manager set_plugin include:mcp-nanobrowser enabled:false
```

If the row does not exist, skip it. The Host bundle's patch uses `<workspace>/skills/browser`; no path edit is needed.

## 5. Agent: verify

1. `nanobrowser_status` → `connected`.
2. `Slots.listSubTree` root `sidebar.panellist` → an occupant with `id: nanobrowser` (the UI bundle loaded).
3. `browser_skill_list` → `add-two-rows`, `fill-signup`.
4. `nanobrowser_attach` with no arguments → attaches to an unleased normal tab; `nanobrowser_snapshot` returns refs.
5. Ask the user to open the Chrome side panel → **DSH**; the drawer shows the current session and history.
6. Optional: start the fixture server, run `fill-signup`, and exercise `nanobrowser_wait_for_user` with the drawer.

Fixture server:

```powershell
$env:npm_config_engine_strict='false'
node -e "import('file:///D:/code/nanobrowser/fixtures/server.mjs').then(m => m.startServer())"
```

## 6. If something fails

| Symptom | Check |
|---|---|
| Port 8790 busy | Disable `include:mcp-nanobrowser`; find the old process with `netstat -ano | Select-String ':8790'`. |
| Extension not connected | Build env must be `8790` / `dev-token`; the unpacked `dist/` must be reloaded; one normal page must be open. |
| Left sidebar missing | The `nanobrowser-ui` bundle is not installed or not enabled. The Host bundle alone has no client page. |
| Skills missing | `skills/browser/` was not copied, or `skillsDir` resolved to the DSH process cwd instead of the workspace. See the macOS note below. |
| Build fails on SWC | Run outside the DSH sandbox in a normal terminal. On macOS, also use a Node binary that may load ad-hoc native addons; see the macOS note below. |
| `wait_for_user` says the drawer is closed | The drawer must be expanded, not just the DSH button visible: the WebSocket connects only while it is open. |
| Old DSH session missing | Copy `%USERPROFILE%\.dsh\sessions` and keep the same workspace path; otherwise start a new session. |

## 7. macOS (this machine)

The steps above were written on Windows. On this Mac the same order works, with these differences.

- Repository: `/Users/liufengdi/Documents/Code/nanobrowser`. There is no Git checkout here, so `dist/` cannot be
  reproduced from a commit; rebuild before trusting it.
- Node: 24.21.0 ships with DSH and 24.15.0 is in `/usr/local/bin`. Both are below `engines.node` `>=24.22.1`, so run
  pnpm with `npm_config_engine_strict=false`, as the Windows script already does.
- Build with the system Node, not the DSH runtime Node. The runtime Node is signed with the DSH Team ID and has no
  `com.apple.security.cs.disable-library-validation` entitlement, so it cannot load SWC's ad-hoc-signed
  `swc.darwin-arm64.node` (`ERR_DLOPEN_FAILED`). SWC also materializes a native cache under
  `~/Library/Caches/swc-native-501`, so either build with full access or keep the cache inside the workspace:

  ```bash
  export PATH="/usr/local/bin:$PATH" npm_config_engine_strict=false SWC_NATIVE_BINDING_CACHE="$PWD/.swc-cache"
  export WXT_BRIDGE=1 WXT_BRIDGE_PORT=8790 WXT_BRIDGE_TOKEN=dev-token
  node <dsh-runtime>/pnpm/bin/pnpm.mjs build
  ```

  Remove `.swc-cache` afterwards; it is not ignored by git.

- Skills: `browser_skill_list` resolved `skillsDir` to `~/.dsh/profiles/desktop/skills/browser` (the DSH process cwd),
  not `<workspace>/skills/browser`, so both sample skills were missing. A symlink fixes it without a restart:

  ```bash
  mkdir -p ~/.dsh/profiles/desktop/skills
  ln -s /Users/liufengdi/Documents/Code/nanobrowser/skills/browser ~/.dsh/profiles/desktop/skills/browser
  ```

  The alternative is a `skillsDir` override for the `nanobrowser` entry in `~/.dsh/profiles/desktop/cordis.patch.yml`,
  which takes effect on the next DSH start.

- The profile has no `include:mcp-nanobrowser` row, so that step is a no-op here.

## Current handoff state

- Per-client sessions and `tabs-all` / `attach` are built and verified: an attach without arguments chose an unleased
  tab and a snapshot succeeded.
- `wait_for_user`, approval routing, the Chrome drawer, the DSH left-sidebar page, the lease guard and the audit tool
  are in place.
- Verified on this Mac (2026-11-03): the bundle install, the left-sidebar `nanobrowser` entry, both skills, an attach
  with no arguments plus a snapshot, the `fill-signup` replay (6/6 steps on the fill fixture), and a real
  `wait_for_user` click-through from the Chrome drawer.
- Done after the handoff, on this Mac (2026-11-03):
  - **selection capture**: `read` returns `data.selection` from one fixed read-only CDP expression in the page's own
    world (an isolated world reports no selection), and the side panel's `page_context` carries it inside a
    `<selection>` element.
  - **live prompt context** (the `agent.inject` item): a `systemPrompt.context` entry per session, with the tab, the
    last call and its duration, a failed call's result, and a stale-refs warning after a navigation.
  - **audit timeline**: `call-start`/`call-end` carry arguments, duration and a result summary; the left sidebar's
    "recent calls" card renders them with tab and timing.
  - **skills UI**: the left sidebar can run a saved skill on the session that holds the tab lease, with its
    parameters and per-step results; write steps still ask in the Chrome drawer.
- Still open: the skills UI in the sidebar is read-and-run only (no save or version rollback there), and the Chrome
  drawer has no selection toggle of its own — it follows the page-context switch.
