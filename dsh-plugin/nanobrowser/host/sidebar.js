// The Host side of the DSH left-sidebar entry: one same-origin, authenticated summary the client page can poll, the
// files of one skill, and one action the user can take there: running a saved Browser Skill on the session that holds a
// tab lease. Chat, approvals and the skill's own write steps stay in the Chrome side panel; this page never bypasses
// them, and it never writes a skill file — a skill is edited where it lives, in an editor.

import { learnedSummary, listSkills, readKnowledge, readSkill, skillRoots } from '../core/skills.js';
import { runSkill } from '../core/run.js';

const MAX_BODY_BYTES = 16_384;

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('The request body is too large.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

/** The skill's parameters, as the form the sidebar renders. */
function paramList(skill) {
  return Object.entries(skill.recipe?.params ?? {}).map(([name, spec]) => ({
    name,
    type: String(spec?.type ?? 'string'),
    required: spec?.required !== false,
  }));
}

/** The session that holds a tab lease: a skill replay needs one, and the page never makes its own. */
function leasedSession(hub, wantedId) {
  const leases = hub.status().leases;
  const wanted = String(wantedId ?? '');
  const exact = wanted ? leases.find(lease => String(lease.clientId) === wanted) : undefined;
  const lease = exact ?? leases[0];
  return lease ? String(lease.clientId) : undefined;
}

export async function buildSummary(hub, settings) {
  const status = hub.status();
  let sessions = [];
  try {
    sessions = (await hub.chatService?.sessions?.()) ?? [];
  } catch {
    sessions = [];
  }
  const found = await listSkills(skillRoots(settings));
  // What each skill learned from its own failures: the page shows the count, the detail route shows the notes.
  const learned = await Promise.all(found.map(skill => readKnowledge(settings, skill.name)));
  const skills = found.map((skill, index) => ({
    name: skill.name,
    description: String(skill.description ?? '').slice(0, 240),
    ...(skill.whenToUse ? { whenToUse: String(skill.whenToUse).slice(0, 240) } : {}),
    steps: skill.recipe?.steps?.length ?? 0,
    params: paramList(skill),
    ...(skill.recipe?.origin ? { origin: skill.recipe.origin } : {}),
    ...(skill.recipe?.version !== undefined ? { version: skill.recipe.version } : {}),
    learned: learned[index].length,
  }));
  // The sidebar shows one tab per call; a session with several shows the one it was last given.
  const leaseTabs = new Map(status.leases.map(lease => [String(lease.clientId), lease.tabId ?? lease.tabs?.[0]]));
  const recent = hub.audit(undefined, 20).map(row => ({
    tool: row.tool,
    ok: row.ok,
    at: row.at,
    sessionId: row.clientId,
    ...(typeof row.ms === 'number' ? { ms: row.ms } : {}),
    ...(row.args ? { args: row.args } : {}),
    ...(row.text ? { text: row.text.slice(0, 160) } : {}),
    // The tab the call reported is exact; the session's current lease is the fallback for older rows.
    ...(Number.isInteger(row.tabId)
      ? { tabId: row.tabId }
      : leaseTabs.has(String(row.clientId))
        ? { tabId: leaseTabs.get(String(row.clientId)) }
        : {}),
  }));
  return {
    ok: true,
    generatedAt: Date.now(),
    hub: {
      connected: status.connected,
      port: status.port,
      clients: status.clients.length,
      leases: status.leases,
      pendingCalls: status.pendingCalls,
      queued: status.queued,
    },
    sessions: sessions.map(session => ({
      id: session.id,
      title: String(session.title ?? '').slice(0, 120),
      status: session.status,
      running: session.running === true,
    })),
    skills,
    recent,
  };
}

/** Everything the page shows when a skill is opened: its two files as they are, and what it learned. */
export async function skillDetail(settings, skill) {
  return {
    name: skill.name,
    dir: skill.dir,
    content: String(skill.content ?? ''),
    recipe: skill.recipe,
    params: paramList(skill),
    learned: learnedSummary(await readKnowledge(settings, skill.name)),
  };
}

/**
 * Runs a saved skill on the session that holds a tab lease. Returns the HTTP status and the body, so the route and a
 * test read the same answer: no lease and no skill are refusals, not a run with an empty result.
 */
export async function runSkillFromSidebar(hub, settings, body) {
  let skill;
  try {
    skill = await readSkill(skillRoots(settings), String(body.name ?? ''));
  } catch (error) {
    return { status: 404, body: { ok: false, error: String(error?.message ?? error) } };
  }
  const clientId = leasedSession(hub, body.sessionId);
  if (!clientId) {
    return {
      status: 409,
      body: { ok: false, error: 'No session holds a tab lease. Attach a tab in DSH first.' },
    };
  }
  const result = await runSkill(hub, clientId, settings, skill, {
    params: body.params ?? {},
    dryRun: body.dryRun === true,
    signal: AbortSignal.timeout(180_000),
  });
  return { status: 200, body: { ok: result?.ok !== false, clientId, result } };
}

/** One call, as the audit page shows it. */
function auditEntry(row) {
  return {
    callId: row.callId,
    at: row.at,
    sessionId: row.clientId,
    tool: row.tool,
    ok: row.ok,
    ...(typeof row.ms === 'number' ? { ms: row.ms } : {}),
    ...(Number.isInteger(row.tabId) ? { tabId: row.tabId } : {}),
    ...(row.args ? { args: row.args } : {}),
    ...(row.text ? { text: String(row.text).slice(0, 240) } : {}),
  };
}

/** The audit, filtered the way the page asks: one session, one tab, or everything; oldest first, as a timeline. */
export function auditRows(hub, { sessionId = '', tabId = '', limit = 100 } = {}) {
  const session = String(sessionId ?? '');
  const tab = Number(tabId);
  return hub
    .audit(session || undefined, Number(limit) || 100)
    .filter(row => (Number.isInteger(tab) && tab > 0 ? Number(row.tabId) === tab : true))
    .map(auditEntry);
}

/** A cell a spreadsheet reads as text: one that starts with `=`, `+`, `-` or `@` would be read as a formula. */
function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The filtered calls as CSV: what a user takes away to read in a spreadsheet. */
export function auditCsv(rows) {
  const lines = [['at', 'time', 'session', 'tab', 'tool', 'ok', 'ms', 'args', 'text'].join(',')];
  for (const row of rows) {
    lines.push(
      [
        new Date(row.at).toISOString(),
        new Date(row.at).toLocaleString(),
        row.sessionId ?? '',
        row.tabId ?? '',
        row.tool ?? '',
        row.ok === true ? 'ok' : row.ok === false ? 'failed' : 'unknown',
        row.ms ?? '',
        row.args ? JSON.stringify(row.args) : '',
        row.text ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

function json(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

export function registerSidebarRoute(ctx, hub, settings) {
  const guard = (req, res) => {
    const rejection = ctx.connection?.requestRejection?.(req);
    if (rejection !== undefined) {
      res.statusCode = rejection;
      res.end();
      return false;
    }
    return true;
  };

  const summary = ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/nanobrowser/summary',
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' });
        try {
          json(res, 200, await buildSummary(hub, settings));
        } catch (error) {
          json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }),
  );

  // One skill's files, read on demand: the summary is polled every few seconds and must stay small.
  const detail = ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/nanobrowser/skill',
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' });
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const name = url.searchParams.get('name') ?? '';
        try {
          const skill = await readSkill(skillRoots(settings), name);
          json(res, 200, { ok: true, ...(await skillDetail(settings, skill)) });
        } catch (error) {
          json(res, 404, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }),
  );

  const run = ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/nanobrowser/skill/run',
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
        try {
          const { status, body } = await runSkillFromSidebar(hub, settings, await readBody(req));
          json(res, status, body);
        } catch (error) {
          json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }),
  );

  // The audit trail: the whole retained history, filtered, and the same rows as a CSV download.
  const audit = ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/nanobrowser/audit',
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' });
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        try {
          const rows = auditRows(hub, {
            sessionId: url.searchParams.get('session') ?? '',
            tabId: url.searchParams.get('tab') ?? '',
            limit: url.searchParams.get('limit') ?? '100',
          });
          if (url.searchParams.get('format') === 'csv') {
            // The page fetches this, so the download keeps the same guard as every other read here.
            res.statusCode = 200;
            res.setHeader('content-type', 'text/csv; charset=utf-8');
            res.setHeader('content-disposition', 'attachment; filename="nanobrowser-audit.csv"');
            res.setHeader('cache-control', 'no-store');
            res.end(auditCsv(rows));
            return;
          }
          json(res, 200, { ok: true, rows });
        } catch (error) {
          json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }),
  );

  return () => {
    run();
    detail();
    audit();
    summary();
  };
}
