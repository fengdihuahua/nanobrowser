# Nanobrowser external bridge (developer spike)

This is the first proof of the architecture you asked for: **DSH is the brain, the extension is the hands, and a local
bridge is the nervous system.** The agent works the user's real Chrome tab through `chrome.debugger`; it is not a second
Playwright browser and not another profile.

```
DSH agent
  ⇅ MCP over stdio
bridge/mcp-bridge.mjs            (this file; DSH starts it)
  ⇅ HTTP long-poll on 127.0.0.1  (the extension cannot listen, so it connects out)
Nanobrowser extension (WXT_BRIDGE build)
  ⇅ chrome.debugger / CDP
real Chrome tab
```

## What this first proof exposes

- `navigate` — open a URL in the shared tab, or go back, forward, reload.
- `snapshot` — the layer's outline with refs, names, states and values.
- `click` — trusted input on a ref, with the layer's actionability checks and receipt.

It shares the **active tab the first time a tool runs** and keeps it. It has no prompt UI yet: the external session
runs with `confirm: 'never'`, so a sensitive click goes ahead without a card. Use a page where that is acceptable.

## Build the extension with the client

PowerShell, from the repository root:

```powershell
$env:WXT_BRIDGE = '1'
$env:WXT_BRIDGE_PORT = '8790'
$env:WXT_BRIDGE_TOKEN = 'dev-token'
$env:npm_config_engine_strict = 'false'   # only the local machine: its Node is below the repo's >=24.22.1
pnpm install
pnpm build
```

Load `dist/` unpacked in Chrome (or reload the existing unpacked copy). Builds without `WXT_BRIDGE` never start the
poll loop.

## Point DSH at it

`~/.dsh/profiles/desktop/cordis.patch.yml` already has the `mcp-nanobrowser` insert:

```yaml
- insert:
    - id: mcp-nanobrowser
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: nanobrowser
        command: node
        args: ['D:\code\nanobrowser\bridge\mcp-bridge.mjs']
        env:
          NANOBROWSER_BRIDGE_PORT: '8790'
          NANOBROWSER_BRIDGE_TOKEN: 'dev-token'
        toolCallTimeoutMs: 600000
```

Restart DSH (or reload the profile) so the bridge starts and the tools appear:

- `mcp__nanobrowser__navigate`
- `mcp__nanobrowser__snapshot`
- `mcp__nanobrowser__click`

## Try it

1. Open a normal page in Chrome and keep it the active tab.
2. In DSH: *"Use mcp__nanobrowser__snapshot to read the current tab, then click the link named …"*.
3. Chrome shows the debugger bar; the extension shares the tab and the layer runs.

The bridge's `/health` is at `http://127.0.0.1:8790/health?token=dev-token` while DSH is running.

## Limits of this proof

- Active tab only; no tab switching or tab list yet.
- Top frame only for the tools exposed here; the layer itself handles iframes in its snapshots.
- No prompt cards for the external session, no `evaluate`/selector/raw CDP yet.
- The MV3 worker is kept alive by the long poll; an alarm every 30 s is the backstop.
- If a call says the extension is not connected, the extension is not polling: check it is the `WXT_BRIDGE` build, it
  is enabled, and the token matches.

## Security

The bridge binds `127.0.0.1` and checks a shared token. The default `dev-token` is for this spike; set
`NANOBROWSER_BRIDGE_TOKEN` and build the extension with the same `WXT_BRIDGE_TOKEN` before using it on a machine with
other local processes. The external session is separate from the product's agent sessions.
