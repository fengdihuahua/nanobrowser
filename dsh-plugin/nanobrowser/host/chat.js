// The DSH side of the side-panel chat.
//
// The panel sees the same live Agent the DSH Web UI sees: history comes from the session log, messages enter through
// followup/steer, Stop calls cancel, and each committed session event is published to the hub for live delivery.
// Page context is fetched from the same browser tools over the hub, so a message from a page carries that page.

import { randomUUID } from 'node:crypto';

function bound(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function textOf(message, max = 4000) {
  if (!message?.content) return '';
  const parts = [];
  for (const block of message.content) {
    if (block?.type === 'text') parts.push(block.text);
    else if (block?.type === 'image') parts.push('[image]');
  }
  return bound(parts.join('\n'), max);
}

const TITLE_NOISE = [
  /^<system-reminder>/i,
  /^Current runtime context\./i,
  /^Time sampled/i,
  /^Continue working toward the objective/i,
  /^Objective:/i,
  /^<goal_round>/i,
];

function titleOf(messages) {
  // The first real user prompt names the session; harness reminders and goal-round prompts are not titles.
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = textOf(message, 200).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (TITLE_NOISE.some(pattern => pattern.test(text))) continue;
    return bound(text, 80);
  }
  return 'New session';
}

function attr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Page text inside the boundary: a `<` in the page must not look like the end of a tag. */
function escapeText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * The message a page sends with a prompt: the user's selection first, then the page it came from. Exported so a test
 * can check the boundary without a browser.
 */
export async function buildPageContext(hub, settings, sessionId) {
  try {
    const tab = await hub.call(sessionId, 'tabs', { action: 'list' }, { signal: AbortSignal.timeout(3000) });
    if (!tab || tab.ok === false) return '';
    const match = /\*\s+tab\s+(\d+)\s+·\s+«(.*?)»\s+·\s+«(.*?)»/.exec(String(tab.text ?? ''));
    const read = await hub.call(
      sessionId,
      'read',
      { format: 'text', maxChars: settings.pageContextChars },
      { signal: AbortSignal.timeout(5000) },
    );
    if (!read || read.ok === false) return '';
    const url = match ? match[3] : '';
    const title = match ? match[2] : '';
    const selected = typeof read.data?.selection?.text === 'string' ? read.data.selection.text : '';
    const selection = selected ? `<selection>${escapeText(bound(selected, 2000))}</selection>\n` : '';
    return `<page_context url="${attr(url)}" title="${attr(title)}">\n${selection}${bound(read.text, settings.pageContextChars)}\n</page_context>`;
  } catch {
    return '';
  }
}

export function registerChat(ctx, hub, settings) {
  const service = createChatService(ctx, hub, settings);
  hub.setChatService(service);
  const disposers = [
    ctx.on('session/event', (session, event) => service.handleEvent(session, event)),
    ctx.on('agent/status', payload => service.handleStatus(payload.agent, payload.status)),
  ];
  return () => {
    hub.setChatService(null);
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        /* already disposed */
      }
    }
  };
}

function createChatService(ctx, hub, settings) {
  function sessions() {
    const agents = ctx.agents?.roots?.() ?? [];
    const list = [];
    for (const agent of agents) {
      let title = 'New session';
      let createdAt;
      try {
        createdAt = agent.session.header.createdAt;
        title = titleOf(agent.session.deriveMessages());
      } catch {
        /* a session that is not projected yet still appears with its id */
      }
      list.push({
        id: String(agent.id),
        title,
        status: agent.status,
        running: agent.status === 'running',
        createdAt,
      });
    }
    // The current session is normally the newest; the panel should open on it, not on an old idle one.
    list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    return list;
  }

  function history(sessionId) {
    const agent = ctx.agents?.get?.(sessionId);
    if (!agent) return { sessionId, live: false, messages: [] };
    const messages = [];
    for (const message of agent.session.deriveMessages()) {
      if (message.role === 'user') {
        const text = textOf(message);
        if (text) messages.push({ kind: 'user', id: message.id, text });
        continue;
      }
      if (message.role === 'assistant') {
        const text = textOf(message);
        if (text) messages.push({ kind: 'assistant', id: message.id, text });
        for (const block of message.content) {
          if (block.type !== 'tool-call') continue;
          messages.push({
            kind: 'tool-call',
            callId: block.id,
            name: block.name,
            args: bound(block.arguments, 600),
          });
        }
        continue;
      }
      if (message.role === 'tool') {
        messages.push({
          kind: 'tool-result',
          callId: message.toolCallId,
          text: textOf(message, 1000),
          isError: message.isError === true,
        });
      }
    }
    return { sessionId, live: true, messages: messages.slice(-200) };
  }

  async function pageContext(sessionId) {
    return buildPageContext(hub, settings, sessionId);
  }

  async function send({ sessionId, text, mode = 'auto', includePage = false } = {}) {
    const agent = ctx.agents?.get?.(String(sessionId ?? ''));
    if (!agent) throw new Error('This session is not live. Open it in DSH first.');
    const trimmed = String(text ?? '').trim();
    if (!trimmed) throw new Error('The message is empty.');
    const context = includePage ? await pageContext(String(agent.id)) : '';
    const selected = mode === 'followup' || mode === 'steer' ? mode : agent.status === 'running' ? 'steer' : 'followup';
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: context ? `${context}\n\n${trimmed}` : trimmed }],
      source: { kind: 'user' },
    };
    if (selected === 'steer') agent.steer(message);
    else agent.followup(message);
    return {
      sessionId: String(agent.id),
      messageId: message.id,
      mode: selected,
      pageContext: context !== '',
      selection: context.includes('<selection>'),
    };
  }

  function stop({ sessionId } = {}) {
    const agent = ctx.agents?.get?.(String(sessionId ?? ''));
    if (!agent) throw new Error('This session is not live. Open it in DSH first.');
    agent.cancel({ kind: 'user' });
    return { sessionId: String(agent.id) };
  }

  function hello(sessionId) {
    const list = sessions();
    const selected = list.find(item => item.id === sessionId)?.id ?? list[0]?.id ?? null;
    return {
      sessions: list,
      sessionId: selected,
      history: selected ? history(selected) : { sessionId: null, live: false, messages: [] },
    };
  }

  function handleEvent(session, event) {
    try {
      const id = String(session.id);
      if (event.type === 'user/message') {
        const text = textOf(event.data);
        if (text) hub.publish({ type: 'chat', sessionId: id, event: { kind: 'user', text, messageId: event.data.id } });
        return;
      }
      if (event.type === 'assistant/message') {
        const text = textOf(event.data?.message);
        if (text) {
          hub.publish({
            type: 'chat',
            sessionId: id,
            event: { kind: 'assistant', text, messageId: event.data?.message?.id },
          });
        }
        return;
      }
      if (event.type === 'tool/call') {
        hub.publish({
          type: 'chat',
          sessionId: id,
          event: {
            kind: 'tool-call',
            callId: event.data?.callId,
            name: event.data?.name,
            args: bound(event.data?.arguments, 600),
          },
        });
        return;
      }
      if (event.type === 'tool/result') {
        hub.publish({
          type: 'chat',
          sessionId: id,
          event: {
            kind: 'tool-result',
            callId: event.data?.message?.toolCallId,
            text: textOf(event.data?.message, 1000),
            isError: event.data?.message?.isError === true || event.data?.error !== undefined,
          },
        });
        return;
      }
      if (event.type === 'turn/start' || event.type === 'turn/end') {
        hub.publish({
          type: 'chat',
          sessionId: id,
          event: {
            kind: 'turn',
            phase: event.type === 'turn/start' ? 'start' : 'end',
            turn: event.data?.turn,
            ...(event.data?.reason !== undefined ? { reason: bound(JSON.stringify(event.data.reason), 200) } : {}),
          },
        });
      }
    } catch {
      // A chat observer must never disturb the session's own event dispatch.
    }
  }

  function handleStatus(agent, status) {
    try {
      hub.publish({ type: 'chat', sessionId: String(agent.id), event: { kind: 'status', status } });
    } catch {
      /* ignore */
    }
  }

  return { sessions, history, hello, send, stop, handleEvent, handleStatus };
}
