// The bridge's command dispatch, without a browser: a fake layer session, fake tabs and a fake panel. The bridge is
// the extension's only external surface, so what a command does, and what a result says, is worth a test of its own.
import { describe, expect, it, vi } from 'vitest';

// The layer's controller is created at import time and needs chrome; dispatch itself does not use it.
vi.mock('../layer', () => ({ addPromptRoute: () => undefined, controllerReady: Promise.resolve({}) }));

import { createCommandLoop, runCommand } from '../bridge';
import type { CommandPorts } from '../bridge';

/** One command as the hub sends it. */
function command(tool: string, args: Record<string, unknown> = {}, clientId = 'c1') {
  return { id: `${tool}-1`, clientId, tool, args };
}

/** A client, a browser and a side panel, enough for one command. */
function setup() {
  const calls: Array<{ tool: string; args: Record<string, unknown>; signal?: AbortSignal }> = [];
  const notes: string[] = [];
  const work: Array<{ on: boolean; tabId?: number; what: string }> = [];
  const session = {
    activeTabId: 5 as number | null,
    share: vi.fn(async (tabId: number) => {
      session.activeTabId = tabId;
    }),
    unshareTab: vi.fn(async () => {
      session.activeTabId = null;
    }),
    call: vi.fn(async (tool: string, args: Record<string, unknown>, options: { signal?: AbortSignal } = {}) => {
      calls.push({ tool, args, signal: options.signal });
      return { ok: true, text: `${tool} ok`, receipt: { sensitive: null }, data: { tool } };
    }),
  };
  const tabs = [
    { id: 5, url: 'https://example.test/a', title: 'A', active: true },
    { id: 6, url: 'chrome://extensions', title: 'Extensions', active: false },
  ];
  const ports: CommandPorts = {
    sessionFor: async () => session as never,
    sessionOf: () => session as never,
    tabs: {
      query: async () => tabs as never,
      get: async (tabId: number) => {
        const tab = tabs.find(item => item.id === tabId);
        if (!tab) throw new Error('no tab');
        return tab as never;
      },
    },
    restricted: url => url.startsWith('chrome://'),
    prompts: () =>
      ({
        note: (text: string) => notes.push(text),
        working: (on: boolean, tabId?: number, what?: string) => work.push({ on, tabId, what: what ?? '' }),
      }) as never,
    recorderFor: () => ({
      ensure: async () => undefined,
      readConsole: () => ({ text: '2 errors', entries: [{ level: 'error' }] }),
      readNetwork: () => ({ text: '1 failed', requests: [{ status: 500 }] }),
    }),
    notices: new Map<string, string>(),
  };
  return { ports, session, calls, notes, work };
}

describe('one command from the bridge', () => {
  it('runs a layer tool and forwards its receipt and data', async () => {
    const { ports, calls } = setup();
    const target = { role: 'button', name: 'Go' };
    const result = await runCommand(command('click', { target }), new AbortController().signal, ports);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('click');
    expect(calls[0].args).toEqual({ target });
    expect(result).toEqual({
      ok: true,
      text: 'click ok',
      error: undefined,
      receipt: { sensitive: null },
      data: { tool: 'click' },
    });
  });

  it('shows a note without touching the page, and refuses an empty one', async () => {
    const { ports, notes, calls } = setup();
    await expect(runCommand(command('say', { text: 'looking' }), new AbortController().signal, ports)).resolves.toEqual(
      { ok: true, text: 'shown in the side panel' },
    );
    expect(notes).toEqual(['looking']);
    const empty = await runCommand(command('say', { text: '   ' }), new AbortController().signal, ports);
    expect(empty).toEqual({ ok: false, text: 'say needs some text.' });
    // Only the note reached the panel; nothing was dispatched to the page.
    expect(calls).toHaveLength(0);
  });

  it('lists the tabs it can drive, and leaves browser pages out', async () => {
    const { ports } = setup();
    const result = (await runCommand(command('tabs-all'), new AbortController().signal, ports)) as {
      ok: boolean;
      text: string;
      data: { tabs: Array<{ tabId: number }> };
    };
    expect(result.ok).toBe(true);
    expect(result.data.tabs.map(tab => tab.tabId)).toEqual([5]);
    expect(result.text).toContain('tabs · 1 in Chrome');
    expect(result.text).toContain('* tab 5 · «A» · «https://example.test/a»');
  });

  it('attaches only to a real page, and only with a tab id', async () => {
    const { ports, session } = setup();
    expect(await runCommand(command('attach', {}), new AbortController().signal, ports)).toEqual({
      ok: false,
      text: 'attach needs a tabId.',
    });
    expect(await runCommand(command('attach', { tabId: 6 }), new AbortController().signal, ports)).toEqual({
      ok: false,
      text: 'Tab 6 is a browser page and cannot be driven.',
    });
    expect(await runCommand(command('attach', { tabId: 77 }), new AbortController().signal, ports)).toEqual({
      ok: false,
      text: 'Tab 77 is not available.',
    });
    expect(await runCommand(command('attach', { tabId: 5 }), new AbortController().signal, ports)).toEqual({
      ok: true,
      text: 'attached · tab 5',
    });
    expect(session.share).toHaveBeenCalledWith(5);
  });

  it('gives one tab back, and does not share one just to drop it', async () => {
    const { ports, session } = setup();
    expect(await runCommand(command('unshare', { tabId: 5 }), new AbortController().signal, ports)).toEqual({
      ok: true,
      text: 'unshared tab 5',
    });
    expect(session.unshareTab).toHaveBeenCalledWith(5);

    const none = setup();
    none.ports.sessionOf = () => undefined;
    expect(await runCommand(command('unshare', { tabId: 5 }), new AbortController().signal, none.ports)).toEqual({
      ok: true,
      text: 'no session for this client; nothing to unshare',
    });
    expect(none.session.unshareTab).not.toHaveBeenCalled();
    expect(none.session.share).not.toHaveBeenCalled();
  });

  it('reads the console trail through the recorder and names the tab', async () => {
    const { ports } = setup();
    const result = (await runCommand(command('console', {}), new AbortController().signal, ports)) as {
      text: string;
      data: unknown;
    };
    expect(result.text).toContain('console · tab 5');
    expect(result.text).toContain('https://example.test/a');
    // The entries travel beside the text: a skill asserts on them, not on lines of it.
    expect(result.data).toEqual({ entries: [{ level: 'error' }] });
  });

  it('reports a reload without running anything on the page', async () => {
    const { ports, calls } = setup();
    expect(await runCommand(command('reload-extension'), new AbortController().signal, ports)).toEqual({
      ok: true,
      text: 'reloading the extension; the bridge connection returns in a few seconds',
    });
    expect(calls).toHaveLength(0);
  });

  it('turns a broken session into a failed result, and clears the panel state', async () => {
    const { ports, work } = setup();
    ports.sessionFor = async () => {
      throw new Error('the debugger is gone');
    };
    expect(await runCommand(command('click', {}), new AbortController().signal, ports)).toEqual({
      ok: false,
      text: 'the debugger is gone',
    });
    // The panel stops saying "working": nothing is running any more.
    expect(work.at(-1)).toEqual({ on: false, tabId: undefined, what: '' });
  });

  it('prepends the tab a session took over, and only once', async () => {
    const { ports } = setup();
    const notice = 'The visible tab was a browser page (chrome://newtab); the session drives tab 5 instead.';
    ports.notices.set('c1', notice);
    const first = (await runCommand(command('snapshot'), new AbortController().signal, ports)) as { text: string };
    expect(first.text).toBe(`${notice}\nsnapshot ok`);
    const second = (await runCommand(command('snapshot'), new AbortController().signal, ports)) as { text: string };
    expect(second.text).toBe('snapshot ok');
  });
});

describe('the command loop', () => {
  it('runs commands in the order they were sent, and posts each result', async () => {
    const posted: Array<{ id: string; result: unknown }> = [];
    const loop = createCommandLoop({
      run: async command => ({ ok: true, text: `${command.tool} done` }),
      post: async (command, result) => {
        posted.push({ id: command.id, result });
      },
      reload: () => undefined,
    });
    loop.enqueue([command('snapshot'), command('click')]);
    await loop.drain();
    expect(posted.map(entry => entry.id)).toEqual(['snapshot-1', 'click-1']);
    expect(posted.map(entry => entry.result)).toEqual([
      { ok: true, text: 'snapshot done' },
      { ok: true, text: 'click done' },
    ]);
  });

  it('runs each command once even when two drains arrive together', async () => {
    const runs: string[] = [];
    const loop = createCommandLoop({
      run: async command => {
        runs.push(command.tool);
        return { ok: true };
      },
      post: async () => undefined,
      reload: () => undefined,
    });
    loop.enqueue([command('snapshot'), command('click')]);
    await Promise.all([loop.drain(), loop.drain()]);
    expect(runs).toEqual(['snapshot', 'click']);
  });

  it('aborts the call a cancel names while it is still running', async () => {
    const posted: Array<{ id: string; result: unknown }> = [];
    let aborted = false;
    const loop = createCommandLoop({
      run: (_command, signal) =>
        new Promise(resolve => {
          const timer = setTimeout(() => resolve({ ok: true, text: 'finished' }), 50);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            aborted = true;
            resolve({ ok: false, text: 'The call was cancelled.' });
          });
        }),
      post: async (command, result) => {
        posted.push({ id: command.id, result });
      },
      reload: () => undefined,
    });
    loop.enqueue([command('click')]);
    const drain = loop.drain();
    // The cancel arrives while the click is still in flight: the loop is busy with that call, so the queue is the only
    // place it can reach it.
    loop.enqueue([{ id: 'cancel-1', tool: 'cancel', args: { id: 'click-1' } }]);
    await drain;
    expect(aborted).toBe(true);
    expect(posted.map(entry => entry.id)).toEqual(['click-1', 'cancel-1']);
    expect(posted[0].result).toMatchObject({ ok: false });
    expect(posted[1].result).toEqual({ ok: true, text: 'cancelled' });
  });

  it('reloads only after the result is in', async () => {
    const order: string[] = [];
    const loop = createCommandLoop({
      run: async () => {
        order.push('run');
        return { ok: true };
      },
      post: async () => {
        order.push('post');
      },
      reload: () => order.push('reload'),
    });
    loop.enqueue([command('reload-extension')]);
    await loop.drain();
    expect(order).toEqual(['run', 'post', 'reload']);
  });
});
