// The DSH chat drawer in the side panel. It is the same live Session the DSH window shows: the host plugin owns the
// WebSocket, sends followup/steer, and streams committed events back. Only bridge builds render it.
import { useEffect, useRef, useState } from 'react';
import { t } from '@src/ui/i18n';
import { Markdown } from './Markdown';
import { SendIcon } from '@src/ui/icons';

interface DshSession {
  id: string;
  title: string;
  status: string;
  running?: boolean;
}

interface DshEvent {
  kind: string;
  text?: string;
  name?: string;
  args?: string;
  isError?: boolean;
  status?: string;
  phase?: string;
}

interface DshMessage extends DshEvent {
  id?: string;
  callId?: string;
}

interface DshApproval {
  id: string;
  toolName?: string;
  reason?: string;
  displayReason?: Record<string, string>;
  sessionId?: string | null;
}

interface DshUserStep {
  id: string;
  text: string;
}

const PORT = import.meta.env.WXT_BRIDGE_PORT ?? '8790';
const TOKEN = import.meta.env.WXT_BRIDGE_TOKEN ?? 'dev-token';
const URL = `ws://127.0.0.1:${PORT}/client/chat/ws?token=${encodeURIComponent(TOKEN)}`;

/** What the user typed, without the page-context block the host prepends before sending it to the model. */
export function displayUser(text: string): string {
  return text.replace(/^<page_context[\s\S]*?<\/page_context>\s*/, '');
}

export function toolLine(message: DshMessage): string {
  if (message.kind === 'tool-call') return message.name ?? t('dsh.toolCall');
  if (message.kind === 'tool-result') return message.isError ? `✗ ${message.text ?? ''}` : (message.text ?? '');
  return '';
}

export function DshChat() {
  const [sessions, setSessions] = useState<DshSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DshMessage[]>([]);
  const [input, setInput] = useState('');
  const [includePage, setIncludePage] = useState(false);
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [approvals, setApprovals] = useState<DshApproval[]>([]);
  const [userSteps, setUserSteps] = useState<DshUserStep[]>([]);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | null = null;

    const push = (message: DshMessage) => {
      setMessages(current => [...current.slice(-300), message]);
    };
    const selectStatus = (list: DshSession[]) => {
      const selected = list.find(item => item.id === sessionRef.current);
      if (selected) setRunning(selected.status === 'running');
    };

    const handle = (payload: Record<string, unknown>) => {
      const type = String(payload.type ?? '');
      if (type === 'hello') {
        const list = Array.isArray(payload.sessions) ? (payload.sessions as DshSession[]) : [];
        const history = payload.history as { messages?: DshMessage[] } | undefined;
        const selectedId = typeof payload.sessionId === 'string' ? payload.sessionId : null;
        setSessions(list);
        setSessionId(selectedId);
        setMessages(history?.messages ?? []);
        const selected = list.find(item => item.id === selectedId);
        setRunning(selected?.status === 'running');
        setError(null);
        return;
      }
      if (type === 'sessions') {
        const list = Array.isArray(payload.sessions) ? (payload.sessions as DshSession[]) : [];
        setSessions(list);
        selectStatus(list);
        return;
      }
      if (type === 'history') {
        const history = payload as { messages?: DshMessage[] };
        setMessages(history.messages ?? []);
        return;
      }
      if (type === 'sent' || type === 'stopped') {
        if (type === 'stopped') setRunning(false);
        return;
      }
      if (type === 'approval-answer') {
        setApprovals(current => current.filter(item => item.id !== payload.id));
        return;
      }
      if (type === 'user-step-answer') {
        setUserSteps(current => current.filter(item => item.id !== payload.id));
        return;
      }
      if (type === 'error') {
        setError(String(payload.error ?? 'unknown error'));
        return;
      }
      if (type === 'hub') {
        const event = payload.event as
          | {
              type?: string;
              id?: string;
              sessionId?: string;
              toolName?: string;
              reason?: string;
              displayReason?: Record<string, string>;
              text?: string;
              event?: DshEvent;
            }
          | undefined;
        if (event?.type === 'approval' && event.id) {
          setApprovals(current => [
            ...current.filter(item => item.id !== event.id),
            {
              id: event.id!,
              toolName: event.toolName,
              reason: event.reason,
              displayReason: event.displayReason,
              sessionId: event.sessionId,
            },
          ]);
          return;
        }
        if (event?.type === 'user-step' && event.id) {
          setUserSteps(current => [
            ...current.filter(item => item.id !== event.id),
            { id: event.id!, text: String(event.text ?? '') },
          ]);
          return;
        }
        if (event?.type !== 'chat' || event.sessionId !== sessionRef.current) return;
        const chat = event.event;
        if (!chat) return;
        if (
          chat.kind === 'user' ||
          chat.kind === 'assistant' ||
          chat.kind === 'tool-call' ||
          chat.kind === 'tool-result'
        ) {
          push(chat);
        } else if (chat.kind === 'status' && chat.status) {
          setRunning(chat.status === 'running');
        }
      }
    };

    const connect = () => {
      if (disposed) return;
      setConnected(false);
      socket = new WebSocket(URL);
      socketRef.current = socket;
      socket.onopen = () => {
        if (disposed) return;
        setConnected(true);
        setError(null);
      };
      socket.onclose = () => {
        if (disposed) return;
        setConnected(false);
        if (socketRef.current === socket) socketRef.current = null;
        retry = setTimeout(connect, 2000);
      };
      socket.onerror = () => {
        // The close handler retries; the panel shows the offline state.
      };
      socket.onmessage = event => {
        if (disposed) return;
        try {
          handle(JSON.parse(String(event.data)) as Record<string, unknown>);
        } catch {
          setError('The DSH bridge sent invalid JSON.');
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      socketRef.current = null;
      socket?.close();
    };
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  const onSend = () => {
    const text = input.trim();
    const socket = socketRef.current;
    if (!text || !sessionId || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'send', sessionId, text, includePage }));
    setInput('');
  };

  const onStop = () => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop', sessionId }));
  };

  const answerApproval = (id: string, decision: 'allow' | 'deny' | 'delegate') => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'approval', id, decision }));
  };

  const answerUserStep = (id: string) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'user-step', id }));
  };

  const onSelect = (id: string) => {
    setSessionId(id);
    setMessages([]);
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'select', sessionId: id }));
  };

  const selected = sessions.find(item => item.id === sessionId);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-nb-bg text-nb-fg">
      <div className="flex items-center gap-2 border-b border-nb-border/60 px-3 py-1.5">
        <span
          aria-hidden
          title={connected ? t('dsh.connected') : t('dsh.connecting')}
          className={`size-1.5 shrink-0 rounded-full ${connected ? 'bg-emerald-500' : 'bg-amber-500'}`}
        />
        <label className="sr-only" htmlFor="dsh-session">
          {t('dsh.sessions')}
        </label>
        <select
          id="dsh-session"
          className="min-w-0 flex-1 truncate rounded border border-nb-border bg-nb-bg px-2 py-1 text-xs text-nb-fg"
          value={sessionId ?? ''}
          onChange={event => onSelect(event.target.value)}
          disabled={!sessions.length}>
          {sessions.length ? null : <option value="">{t('dsh.noSessions')}</option>}
          {sessions.map(session => (
            <option key={session.id} value={session.id}>
              {session.title}
              {session.status === 'running' ? ' ●' : ''}
            </option>
          ))}
        </select>
        <span className="shrink-0 text-[11px] text-nb-muted">
          {selected?.status === 'running' ? t('dsh.running') : t('dsh.idle')}
        </span>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3">
        {messages.length === 0 ? (
          <p className="text-sm text-nb-muted">{t('dsh.empty')}</p>
        ) : (
          <ul className="space-y-2">
            {messages.map((message, index) => {
              if (message.kind === 'user') {
                return (
                  <li key={`u-${message.id ?? index}`} className="ml-8">
                    <div className="whitespace-pre-wrap rounded-2xl bg-nb-accent/10 px-3 py-2 text-sm text-nb-fg">
                      {displayUser(message.text ?? '')}
                    </div>
                  </li>
                );
              }
              if (message.kind === 'assistant') {
                return (
                  <li key={`a-${message.id ?? index}`} className="nb-answer pr-4">
                    <Markdown text={message.text ?? ''} />
                  </li>
                );
              }
              if (message.kind === 'tool-call' || message.kind === 'tool-result') {
                return (
                  <li
                    key={`t-${message.callId ?? index}-${index}`}
                    className={`flex items-start gap-2 py-0.5 text-[11.5px] leading-5 ${
                      message.isError ? 'text-red-600 dark:text-red-300' : 'text-nb-muted'
                    }`}
                    title={message.args ?? undefined}>
                    <span
                      aria-hidden
                      className={`mt-[7px] size-1.5 shrink-0 rounded-full ${message.isError ? 'bg-red-500' : 'bg-emerald-500/60'}`}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono">{toolLine(message)}</span>
                  </li>
                );
              }
              return null;
            })}
          </ul>
        )}
      </div>
      {userSteps.map(step => (
        <div
          key={step.id}
          className="mx-3 mb-2 flex flex-col gap-2 rounded-2xl border border-nb-border bg-nb-surface/70 px-3.5 py-3 text-[13px] text-nb-fg">
          <p className="font-semibold">{t('dsh.userStep.title')}</p>
          <p className="whitespace-pre-wrap text-nb-fg/90">{step.text}</p>
          <button
            type="button"
            className="self-start rounded-full bg-nb-accent px-3.5 py-1.5 text-xs font-medium text-white hover:bg-nb-accent-strong"
            onClick={() => answerUserStep(step.id)}>
            {t('dsh.userStep.continue')}
          </button>
        </div>
      ))}
      {approvals.map(approval => {
        const detail = approval.reason ?? approval.displayReason?.en;
        return (
          <div
            key={approval.id}
            className="mx-3 mb-2 flex flex-col gap-2 rounded-2xl border border-amber-300/90 bg-amber-50/80 px-3.5 py-3 text-[13px] leading-[1.5] text-amber-950 dark:border-amber-700/70 dark:bg-amber-950/50 dark:text-amber-50">
            <p className="flex items-center gap-2 font-semibold">
              <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
              {t('dsh.approval.title', { tool: approval.toolName ?? 'tool' })}
            </p>
            {detail ? <p className="whitespace-pre-wrap text-amber-900/90 dark:text-amber-100/90">{detail}</p> : null}
            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="rounded-full bg-nb-fg px-3.5 py-1.5 text-xs font-medium text-nb-bg hover:opacity-85"
                onClick={() => answerApproval(approval.id, 'allow')}>
                {t('dsh.approval.allow')}
              </button>
              <button
                type="button"
                className="rounded-full border border-amber-400 bg-nb-bg px-3.5 py-1.5 text-xs hover:bg-amber-50 dark:bg-transparent dark:hover:bg-amber-900/30"
                onClick={() => answerApproval(approval.id, 'deny')}>
                {t('dsh.approval.deny')}
              </button>
              <button
                type="button"
                className="rounded-full px-1.5 py-1.5 text-xs text-amber-800/80 hover:underline dark:text-amber-200/80"
                onClick={() => answerApproval(approval.id, 'delegate')}>
                {t('dsh.approval.delegate')}
              </button>
            </div>
          </div>
        );
      })}
      {error ? (
        <p className="border-t border-red-200 bg-red-50 px-3 py-1 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {t('dsh.error', { message: error })}
        </p>
      ) : null}
      <div className="border-t border-nb-border/60 p-2">
        <label className="mb-1 flex items-center gap-1.5 text-[11px] text-nb-muted">
          <input
            type="checkbox"
            checked={includePage}
            onChange={event => setIncludePage(event.target.checked)}
            className="accent-nb-accent"
          />
          {t('dsh.includePage')}
          {includePage ? <span className="text-nb-sky">· {t('dsh.pageAttached')}</span> : null}
        </label>
        <div className="flex items-end gap-1.5 rounded-[20px] border border-nb-border bg-nb-bg px-2 py-1.5 transition-colors focus-within:border-nb-accent/40">
          <textarea
            className="min-h-[56px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] leading-[1.5] text-nb-fg placeholder:text-nb-muted focus:outline-none"
            placeholder={t('dsh.placeholder')}
            value={input}
            onChange={event => setInput(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            }}
          />
          <div className="flex shrink-0 items-center gap-1 pb-0.5">
            {running ? (
              <button
                type="button"
                className="mr-1 flex h-8 items-center rounded-full bg-nb-fg px-3 text-xs font-medium text-nb-bg hover:opacity-85"
                onClick={onStop}>
                {t('dsh.stop')}
              </button>
            ) : null}
            <button
              type="button"
              aria-label={t('dsh.send')}
              title={t('dsh.send')}
              className="flex size-8 items-center justify-center rounded-full bg-nb-accent text-white transition-colors hover:bg-nb-accent-strong disabled:bg-nb-surface disabled:text-nb-muted/60"
              disabled={!connected || !sessionId || !input.trim()}
              onClick={onSend}>
              <SendIcon size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
