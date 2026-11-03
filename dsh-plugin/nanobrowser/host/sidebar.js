// The Host side of the DSH left-sidebar entry: one same-origin, authenticated summary the client page can poll, and
// one action the user can take there: running a saved Browser Skill on the session that holds a tab lease.
// Chat, approvals and the skill's own write steps stay in the Chrome side panel; this page never bypasses them.

import { listSkills, readSkill } from '../core/skills.js';
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

async function buildSummary(hub, settings) {
  const status = hub.status();
  let sessions = [];
  try {
    sessions = (await hub.chatService?.sessions?.()) ?? [];
  } catch {
    sessions = [];
  }
  const skills = (await listSkills(settings.skillsDir)).map(skill => ({
    name: skill.name,
    description: String(skill.description ?? '').slice(0, 240),
    ...(skill.whenToUse ? { whenToUse: String(skill.whenToUse).slice(0, 240) } : {}),
    steps: skill.recipe?.steps?.length ?? 0,
    params: paramList(skill),
    ...(skill.recipe?.origin ? { origin: skill.recipe.origin } : {}),
    ...(skill.recipe?.version !== undefined ? { version: skill.recipe.version } : {}),
  }));
  const leaseTab = new Map(status.leases.map(lease => [String(lease.clientId), lease.tabId]));
  const recent = hub.audit(undefined, 20).map(row => ({
    tool: row.tool,
    ok: row.ok,
    at: row.at,
    sessionId: row.clientId,
    ...(typeof row.ms === 'number' ? { ms: row.ms } : {}),
    ...(row.args ? { args: row.args } : {}),
    ...(row.text ? { text: row.text.slice(0, 160) } : {}),
    ...(leaseTab.has(String(row.clientId)) ? { tabId: leaseTab.get(String(row.clientId)) } : {}),
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

  const run = ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/nanobrowser/skill/run',
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
        try {
          const body = await readBody(req);
          const skill = await readSkill(settings.skillsDir, String(body.name ?? ''));
          const clientId = leasedSession(hub, body.sessionId);
          if (!clientId) {
            return json(res, 409, { ok: false, error: 'No session holds a tab lease. Attach a tab in DSH first.' });
          }
          const result = await runSkill(hub, clientId, settings, skill, {
            params: body.params ?? {},
            signal: AbortSignal.timeout(180_000),
          });
          json(res, 200, { ok: result?.ok !== false, clientId, result });
        } catch (error) {
          json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }),
  );

  return () => {
    run();
    summary();
  };
}
