// A browser action is refused until its session owns a tab. The guard is synchronous and applies to every agent;
// reads/list/status/attach stay available so a session can discover and take a tab, and panel notes/audit are safe.

const LEASE_FREE = new Set(['status', 'attach', 'detach', 'say', 'reload-extension', 'audit']);

/** The extension-side name of a `nanobrowser_*` tool, or undefined for a tool this plugin did not register. */
export function browserToolName(name) {
  const value = String(name ?? '');
  return value.startsWith('nanobrowser_') ? value.slice('nanobrowser_'.length) : undefined;
}

export function requiresLease(name, args = {}) {
  const raw = browserToolName(name);
  if (raw === undefined) return false;
  // Listing tabs is discovery; opening, selecting or closing one changes the browser and needs a lease.
  if (raw === 'tabs') return String(args?.action ?? '') !== 'list';
  return !LEASE_FREE.has(raw);
}

export function registerLeaseGuard(ctx, hub) {
  return ctx.tools.guard(execution => {
    if (!requiresLease(execution.name, execution.arguments)) return undefined;
    const clientId = execution.agent?.id;
    if (!clientId) return 'No live session is attached to a browser tab.';
    if (!hub.leaseOf(String(clientId))) {
      return 'Attach this session to a tab first with nanobrowser_attach.';
    }
    return undefined;
  });
}
