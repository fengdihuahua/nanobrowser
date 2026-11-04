// A fake extension for the hub tests: it polls, answers the two commands the control routes use, and can be told to
// stall or to refuse an attach. Shared so the hub and adapter tests cannot drift apart.

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error('timed out waiting for the condition');
}

export const TABS = [
  { tabId: 5, url: 'https://example.test/a', title: 'A', active: true },
  { tabId: 6, url: 'https://example.test/b', title: 'B', active: false },
  { tabId: 7, url: 'https://example.test/c', title: 'C', active: false },
];

/** The answers a real extension gives for the two commands the control routes use, and a generic one for the rest. */
export function answer(command, options) {
  if (command.tool === 'tabs-all') return { ok: true, text: 'tabs ok', data: { tabs: TABS } };
  if (command.tool === 'tabs' && command.args?.action === 'list') {
    const active = TABS.find(tab => tab.active) ?? TABS[0];
    return {
      ok: true,
      text: `tabs · ${TABS.length} in the session\n* tab ${active.tabId} · «${active.title}» · «${active.url}»`,
    };
  }
  if (command.tool === 'read') {
    return {
      ok: true,
      text: '订单 1001\n合计 1,200.00',
      data: { selection: { text: '订单 1001' } },
    };
  }
  if (command.tool === 'attach' && options.attachFails) {
    return { ok: false, text: 'Tab 6 is a browser page and cannot be driven.' };
  }
  if ((options.fail ?? []).includes(command.tool)) {
    return {
      ok: false,
      text: `error NO_MATCH (nothing dispatched; safe to retry)\nNo element matches.\nTake a snapshot to see what the page contains.`,
    };
  }
  return { ok: true, text: `${command.tool} ok` };
}

/** A poll loop that answers normally, stalls every call, or stalls only the first one. */
export function fakeExtension(
  hub,
  {
    mode = 'answer',
    attachFails = false,
    fail = [],
    tab = { tabId: 5, url: 'https://example.test/a', title: 'A' },
  } = {},
) {
  const options = { attachFails, fail };
  const base = `http://127.0.0.1:${hub.port}`;
  const token = encodeURIComponent(hub.token);
  const controller = new AbortController();
  const seen = [];
  let calls = 0;
  const post = (path, body) =>
    fetch(`${base}${path}?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  const done = (async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(`${base}/poll?token=${token}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`poll answered ${response.status}`);
        const body = await response.json();
        for (const command of body.commands ?? []) {
          seen.push(command);
          if (command.tool === 'cancel') {
            await post('/result', { id: command.id, result: { ok: true, text: 'cancelled' } });
            continue;
          }
          calls += 1;
          const stall = mode === 'stall' || (mode === 'stall-first' && calls === 1);
          if (stall) continue;
          await post('/result', { id: command.id, result: answer(command, options), tab });
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        throw error;
      }
    }
  })();
  return {
    seen,
    stop() {
      controller.abort();
      return done.catch(() => undefined);
    },
  };
}
