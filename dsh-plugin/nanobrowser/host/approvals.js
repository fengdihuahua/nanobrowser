// DSH tool approvals in the side-panel drawer.
//
// The DSH Web UI is the default answerer. While the drawer is connected, this listener offers the same request there
// first; a timeout or "Ask in DSH" delegates to the normal waterfall, so an unattended drawer never blocks the Host.
// Browser write approvals are separate: the extension's own cards own those.

import { randomUUID } from 'node:crypto';

export function registerApprovals(ctx, hub, settings) {
  const pending = new Map();

  const service = {
    /** `allow`, `deny`, or `delegate`; the first answer for an id wins. */
    answer(id, decision) {
      const key = String(id ?? '');
      const entry = pending.get(key);
      if (!entry) return false;
      pending.delete(key);
      clearTimeout(entry.timer);
      const outcome = decision === 'allow' ? 'allowed-once' : decision === 'delegate' ? 'delegate' : 'rejected';
      entry.resolve(outcome);
      return true;
    },
  };
  hub.setApprovalService(service);

  const dispose = ctx.on('approval/request', async (req, next) => {
    if (!hub.hasWsClients()) return next();
    const id = randomUUID();
    const outcome = await new Promise(resolve => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        resolve('delegate');
      }, settings.approvalTimeoutMs);
      pending.set(id, { resolve, timer });
      if (req.signal) {
        req.signal.addEventListener(
          'abort',
          () => {
            if (!pending.has(id)) return;
            pending.delete(id);
            clearTimeout(timer);
            resolve('cancelled');
          },
          { once: true },
        );
      }
      hub.publish({
        type: 'approval',
        id,
        sessionId: req.agent?.id ?? null,
        toolName: req.toolName,
        ...(req.reason ? { reason: req.reason } : {}),
        ...(req.displayReason ? { displayReason: req.displayReason } : {}),
      });
    });
    if (outcome === 'delegate') return next();
    return outcome;
  });

  return () => {
    hub.setApprovalService(null);
    try {
      dispose();
    } catch {
      /* already disposed */
    }
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve('cancelled');
    }
    pending.clear();
  };
}
