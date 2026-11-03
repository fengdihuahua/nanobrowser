#!/usr/bin/env node
// A smoke run of the Hub path: this process is a client (like DSH or an MCP host), the extension polls the same Hub,
// and the calls go through it to a real tab. It checks that the pieces are wired, not what a page says.
//
//   node fixtures/hub-smoke.mjs [--port 8790] [--token dev-token] [--url <page>] [--keep-lease]
//
// It needs a running Hub with the extension connected: DSH with the Nanobrowser plugin open, or the MCP adapter.
// It uses a tab the session already has, or opens one (by default the fixture server's page) and closes it again.
// Exit code 0 when every step passes.

import process from 'node:process';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const PORT = Number(option('--port', process.env.NANOBROWSER_BRIDGE_PORT ?? 8790));
const TOKEN = option('--token', process.env.NANOBROWSER_BRIDGE_TOKEN ?? 'dev-token');
const KEEP_LEASE = argv.includes('--keep-lease');
const PAGE = option('--url', 'http://127.0.0.1:8787/c-effects.html');
const BASE = `http://127.0.0.1:${PORT}`;
const CLIENT_ID = `smoke:${process.pid}`;

const started = Date.now();
let failures = 0;

function line(ok, name, detail) {
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` · ${detail}` : ''} (${seconds}s)`);
  if (!ok) failures += 1;
}

async function call(path, { method = 'POST', body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-nanobrowser-token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${path}: not JSON (${response.status}): ${text.slice(0, 160)}`);
  }
  if (!response.ok) throw new Error(`${path}: ${response.status} ${json.error ?? text.slice(0, 160)}`);
  return json;
}

/** One tool call through the Hub, which routes it to the extension's session for this client. */
async function tool(name, args = {}) {
  const answer = await call('/client/call', { body: { clientId: CLIENT_ID, tool: name, args } });
  if (answer.ok === false) throw new Error(`${name}: ${answer.error ?? 'failed'}`);
  const result = answer.result ?? {};
  if (result.ok === false) throw new Error(`${name}: ${result.error?.code ?? 'failed'} ${result.error?.message ?? ''}`);
  return result;
}

const short = (value, max = 70) => {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

async function main() {
  console.log(`hub smoke · ${BASE} · client ${CLIENT_ID}`);

  let registered;
  try {
    registered = await call('/client/register', { body: { clientId: CLIENT_ID, kind: 'smoke' } });
    const hub = registered.hub ?? {};
    line(true, 'register', `connected ${hub.connected ? 'yes' : 'NO'} · clients ${hub.clients?.length ?? '?'}`);
    if (!hub.connected) throw new Error('the extension is not polling this hub');
  } catch (error) {
    line(false, 'register', short(error.message));
    return;
  }

  let openedTabId;
  try {
    const tabs = await tool('tabs', { action: 'list' });
    const list = tabs.data?.tabs ?? [];
    if (list.length === 0) {
      const openedTab = await tool('tabs', { action: 'open', url: PAGE });
      openedTabId = openedTab.data?.tabId ?? openedTab.data?.tab?.tabId;
      line(true, 'open tab', short(PAGE));
    } else {
      line(true, 'tabs', `${list.length} tab${list.length === 1 ? '' : 's'} · ${short(list[0].title, 40)}`);
    }

    const shot = await tool('snapshot');
    line(true, 'snapshot', short(shot.text ?? '', 70));

    const logs = await tool('console');
    const messages = logs.data?.messages ?? [];
    line(true, 'console', `${Array.isArray(messages) ? messages.length : 0} messages`);

    const network = await tool('network');
    const requests = network.data?.requests ?? [];
    line(true, 'network', `${Array.isArray(requests) ? requests.length : 0} requests`);
  } catch (error) {
    line(false, 'tool call', short(error.message, 120));
  } finally {
    if (openedTabId !== undefined) {
      await tool('tabs', { action: 'close', tabId: openedTabId }).catch(() => undefined);
    }
    if (!KEEP_LEASE) {
      try {
        await call('/client/lease', { method: 'DELETE', body: { clientId: CLIENT_ID } });
        line(true, 'release lease', 'tab handed back');
      } catch {
        // Nothing to release, or an older hub without the endpoint; the smoke result does not depend on it.
      }
    }
  }
}

await main();
console.log(failures ? `\n${failures} step(s) failed` : '\nall steps passed');
process.exit(failures ? 1 : 0);
