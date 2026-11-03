// The DSH side of Nanobrowser.
//
// It embeds the browser hub, registers the browser tools the model calls, and (in later phases) adds tab leases,
// prompt context, approvals, the side-panel chat and Browser Skills. The MCP adapter speaks the same hub, so a
// tool recorded through one surface can be replayed through the other.

import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { Hub } from './core/hub.js';
import { TOOLS } from './core/tools.js';
import { resolveConfig } from './core/config.js';
import { registerSkillProvider, registerSkillTools } from './host/skills.js';
import { registerBrowserPrompt } from './host/prompt.js';
import { registerChat } from './host/chat.js';
import { registerApprovals } from './host/approvals.js';
import { registerSidebarRoute } from './host/sidebar.js';
import { registerLeaseGuard } from './host/lease-guard.js';
import { registerUserSteps } from './host/user-step.js';

export const name = 'nanobrowser';
export const inject = ['tools', 'skills', 'systemPrompt', 'agents', 'webServer', 'connection'];

const OUTPUT = {
  schema: {
    type: 'object',
    properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
    required: ['ok', 'text'],
    additionalProperties: false,
  },
  render(_args, value) {
    return [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }];
  },
};

const ACTIVE_TAB = /\*\s+tab\s+(\d+)\s+·\s+«(.*?)»\s+·\s+«(.*?)»/;

function parseActiveTab(text) {
  const match = ACTIVE_TAB.exec(String(text ?? ''));
  return match ? { tabId: Number(match[1]), title: match[2], url: match[3] } : undefined;
}

function statusText(status) {
  return `browser hub · ${status.connected ? 'connected' : 'disconnected'} · port ${status.port} · clients ${status.clients.length} · leases ${status.leases.length} · pending ${status.pendingCalls}`;
}

export function apply(ctx, config) {
  const workspace = ctx.get?.('workingDirectory')?.defaultDirectory;
  const settings = resolveConfig({
    ...(config ?? {}),
    ...(config?.skillsDir === undefined && workspace ? { skillsDir: join(workspace, 'skills', 'browser') } : {}),
  });
  const hub = new Hub({
    port: settings.port,
    token: settings.token,
    callTimeoutMs: settings.callTimeoutMs,
    logger: ctx.logger,
  });

  ctx.effect(() => {
    const controller = new AbortController();
    void hub.start({ signal: controller.signal }).catch(error => {
      if (controller.signal.aborted) return;
      ctx.logger?.error?.('[nanobrowser] hub failed to start:', error?.message ?? String(error));
    });
    return () => {
      controller.abort();
      void hub.stop();
    };
  });

  ctx.effect(() => registerChat(ctx, hub, settings));
  ctx.effect(() => registerApprovals(ctx, hub, settings));
  ctx.effect(() => registerLeaseGuard(ctx, hub));
  ctx.effect(() => registerUserSteps(ctx, hub, settings));
  registerSidebarRoute(ctx, hub, settings);

  ctx.effect(() => {
    const disposers = [];
    const define = definition => disposers.push(ctx.tools.register(definition));
    for (const tool of TOOLS) define(browserTool(ctx, hub, tool));
    define(statusTool(hub));
    define(attachTool(hub));
    define(detachTool(hub));
    define(auditTool(hub));
    disposers.push(registerSkillTools(ctx, hub, settings));
    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  });

  ctx.effect(() => {
    const provider = registerSkillProvider(ctx, settings);
    settings.invalidate = provider.invalidate;
    return () => {
      settings.invalidate = undefined;
      provider.dispose();
    };
  });

  ctx.effect(() => registerBrowserPrompt(ctx, hub));
}

/** One model-facing tool over the hub. The extension names stay unprefixed on the wire. */
function browserTool(ctx, hub, tool) {
  const projections = new WeakMap();
  return {
    name: `nanobrowser_${tool.name}`,
    description: tool.description,
    parameters: tool.inputSchema,
    output: OUTPUT,
    async execute(args, exec) {
      const clientId = exec.agent?.id ?? 'dsh:unscoped';
      hub.registerClient({ clientId, kind: 'dsh', sessionId: exec.agent?.id ?? null });
      const result = await hub.call(clientId, tool.name, args ?? {}, { signal: exec.signal });
      if (!result || result.ok === false) {
        throw new Error(typeof result?.text === 'string' ? result.text : 'The browser tool failed.');
      }
      const text = typeof result.text === 'string' ? result.text : JSON.stringify(result);
      if (tool.name === 'screenshot' && result.data?.base64) {
        const image = await screenshotImage(ctx, exec, result.data);
        if (image) projections.set(exec, { value: { ok: true, text }, content: image });
      }
      return { ok: true, text };
    },
    projectContent(exec, result) {
      const projection = projections.get(exec);
      if (!projection) return undefined;
      projections.delete(exec);
      if (result.isError) return undefined;
      if (!isDeepStrictEqual(result.value, projection.value)) return undefined;
      return [{ type: 'text', text: projection.value.text }, ...projection.content];
    },
  };
}

/**
 * Turn a screenshot into durable image content when the active model accepts images. The receipt stays as text in
 * front of the image, so the model sees what was captured even when the image is not admitted.
 */
async function screenshotImage(ctx, exec, data) {
  const attachments = ctx.get('attachments');
  const llm = ctx.get('llm');
  if (!attachments || !llm) return undefined;
  const agent = exec.agent;
  const routed = agent?.session?.requestHeader?.()?.config;
  const provider = routed?.provider ?? agent?.options?.provider;
  const model = routed?.model ?? agent?.options?.model;
  if (!provider || !model) return undefined;
  let info;
  try {
    info = await llm.resolveModelInfo(provider, model, exec.signal);
  } catch {
    return undefined;
  }
  if (!info?.inputModalities?.includes('image')) return undefined;
  try {
    const mediaType = data.mimeType ?? 'image/png';
    const [ref] = await attachments.saveImages([{ data: Buffer.from(String(data.base64), 'base64'), mediaType }]);
    if (!ref) return undefined;
    return [{ type: 'image', attachment: ref }];
  } catch {
    return undefined;
  }
}

function statusTool(hub) {
  return {
    name: 'nanobrowser_status',
    description: 'Show the browser hub connection, registered clients and tab leases.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: OUTPUT,
    async execute() {
      return { ok: true, text: statusText(hub.status()) };
    },
  };
}

function attachTool(hub) {
  return {
    name: 'nanobrowser_attach',
    description:
      'Attach this session to a tab. Pass tabId for an exact tab, url to open a new one, or neither to take an unleased normal tab. A tab leased by another client is refused.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', minimum: 1, description: 'The tab to attach to' },
        url: { type: 'string', description: 'Open this URL in a new tab and attach to it' },
      },
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args, exec) {
      const clientId = exec.agent?.id ?? 'dsh:unscoped';
      hub.registerClient({ clientId, kind: 'dsh', sessionId: exec.agent?.id ?? null });
      if (args?.tabId !== undefined && args?.url !== undefined) {
        throw new Error('Pass tabId or url, not both.');
      }
      const available = tab => {
        const owner = hub.ownerOf(tab.tabId);
        return !owner || owner.clientId === clientId;
      };
      let tabId = args?.tabId;
      let opened = false;
      if (tabId === undefined && typeof args?.url === 'string' && args.url.trim()) {
        const open = await hub.call(clientId, 'tabs', { action: 'open', url: args.url }, { signal: exec.signal });
        if (!open || open.ok === false) {
          throw new Error(typeof open?.text === 'string' ? open.text : 'Could not open the tab.');
        }
        const listed = await hub.call(clientId, 'tabs', { action: 'list' }, { signal: exec.signal });
        const active = parseActiveTab(listed?.text);
        if (!active) throw new Error('The new tab did not become active.');
        tabId = active.tabId;
        opened = true;
      } else if (tabId === undefined) {
        const all = await hub.call(clientId, 'tabs-all', {}, { signal: exec.signal });
        if (!all || all.ok === false) {
          throw new Error(typeof all?.text === 'string' ? all.text : 'Could not list Chrome tabs.');
        }
        const tabs = Array.isArray(all.data?.tabs) ? all.data.tabs : [];
        const free = tabs.find(tab => tab.active && available(tab)) ?? tabs.find(available);
        if (!free) {
          throw new Error('Every normal tab is leased by another session; pass tabId, or pass url to open a new tab.');
        }
        tabId = free.tabId;
      } else if (!available({ tabId })) {
        const owner = hub.ownerOf(tabId);
        throw new Error(`Tab ${tabId} is already leased by ${owner?.clientId ?? 'another client'}.`);
      }
      if (!opened) {
        const attached = await hub.call(clientId, 'attach', { tabId }, { signal: exec.signal });
        if (!attached || attached.ok === false) {
          throw new Error(typeof attached?.text === 'string' ? attached.text : 'Could not attach to the tab.');
        }
      }
      const current = hub.leaseOf(clientId);
      if (current && current.tabId !== tabId) hub.releaseLease(clientId);
      const lease = hub.acquireLease(clientId, { tabId, sessionId: exec.agent?.id ?? null, kind: 'dsh' });
      if (!lease.ok) {
        if (lease.reason === 'tab-leased') {
          throw new Error(`Tab ${tabId} is already leased by ${lease.owner?.clientId ?? 'another client'}.`);
        }
        throw new Error(`Could not attach to tab ${tabId}: ${lease.reason ?? 'unknown reason'}`);
      }
      return { ok: true, text: `Attached this session to tab ${tabId}.` };
    },
  };
}

function detachTool(hub) {
  return {
    name: 'nanobrowser_detach',
    description: "Release this session's browser tab lease.",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: OUTPUT,
    async execute(_args, exec) {
      const clientId = exec.agent?.id ?? 'dsh:unscoped';
      const released = hub.releaseLease(clientId);
      return { ok: true, text: released ? 'Detached from the tab.' : 'This session had no tab lease.' };
    },
  };
}

function auditTool(hub) {
  return {
    name: 'nanobrowser_audit',
    description: "Show this session's recent browser calls with their outcome and time.",
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many calls to show' } },
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args, exec) {
      const clientId = exec.agent?.id;
      const limit = Math.max(1, Math.min(50, Number(args?.limit ?? 20)));
      const rows = hub.audit(clientId, limit);
      if (rows.length === 0) return { ok: true, text: 'No browser calls in this session yet.' };
      const lines = rows.map(row => {
        const mark = row.ok === false ? '✗' : row.ok === true ? '✓' : '…';
        return `${mark} ${row.tool} · ${new Date(row.at).toLocaleTimeString()}`;
      });
      return { ok: true, text: lines.join('\n') };
    },
  };
}
