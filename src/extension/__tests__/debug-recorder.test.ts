import { describe, expect, it } from 'vitest';
import type { Controller, TabAttachment } from '@src/browser-control';
import { DebugRecorder } from '../debug-recorder';

type Handler = (params: unknown, sessionId?: string) => void;

/** A controller whose attach() hands back a fake tab CDP port that the test drives with recorded payloads. */
function setup() {
  const handlers = new Map<string, Handler[]>();
  const sends: string[] = [];
  const subscriptions: Array<{ method: string; only?: { sessionId: string | undefined } }> = [];

  function attachmentFor(tabId: number): TabAttachment {
    const cdp = {
      tabId,
      send: async (_sessionId: string | undefined, method: string) => {
        sends.push(method);
        return {};
      },
      on: (method: string, handler: Handler, only?: { sessionId: string | undefined }) => {
        subscriptions.push(only === undefined ? { method } : { method, only });
        const list = handlers.get(method) ?? [];
        list.push(handler);
        handlers.set(method, list);
        return () => {
          const current = handlers.get(method) ?? [];
          const index = current.indexOf(handler);
          if (index >= 0) current.splice(index, 1);
        };
      },
    };
    return {
      tabId,
      cdp,
      topology: {},
      page: {},
      detached: null,
      onDetach: () => () => undefined,
      close: async () => undefined,
    } as unknown as TabAttachment;
  }

  const controller = {
    attach: async (tabId: number) => attachmentFor(tabId),
  } as unknown as Controller;

  const emit = (method: string, params: unknown) => {
    for (const handler of handlers.get(method) ?? []) handler(params, undefined);
  };

  return { recorder: new DebugRecorder(controller), emit, sends, subscriptions };
}

describe('DebugRecorder', () => {
  it('turns console calls, browser log entries and uncaught errors into readable lines', async () => {
    const { recorder, emit } = setup();
    await recorder.ensure(7);

    emit('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'string', value: 'ready' }],
      stackTrace: { callFrames: [{ url: 'https://example.test/app.js' }] },
    });
    emit('Runtime.consoleAPICalled', {
      type: 'warning',
      args: [{ type: 'object', description: 'Object', preview: { properties: [{ name: 'rows', value: '3' }] } }],
    });
    emit('Log.entryAdded', {
      entry: {
        source: 'network',
        level: 'error',
        text: 'Failed to load resource: net::ERR_FAILED',
        url: 'https://x.test/a.js',
      },
    });
    emit('Runtime.exceptionThrown', {
      exceptionDetails: {
        text: 'Uncaught',
        url: 'https://example.test/app.js',
        lineNumber: 41,
        exception: { description: 'Error: boom\n    at run (https://example.test/app.js:42:9)' },
      },
    });

    expect(recorder.readConsole({})).toBe(
      [
        '[log] ready (https://example.test/app.js)',
        '[warning] { rows: 3 }',
        '[error] [network] Failed to load resource: net::ERR_FAILED (https://x.test/a.js)',
        '[error] Error: boom\n    at run (https://example.test/app.js:42:9)',
      ].join('\n'),
    );
  });

  it('adds the location to an error message that does not name it', async () => {
    const { recorder, emit } = setup();
    await recorder.ensure(7);

    emit('Runtime.exceptionThrown', {
      exceptionDetails: { text: 'Uncaught', url: 'https://example.test/app.js', lineNumber: 0 },
    });

    expect(recorder.readConsole({})).toBe('[error] Uncaught (https://example.test/app.js:1)');
  });

  it('filters by level and clears what it has read', async () => {
    const { recorder, emit } = setup();
    await recorder.ensure(7);

    emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'one' }] });
    emit('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'two' }] });

    expect(recorder.readConsole({ level: 'error' })).toBe('[error] two');
    expect(recorder.readConsole({ clear: true })).toBe('[log] one\n[error] two');
    expect(recorder.readConsole({})).toBe('(no console messages)');
  });

  it('records requests with status, then failures, and filters them', async () => {
    const { recorder, emit } = setup();
    await recorder.ensure(7);

    emit('Network.requestWillBeSent', {
      requestId: '1',
      request: { url: 'https://api.test/ok', method: 'POST' },
      type: 'Fetch',
    });
    emit('Network.responseReceived', {
      requestId: '1',
      response: { url: 'https://api.test/ok', status: 201 },
      type: 'Fetch',
    });
    emit('Network.requestWillBeSent', {
      requestId: '2',
      request: { url: 'https://api.test/broken', method: 'GET' },
      type: 'XHR',
    });
    emit('Network.loadingFailed', { requestId: '2', errorText: 'net::ERR_CONNECTION_REFUSED' });
    emit('Network.loadingFailed', { requestId: '3', canceled: true });

    expect(recorder.readNetwork({})).toBe(
      [
        '201 POST https://api.test/ok (Fetch)',
        'FAILED net::ERR_CONNECTION_REFUSED GET https://api.test/broken (XHR)',
      ].join('\n'),
    );
    expect(recorder.readNetwork({ failedOnly: true, filter: 'broken' })).toBe(
      'FAILED net::ERR_CONNECTION_REFUSED GET https://api.test/broken (XHR)',
    );
    expect(recorder.readNetwork({ filter: 'api.test/ok' })).toBe('201 POST https://api.test/ok (Fetch)');
  });

  it('keeps a response whose request started before the recorder attached', async () => {
    const { recorder, emit } = setup();
    await recorder.ensure(7);

    emit('Network.responseReceived', {
      requestId: '9',
      response: { url: 'https://cdn.test/a.js', status: 200 },
      type: 'Script',
    });

    expect(recorder.readNetwork({})).toBe('200 ? https://cdn.test/a.js (Script)');
  });

  it('subscribes on the tab root session only and enables the three domains', async () => {
    const { recorder, sends, subscriptions } = setup();
    await recorder.ensure(7);

    expect(sends).toEqual(['Runtime.enable', 'Log.enable', 'Network.enable']);
    expect(subscriptions.every(s => s.only?.sessionId === undefined)).toBe(true);
  });

  it('keeps the buffer on the same tab and drops it when the tab changes', async () => {
    const { recorder, emit } = setup();
    await recorder.ensure(7);
    emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'first' }] });

    await recorder.ensure(7);
    expect(recorder.readConsole({})).toBe('[log] first');

    await recorder.ensure(8);
    expect(recorder.readConsole({})).toBe('(no console messages)');
  });
});
