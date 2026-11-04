// The sidebar's host: what the page polls, what it can open, and what running a skill from there does. The client is
// presentation; the answers it renders are decided here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordFailure, readSkill, writeSkill } from '../core/skills.js';
import { resolveConfig } from '../core/config.js';
import { auditCsv, auditRows, buildSummary, runSkillFromSidebar, skillDetail } from '../host/sidebar.js';

const recipe = {
  name: 'find-order',
  description: 'Look an order up',
  origin: 'https://example.test',
  params: { orderNo: { type: 'string', required: true } },
  steps: [
    { id: 'find', tool: 'click', target: { role: 'button', name: '查询' } },
    { id: 'wait', tool: 'wait', args: { text: '结果' } },
  ],
  assert: [],
};

/** A hub with one session holding tab 5, answering the calls a replay makes. */
function fakeHub({ leases = [{ clientId: 's1', tabId: 5, tabs: [5] }] } = {}) {
  const calls = [];
  return {
    calls,
    status: () => ({
      connected: true,
      port: 8790,
      clients: [{ clientId: 's1' }],
      leases,
      pendingCalls: 0,
      queued: 0,
    }),
    // Like the hub's: newest kept, one client at a time when asked.
    audit: (clientId, limit = 20) => {
      const rows = [
        {
          callId: 'c1',
          tool: 'click',
          ok: true,
          at: 1_700_000_000_000,
          clientId: 's1',
          ms: 12,
          tabId: 5,
          args: { name: '查询' },
          text: 'click ok',
        },
        {
          callId: 'c2',
          tool: 'snapshot',
          ok: false,
          at: 1_700_000_001_000,
          clientId: 's2',
          ms: 7,
          tabId: 6,
          text: 'error NO_MATCH',
        },
        {
          callId: 'c3',
          tool: 'click',
          ok: false,
          at: 1_700_000_002_000,
          clientId: 's1',
          ms: 9,
          tabId: 6,
          args: { name: '提交' },
          text: 'error OBSCURED',
        },
      ];
      return (clientId ? rows.filter(row => row.clientId === clientId) : rows).slice(-limit);
    },
    chatService: { sessions: async () => [{ id: 's1', title: 'Look up an order', status: 'idle' }] },
    ownedTabId: clientId => (clientId === 's1' ? 5 : null),
    async call(_clientId, tool, args) {
      calls.push({ tool, args });
      if (tool === 'tabs') return { ok: true, text: '* tab 5 · «订单» · «https://example.test/quote»' };
      if (tool === 'say') return { ok: true, text: 'shown in the side panel' };
      if (tool === 'find') return { ok: true, text: '1 match' };
      return { ok: true, text: `${tool} ok`, receipt: { sensitive: null } };
    },
  };
}

/** A skills directory with one saved skill, and one failure it learned from. */
async function savedSkill(t) {
  const skillsDir = await mkdtemp(join(tmpdir(), 'nb-sidebar-'));
  t.after(() => rm(skillsDir, { recursive: true, force: true }));
  const settings = resolveConfig({ skillsDir });
  await writeSkill(skillsDir, recipe);
  await recordFailure(
    settings,
    'find-order',
    { code: 'NO_MATCH', stepId: 'find', message: 'No element matches.' },
    { url: 'https://example.test/quote' },
  );
  return { skillsDir, settings };
}

test('the summary lists what a page can run, and how much each skill learned', async t => {
  const { skillsDir, settings } = await savedSkill(t);
  const summary = await buildSummary(fakeHub(), settings);

  assert.equal(summary.ok, true);
  assert.equal(summary.hub.connected, true);
  assert.equal(summary.hub.leases.length, 1);
  assert.deepEqual(summary.sessions, [{ id: 's1', title: 'Look up an order', status: 'idle', running: false }]);

  assert.equal(summary.skills.length, 1);
  const skill = summary.skills[0];
  assert.equal(skill.name, 'find-order');
  assert.equal(skill.description, 'Look an order up');
  assert.equal(skill.steps, 2);
  assert.deepEqual(skill.params, [{ name: 'orderNo', type: 'string', required: true }]);
  assert.equal(skill.origin, 'https://example.test');
  // The failure this skill learned from is counted here, and written out by the detail route.
  assert.equal(skill.learned, 1);

  // A recent call shows the tab its session holds, so the user can tell which page it was.
  assert.equal(summary.recent[0].tool, 'click');
  assert.equal(summary.recent[0].tabId, 5);
  assert.equal(summary.recent[0].text, 'click ok');
});

test('a summary without a chat service still answers, with no sessions', async t => {
  const { settings } = await savedSkill(t);
  const hub = fakeHub();
  hub.chatService = { sessions: async () => Promise.reject(new Error('no chat here')) };
  const summary = await buildSummary(hub, settings);
  assert.deepEqual(summary.sessions, []);
  assert.equal(summary.skills.length, 1);
});

test('one skill opens with both files, its parameters, and what it learned', async t => {
  const { skillsDir, settings } = await savedSkill(t);
  const detail = await skillDetail(settings, await readSkill(skillsDir, 'find-order'));

  assert.equal(detail.name, 'find-order');
  assert.equal(detail.dir, join(skillsDir, 'find-order'));
  assert.match(detail.content, /find-order/);
  assert.equal(detail.recipe.steps.length, 2);
  assert.deepEqual(detail.params, [{ name: 'orderNo', type: 'string', required: true }]);
  assert.equal(detail.learned.length, 1);
  assert.match(detail.learned[0], /^NO_MATCH at step find · 1×/);
});

test('running from the sidebar refuses a skill that is not there, and a session with no lease', async t => {
  const { settings } = await savedSkill(t);
  const missing = await runSkillFromSidebar(fakeHub(), settings, { name: 'no-such-skill' });
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /no-such-skill/);

  const nobody = fakeHub({ leases: [] });
  const refused = await runSkillFromSidebar(nobody, settings, { name: 'find-order', params: { orderNo: '1001' } });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /lease/i);
  // Nothing was dispatched without a tab to dispatch it to.
  assert.equal(nobody.calls.length, 0);
});

test('a run replays the steps on the leased session, and a dry run resolves instead of clicking', async t => {
  const { settings } = await savedSkill(t);
  const hub = fakeHub();
  const done = await runSkillFromSidebar(hub, settings, { name: 'find-order', params: { orderNo: '1001' } });

  assert.equal(done.status, 200);
  assert.equal(done.body.ok, true);
  assert.equal(done.body.clientId, 's1');
  assert.deepEqual(
    done.body.result.data.steps.map(step => step.id),
    ['find', 'wait'],
  );
  assert.ok(hub.calls.some(call => call.tool === 'click'));

  // A dry run is the same recipe without touching the page: the target is resolved, not clicked.
  const dryHub = fakeHub();
  const dry = await runSkillFromSidebar(dryHub, settings, {
    name: 'find-order',
    params: { orderNo: '1001' },
    dryRun: true,
  });
  assert.equal(dry.body.result.data.dryRun, true);
  assert.equal(dryHub.calls.filter(call => call.tool === 'click').length, 0);
  assert.ok(dryHub.calls.some(call => call.tool === 'find'));
});

test('the audit can be read one session or one tab at a time', async t => {
  const { settings } = await savedSkill(t);
  const hub = fakeHub();

  const all = auditRows(hub);
  assert.deepEqual(
    all.map(row => row.callId),
    ['c1', 'c2', 'c3'],
  );
  assert.equal(all[0].tabId, 5);
  assert.equal(all[0].sessionId, 's1');

  // One session: the hub filters, so another client's calls never appear.
  assert.deepEqual(
    auditRows(hub, { sessionId: 's1' }).map(row => row.callId),
    ['c1', 'c3'],
  );
  // One tab: only the calls that reported it.
  assert.deepEqual(
    auditRows(hub, { tabId: '6' }).map(row => row.callId),
    ['c2', 'c3'],
  );
  // Both, and a limit keeps the newest.
  assert.deepEqual(
    auditRows(hub, { sessionId: 's1', tabId: '6' }).map(row => row.callId),
    ['c3'],
  );
  assert.deepEqual(
    auditRows(hub, { limit: '2' }).map(row => row.callId),
    ['c2', 'c3'],
  );
  // A tab nothing ran on is a filter, not an error.
  assert.deepEqual(auditRows(hub, { tabId: '99' }), []);
  void settings;
});

test('the CSV is text a spreadsheet can read, and a formula stays text', () => {
  const rows = [
    {
      callId: 'c1',
      at: Date.UTC(2026, 10, 4, 6, 0, 0),
      sessionId: 's1',
      tabId: 5,
      tool: 'click',
      ok: true,
      ms: 12,
      args: { name: '查询, 提交' },
      text: 'click ok',
    },
    {
      callId: 'c2',
      at: Date.UTC(2026, 10, 4, 6, 1, 0),
      sessionId: 's2',
      tool: 'read',
      ok: false,
      args: {},
      text: '=HYPERLINK("http://evil.test")',
    },
  ];
  const csv = auditCsv(rows);
  const lines = csv.trimEnd().split('\n');
  assert.equal(lines[0], 'at,time,session,tab,tool,ok,ms,args,text');
  // A comma and a quote in the arguments stay inside one cell.
  assert.match(lines[1], /"\{""name"":""查询, 提交""\}"/);
  // A value that looks like a formula is prefixed so a spreadsheet keeps it as text.
  assert.ok(lines[2].includes(`"'=HYPERLINK(""http://evil.test"")"`), lines[2]);
  assert.equal(auditCsv([]).trimEnd(), 'at,time,session,tab,tool,ok,ms,args,text');
});
