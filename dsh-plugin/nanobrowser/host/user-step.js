// `nanobrowser_wait_for_user`: the agent pauses while the user completes a step in the page (login, 2FA, a captcha),
// then continues when the drawer's Continue button is pressed. The password itself never reaches the model.

import { randomUUID } from 'node:crypto';

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

export function registerUserSteps(ctx, hub, settings) {
  const pending = new Map();
  const service = {
    /** The drawer pressed Continue for this request. */
    answer(id) {
      const key = String(id ?? '');
      const entry = pending.get(key);
      if (!entry) return false;
      pending.delete(key);
      clearTimeout(entry.timer);
      entry.resolve(true);
      return true;
    },
  };
  hub.setUserStepService(service);

  const dispose = ctx.tools.register({
    name: 'nanobrowser_wait_for_user',
    description:
      'Pause until the user completes a step in the page, such as logging in, finishing 2FA or passing a captcha. The user continues from the Chrome side panel; then this returns and you can look at the page again.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'One or two sentences telling the user what to do in the page.' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000, description: 'How long to wait before giving up.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args, exec) {
      if (!hub.hasWsClients()) {
        throw new Error('Open the DSH drawer in the Chrome side panel first; the user step needs it.');
      }
      const text = String(args?.text ?? '').trim();
      if (!text) throw new Error('wait_for_user needs a short instruction for the user.');
      const timeoutMs = Math.max(
        1000,
        Math.min(600_000, Number(args?.timeoutMs ?? settings.userStepTimeoutMs)),
      );
      const id = randomUUID();
      const completed = await new Promise(resolve => {
        const timer = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          resolve(false);
        }, timeoutMs);
        pending.set(id, { resolve, timer });
        hub.publish({
          type: 'user-step',
          id,
          sessionId: exec.agent?.id ?? null,
          text,
          timeoutMs,
        });
      });
      if (!completed) throw new Error(`The user did not continue within ${timeoutMs} ms.`);
      return { ok: true, text: 'The user continued.' };
    },
  });

  return () => {
    hub.setUserStepService(null);
    try {
      dispose();
    } catch {
      /* already disposed */
    }
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(false);
    }
    pending.clear();
  };
}
