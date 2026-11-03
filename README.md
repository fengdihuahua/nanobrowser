<h1 align="center">
    <img src="https://github.com/user-attachments/assets/294f9cdc-38ba-4cdc-beff-82fe78c9a023" width="100%" alt="Nanobrowser" /><br>
</h1>

<div align="center">

[![GitHub](https://img.shields.io/badge/GitHub-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/nanobrowser)
[![Discord](https://img.shields.io/badge/Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/NN3ABHggMK)
[![Sponsor](https://img.shields.io/badge/Sponsor-ff69b4?style=for-the-badge&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/alexchenzl)

</div>

## 🌐 What this is

Nanobrowser gives an agent **the Chrome you are already using**: your tabs, your logins, your cookies, the page you are
looking at. It is hands and eyes, not a brain — the model, the conversation and the loop live in
[DSH](https://github.com/deepseek-ai) or in any MCP client, and the extension carries none of them.

```
DSH agent  ──►  Hub  ──►  Nanobrowser extension  ──►  your real tab
Qoder / Claude Code / Cursor ──► MCP adapter ──┘        (chrome.debugger)
```

- **One Hub** talks to the extension. The DSH plugin embeds it; the MCP adapter connects to it. There is no other way in.
- **No key, no model, no history** in the extension. Those belong to the client above it.
- **A person decides** what changes: submit, send, delete and upload wait for a card in the side panel; passwords,
  payments, access grants and page dialogs are always your own step.

## ✨ What it does

- **Your real browser.** The tabs you are signed into, with your extensions, language, timezone and cookies. No second
  profile, no new login.
- **A person in the loop.** A write opens a card with the target and the reason; a refusal sends nothing. Secret fields
  are masked wherever page text is returned.
- **One sight line.** The side panel is the live DSH session: history, tool trace, approvals, "waiting for you" cards and
  Stop, in the browser you are working in.
- **Skills.** A successful task can be saved as a parameterised, origin-locked recipe and replayed later. Your skills
  live in `~/.dsh/skills/browser`, so they follow you from project to project; the ones shipped here are read-only.
- **Any MCP client.** Qoder, Claude Code, Cursor and friends get the same hands through one stdio adapter.

## 🚀 Install

1. **Build the extension.**

   ```bash
   pnpm install
   WXT_BRIDGE=1 pnpm build
   ```

2. **Load it.** `chrome://extensions` → Developer mode → **Load unpacked** → this repository's `dist/`.

3. **Install the DSH bundles.**

   ```text
   plugin_manager install_bundle <repo>/dsh-plugin/nanobrowser enabled:true
   plugin_manager install_bundle <repo>/dsh-plugin/nanobrowser-ui enabled:true
   ```

   Restart DSH once, then `nanobrowser_status` should answer `connected`.

4. **Or use another MCP client.** Point it at `node <repo>/dsh-plugin/nanobrowser/mcp/adapter.mjs`; it starts a Hub if
   none is running.

5. **Check the wiring.**

   ```bash
   node fixtures/hub-smoke.mjs
   ```

   It registers as a client, opens the fixture page, snapshots it, reads console and network, and hands the tab back.

The full sequence, including the ports and the token, is in [docs/dsh-plugin-migration.md](docs/dsh-plugin-migration.md)
and [docs/dsh-plugin-new-machine-runbook.md](docs/dsh-plugin-new-machine-runbook.md).

## 🛡️ What the agent may do

| What the agent does | Ask mode (default) | Auto mode |
| --- | --- | --- |
| Read pages, click links, scroll, switch tabs | Goes ahead | Goes ahead |
| Submit, send, delete, upload | A card, approved before it is dispatched | Goes ahead, unless the site is set to Ask |
| Payment, access grant, secret input, page `prompt` | Your own step, in every mode | Your own step, in every mode |

Detection is best effort. Enforcement is not: the layer refuses to dispatch what it classified as a write until the card
says yes, and no agent call can turn that off.

## 🧭 Where things live

| Path | What |
| --- | --- |
| `src/browser-control/` | The layer: observe, act, report. Deterministic, no model. |
| `src/extension/` | The worker: hosts the layer, takes the Hub's calls, opens the cards |
| `src/side-panel/` | The side panel: the live DSH session |
| `dsh-plugin/nanobrowser/` | The DSH plugin: Hub, tools, leases, approvals, chat, skills |
| `dsh-plugin/nanobrowser-ui/` | The DSH left-sidebar page |
| `docs/` | The goal, the spec, the migration list and the runbooks |
| `skills/browser/` | The shipped Browser Skills |

## 📚 Docs

- [Getting it working on someone else's machine](docs/install-for-others.md) — the short version, three paths
- [Goal, users and status](docs/dsh-plugin-goal.md)
- [Full specification](docs/dsh-plugin-spec.md)
- [Moving the setup to another machine](docs/dsh-plugin-migration.md) · [New-machine runbook](docs/dsh-plugin-new-machine-runbook.md)
- [Privacy](PRIVACY.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

## 📄 Licence

Apache License 2.0 — see [LICENSE](LICENSE). The extension vendors no model, no analytics and no account; see
[PRIVACY.md](PRIVACY.md) for exactly what leaves the browser and where it goes.
