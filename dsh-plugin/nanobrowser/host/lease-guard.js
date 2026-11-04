// A browser action is refused until its session owns a tab. The guard is synchronous and applies to every agent;
// reads/list/status/attach stay available so a session can discover and take a tab, and panel notes/audit are safe.
// Which tools need a tab is decided once, in `core/tools.js`, so the guard and the Hub cannot disagree.

import { needsLease } from '../core/tools.js';

/** The extension-side name of a `nanobrowser_*` tool, or undefined for a tool this plugin did not register. */
export function browserToolName(name) {
  const value = String(name ?? '');
  return value.startsWith('nanobrowser_') ? value.slice('nanobrowser_'.length) : undefined;
}

export function requiresLease(name, args = {}) {
  const raw = browserToolName(name);
  return raw === undefined ? false : needsLease(raw, args);
}

export function registerLeaseGuard(ctx, hub) {
  return ctx.tools.guard(execution => {
    if (!requiresLease(execution.name, execution.arguments)) return undefined;
    const clientId = execution.agent?.id;
    if (!clientId) return 'No live session is attached to a browser tab.';
    if (hub.ownedTabId(String(clientId)) === null) {
      return 'Attach this session to a tab first with nanobrowser_attach.';
    }
    return undefined;
  });
}
