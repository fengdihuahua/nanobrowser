# Moving the DSH × Nanobrowser setup to another computer

This is the transfer checklist. The code and the skill library live in this repository; the DSH profile, the Chrome
build and the login state are machine-local and are rebuilt on the new machine.

## 1. What travels, what does not

| Travels with the repository | Rebuilt / recreated on the new machine |
|---|---|
| `dsh-plugin/nanobrowser/` (Host: Hub, tools, leases, approvals, skills, chat) | DSH profile installation and bundle selection |
| `dsh-plugin/nanobrowser-ui/` (DSH left-sidebar client) | `dist/` extension build |
| `skills/browser/` (the skill library) | Chrome profile, cookies, site logins |
| `src/` bridge/panel changes (DSH drawer, approval and user-step cards) | DSH session history (unless copied) |
| `docs/`, `bridge/`, `fixtures/` | fixture server process |

Do not copy `node_modules/`, `dist/`, `.wxt/`, `.output/`, `.dsh-app/`, or the DSH profile's `node_modules/`; they are
machine-specific and are regenerated.

## 2. On the old machine: commit or pack

The working tree is the source of truth. Commit and push:

```powershell
cd D:\code\nanobrowser
git status --short
git add -A
# optional: git reset -- "Kimi浏览器插件技术方案.md"   # an unrelated file
git commit -m "wip: DSH nanobrowser bridge, plugin, sidebar, skills"
git push
```

If there is no remote, create a bundle that includes the history:

```powershell
git bundle create D:\nanobrowser-transfer.bundle --all
```

If the work cannot be committed, copy the working tree without the heavy generated folders:

```powershell
tar -czf D:\nanobrowser-transfer.tgz --exclude=node_modules --exclude=dist --exclude=.wxt --exclude=.output --exclude=.dsh-app .
```

Optionally copy the DSH session history (old conversations):

```powershell
# Windows
Copy-Item -Recurse "$env:USERPROFILE\.dsh\sessions" D:\dsh-sessions-backup
```

Do not copy the whole `.dsh\profiles\desktop` directory: its plugin links and `node_modules` point at the old machine.

## 3. On the new machine: prerequisites

- Windows with Chrome or Edge.
- DSH installed, ideally the same release as the old machine.
- Node 24 LTS, at least 24.22.1, and pnpm 10.34.7 through Corepack.
- Git.

Unpack the repository to the same path, `D:\code\nanobrowser`, when possible; the DSH workspace, session history and
skill paths then line up. A different path also works: the plugin uses the workspace's `skills/browser`.

From a bundle:

```powershell
git clone D:\nanobrowser-transfer.bundle D:\code\nanobrowser
```

## 4. Build the extension

```powershell
cd D:\code\nanobrowser
corepack enable
pnpm install
$env:WXT_BRIDGE='1'
$env:WXT_BRIDGE_PORT='8790'
$env:WXT_BRIDGE_TOKEN='dev-token'
pnpm build
```

The build needs a normal terminal, not the DSH file sandbox: WXT/SWC writes its native cache under
`%LOCALAPPDATA%\swc` and spawns child processes. If the extension was already built somewhere else, do not reuse
`dist/`; rebuild so the side panel and the bridge match this checkout.

In Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked** → `D:\code\nanobrowser\dist`. Then log
into the sites the agent should use. The bridge uses this Chrome profile; logins do not move with the code.

If you want the fixture skills (`add-two-rows`, `fill-signup`):

```powershell
$env:npm_config_engine_strict='false'
node -e "import('file:///D:/code/nanobrowser/fixtures/server.mjs').then(m => m.startServer())"
```

## 5. Install the two DSH bundles

Open DSH with the repository as the workspace, then:

```text
plugin_manager install_bundle D:\code\nanobrowser\dsh-plugin\nanobrowser enabled:true
plugin_manager install_bundle D:\code\nanobrowser\dsh-plugin\nanobrowser-ui enabled:true
```

If the profile still has the old MCP row, disable it so the plugin owns port 8790:

```text
plugin_manager set_plugin include:mcp-nanobrowser enabled:false
```

If the new profile has no `mcp-nanobrowser` row, skip that line. The Host bundle's patch no longer hardcodes a skill
path: it uses `<workspace>/skills/browser`.

The UI bundle is a separate package on purpose. DSH caches package metadata until a restart, while a new package name
is scanned into the client graph immediately, so the left-sidebar entry appears without restarting DSH.

## 6. Verify

1. Ask for `nanobrowser_status`: it should say `connected`.
2. Open the DSH left sidebar: there should be a **Nanobrowser** entry with hub status, live sessions/leases, skills
   and recent calls.
3. Open the Chrome side panel: the header has **DSH**; the drawer shows the live session, history and composer.
4. Call `nanobrowser_attach` with no arguments: it picks an unleased normal tab; then `nanobrowser_snapshot`.
5. `browser_skill_list` should show the two sample skills.
6. With the fixture server up, run `fill-signup` with `{ name, email, country, notes }`.
7. With the drawer open, ask the model to call `nanobrowser_wait_for_user`; the drawer should show the instruction
   and **Continue**.

## 7. Troubleshooting

- **Port 8790 busy**: another MCP bridge or an old plugin owns it. Disable `include:mcp-nanobrowser`, stop the old
  process, or check `netstat -ano | Select-String ':8790'`.
- **Extension not connected**: the extension must be built with the same port and token as the plugin
  (`8790`, `dev-token`), loaded unpacked, and at least one normal page must be open.
- **Left sidebar entry missing**: install `dsh-plugin/nanobrowser-ui` (not just the Host bundle). The UI bundle must be
  enabled in the same profile.
- **Skills missing**: `skills/browser/` must have been committed or copied. The skill directory is
  `<workspace>/skills/browser` unless the plugin config overrides `skillsDir`.
- **`pnpm build` fails with SWC**: run it in a normal terminal; the DSH sandbox cannot write the native cache or
  spawn the build subprocess.
- **Old DSH session does not open**: copy `%USERPROFILE%\.dsh\sessions` to the new machine and keep the same workspace
  path; otherwise start a fresh session. The plugin and skills do not depend on old sessions.

## 8. Current state at handoff

- Per-client sessions and the `tabs-all` / `attach` commands are built and verified: an attach with no arguments chose
  an unleased tab and a snapshot succeeded.
- `wait_for_user`, approval routing, the Chrome drawer, the DSH left-sidebar page, the lease guard and the audit tool
  are in place.
- Still open on the full target: selection capture, `agent.inject` on page changes, the full audit timeline UI, the
  skills UI in the sidebar, and a real click-through of `wait_for_user`.
