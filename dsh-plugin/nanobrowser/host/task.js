// Starting a task from the browser. The extension has no brain of its own: it asks the hub for a task, and the plugin
// creates a DSH session for it, takes the tab it came from, and sends the page with the first message. The session then
// appears in DSH's list like any other and can be continued there.

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { buildPageContext } from './chat.js';

/** A refusal the route can turn into a status and a sentence. `owner` names whoever holds a tab that was asked for. */
function refusal(status, message, owner) {
  const error = new Error(message);
  error.status = status;
  if (owner) error.owner = owner;
  return error;
}

export function registerTasks(ctx, hub, settings) {
  /** Every session this plugin created, so unloading it tears them down instead of leaving them to the worker. */
  const handles = new Set();
  hub.setTaskService({
    /**
     * Creates one task: an id, a tab, a session, a first message. The tab is taken before the session exists, so a tab
     * another client owns fails with nothing created; a session created but not started is torn down again.
     */
    async create({ text, tabId, includePage = true, model: route, cwd: askedCwd } = {}) {
      const trimmed = String(text ?? '').trim();
      if (!trimmed) throw refusal(400, 'The task text is empty.');
      const id = Number(tabId);
      if (!Number.isInteger(id) || id <= 0) throw refusal(400, 'tabId must be a positive integer.');
      if (typeof ctx.agents?.create !== 'function') {
        throw refusal(503, 'This DSH has no agent factory, so a session cannot be created.');
      }
      // The model is the deployment's default: a task started from a page has no model picker.
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
      // A caller may name its own route ("provider/model"); otherwise the deployment's default is the model.
      const asked = String(route ?? '');
      const [askedProvider, askedModel] = asked.includes('/') ? asked.split('/', 2) : ['', ''];
      const provider = askedProvider || String(selection?.provider ?? '');
      const model = askedModel || String(selection?.model ?? '');
      if (!provider || !model) {
        throw refusal(409, 'DSH has no default model selected. Pick one in Settings, then start the task again.');
      }

      // DSH wants an absolute directory and the plugin does not inherit the one DSH was started in.
      const cwd = resolve(String(askedCwd ?? settings.taskCwd) || homedir());
      const sessionId = randomUUID();
      hub.registerClient({ clientId: sessionId, kind: 'dsh', sessionId });
      const owned = await hub.ownTab(sessionId, id, { sessionId, kind: 'dsh' });
      if (!owned.ok) {
        hub.unregisterClient(sessionId);
        throw refusal(owned.status ?? 409, owned.error, owned.owner);
      }

      let handle;
      try {
        handle = await ctx.agents.create({
          sessionId,
          meta: { cwd },
          agentOptions: {
            provider,
            model,
            ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
          },
        });
      } catch (error) {
        hub.releaseLease(sessionId);
        hub.unregisterClient(sessionId);
        throw refusal(502, `DSH could not create the session: ${error?.message ?? String(error)}`);
      }
      handles.add(handle);

      const context = includePage ? await buildPageContext(hub, settings, sessionId) : '';
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: context ? `${context}\n\n${trimmed}` : trimmed }],
        source: { kind: 'user' },
      };
      try {
        handle.agent.followup(message);
      } catch (error) {
        await handle.dispose?.().catch?.(() => undefined);
        hub.releaseLease(sessionId);
        throw refusal(502, `The session was created but the task did not start: ${error?.message ?? String(error)}`);
      }
      return {
        sessionId,
        tabId: id,
        model: `${provider}/${model}`,
        cwd,
        pageContext: context !== '',
      };
    },
  });
  return () => {
    hub.setTaskService(null);
    for (const handle of handles) void handle.dispose?.().catch?.(() => undefined);
    handles.clear();
  };
}
