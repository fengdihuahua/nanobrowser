# Chrome Web Store listing

Paste-ready copy for the store entry. The extension no longer carries a model, a key or a conversation, so the listing
must not promise a chat product of its own. Update the store entry whenever this file changes.

## Name

Nanobrowser — hands for your agent

## Short description (132 characters max)

Give your agent the Chrome you already use: your tabs, your logins, and a card in the side panel before anything is
submitted.

(129 characters.)

## Detailed description

Nanobrowser gives an agent your **real browser** — the tabs you are already signed into, with your cookies, extensions
and language — and asks you before anything is submitted, sent, deleted or uploaded.

It is hands and eyes, not a brain. The agent runs in DeepSeek Harness (DSH) or in any MCP client you already use
(Qoder, Claude Code, Cursor, ...). Nanobrowser carries no model, no API key and no conversation history.

**What you get**

- Your real logins. No second profile, no re-login, no separate browser.
- A person in the loop. A write opens a card with the page and the reason; a refusal sends nothing.
- One sight line. The side panel mirrors the live DSH session: history, tool trace, approvals and Stop, right where you
  are working. A task's pages are chips above it and one named tab group in the tab strip.
- Skills. A successful task can be saved as a reusable, origin-locked recipe and replayed later; a failed replay leaves
  a note about what failed, and the next run of that skill brings it back.
- A control plane. The DSH left sidebar shows the hub, your skills with their parameters (run one, or rehearse it with a
  dry run) and an audit of every call you can filter and export.
- Any MCP client. One adapter gives Qoder, Claude Code and Cursor the same hands.

**What you need**

Nanobrowser is the browser side of an agent you run yourself. It needs either the DSH plugin (bundled with this project)
or an MCP client pointed at the adapter. Without one of them the extension has nothing to drive.

**Your data**

- No account, no Nanobrowser server, no analytics, no identifier.
- Nothing is sent to us. Page content reaches the model you configured in your own client, and only when the agent asks
  to read a page.
- Passwords, payment-card numbers and one-time codes are masked wherever page content is returned.
- Payments, access grants, secret input and page prompts are always your own step: the agent does not type them.

**Open source**

Apache License 2.0. The source is in the repository this build comes from, and PRIVACY.md says exactly what
leaves the browser.

## Permission justifications

Chrome asks for a reason for each permission on the listing and in review.

| Permission | Why |
| --- | --- |
| `debugger` | The only way a Chrome extension can read a page's accessibility tree and send trusted input. It is the extension's hands and eyes. |
| `tabs` | To list the tabs a session may work on, follow navigation, and name the tab a card is about. |
| `sidePanel` | The side panel is the interface: the live session, the approvals, Stop. |
| `storage` | Four settings only: interface language, theme, page border, site rules. |
| `webNavigation` | To notice a navigation so the layer drops stale element references instead of acting on an old page. |
| `alarms` | Keeps the connection to the local hub alive while the service worker sleeps. |
| `scripting` | Draws the page border on the tab a working session is acting on (one setting turns it off). |
| `tabGroups` | Names the group of tabs each task gets, so the pages of one task are easy to find in the tab strip. Grouping itself needs no permission; naming the group needs this one. |
| Host permission: all sites | The agent works whichever site you point it at. Nothing is read until a session is attached to a tab and the agent asks. |

No optional permissions are requested. Nanobrowser asks for nothing else.

## Data-use disclosures

- Does the extension collect user data? **No.** The extension sends nothing to the developer or to third parties.
- Page content is passed to the model chosen in the user's own client, which is outside the extension.
- No analytics, no tracking, no advertising, no account.

## Assets to prepare

- **Screenshots** (1280×800): the side panel with a session and its tool trace; an approval card over a checkout page;
  Settings → Permissions; the DSH left-sidebar page.
- **Small promo tile** (440×280) and, if the entry is featured, a large one (1400×560).
- **Category**: Productivity → Tools. **Languages**: English, Simplified Chinese, Traditional Chinese.

## Before publishing

1. The version in `package.json` and the entry must match.
2. Run `pnpm autorun permission-warnings` if the check is rebuilt; the product must add no install warning the previous
   version did not have.
3. Take the screenshots from a real session; do not stage fake page content.
