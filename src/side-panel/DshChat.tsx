// The DSH chat drawer in the side panel. It is the same live Session the DSH window shows: the host plugin owns the
// WebSocket, sends followup/steer, and streams committed events back. Only bridge builds render it.
import { useEffect, useRef, useState } from 'react';
import { t } from '@src/ui/i18n';
import { Markdown } from './Markdown';
import { syncTaskGroups } from './task-tabs';
import { PlusIcon, SendIcon } from '@src/ui/icons';

interface DshSession {
  id: string;
  title: string;
  status: string;
  running?: boolean;
  /** The tabs this task drives, from the hub's leases: the pages that belong to it. */
  tabs?: number[];
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
const TASK_URL = `http://127.0.0.1:${PORT}/client/task?token=${encodeURIComponent(TOKEN)}`;
const RELEASE_URL = `http://127.0.0.1:${PORT}/client/tab/release?token=${encodeURIComponent(TOKEN)}`;

/**
 * The request that starts a task on this page. Pure, so the panel's one write to the hub can be checked without a
 * browser: the text is trimmed the same way the composer trims it.
 */
export function taskRequest(text: string, tabId: number, includePage: boolean) {
  return { url: TASK_URL, body: { text: text.trim(), tabId, includePage } };
}

/**
 * The request that gives one page back and keeps the task. Also pure: the chip's × is the panel's other write to the
 * hub, and it must name the task as the hub does, which is the session id.
 */
export function releaseRequest(sessionId: string, tabId: number) {
  return { url: RELEASE_URL, body: { clientId: sessionId, tabId } };
}

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
  /** Failed connections since the last successful one: the panel says it is reconnecting, and how many times. */
  const [attempts, setAttempts] = useState(0);
  const [running, setRunning] = useState(false);
  const [approvals, setApprovals] = useState<DshApproval[]>([]);
  const [userSteps, setUserSteps] = useState<DshUserStep[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  /** The selected task's pages: the chips above the conversation, each of them a tab the task drives. */
  const [chips, setChips] = useState<Array<{ tabId: number; title: string }>>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);

  // A task is one tab group. The hub sends the session list again whenever a lease changes, so a page the task opened
  // joins its task's group on its own, and one it gave back leaves.
  useEffect(() => {
    void syncTaskGroups(
      sessions.map(session => ({ id: session.id, title: session.title, tabs: session.tabs ?? [] })),
    ).catch(() => undefined);
  }, [sessions]);

  const tabs = sessions.find(item => item.id === sessionId)?.tabs;
  // A group shows what a page is called, not only that it exists: the chip follows a title as the page loads.
  useEffect(() => {
    let disposed = false;
    if (!tabs || tabs.length === 0) {
      setChips([]);
      return;
    }
    void Promise.all(tabs.map(tabId => chrome.tabs.get(tabId).catch(() => null))).then(list => {
      if (disposed) return;
      setChips(
        list
          .filter((tab): tab is chrome.tabs.Tab => !!tab && tab.id !== undefined)
          .map(tab => ({ tabId: tab.id!, title: tab.title || tab.url || String(tab.id) })),
      );
    });
    return () => {
      disposed = true;
    };
  }, [tabs, sessionId]);

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

    const connect = async () => {
      if (disposed) return;
      setConnected(false);
      // The tab this panel was opened on: the host shows the session that owns it, not the newest one.
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
      if (disposed) return;
      socket = new WebSocket(tab?.id === undefined ? URL : `${URL}&tabId=${tab.id}`);
      socketRef.current = socket;
      socket.onopen = () => {
        if (disposed) return;
        setConnected(true);
        setAttempts(0);
        setError(null);
      };
      socket.onclose = () => {
        if (disposed) return;
        setConnected(false);
        setAttempts(previous => previous + 1);
        if (socketRef.current === socket) socketRef.current = null;
        retry = setTimeout(() => void connect(), 2000);
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

    void connect();
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

  /**
   * Starts a task from this panel: the tab the user is looking at, a new DSH session, the typed text as its first
   * message. The session appears in the picker and is selected, so the panel then mirrors it like any other.
   */
  const onStartTask = async () => {
    const text = input.trim();
    if (!text || starting) return;
    setStarting(true);
    setError(null);
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id === undefined) throw new Error(t('dsh.newTaskTab'));
      const request = taskRequest(text, tab.id, includePage);
      let response: Response;
      try {
        response = await fetch(request.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request.body),
        });
      } catch {
        // No hub at all: there is no brain to start a task with, and saying so is the whole message.
        throw new Error(t('dsh.noHub'));
      }
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; sessionId?: string; error?: string };
      if (!response.ok || payload.ok === false || !payload.sessionId) {
        throw new Error(payload.error ?? `The hub answered ${response.status}.`);
      }
      setInput('');
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'sessions' }));
      onSelect(payload.sessionId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setStarting(false);
    }
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

  /** Bring a page of this task to the front, without leaving the panel. */
  const focusTab = async (tabId: number) => {
    const tab = await chrome.tabs.update(tabId, { active: true }).catch(() => null);
    if (tab?.windowId !== undefined)
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  };

  /** Give one page back: the task keeps the rest. The hub sends the new session list, so the chip goes by itself. */
  const dropTab = async (tabId: number) => {
    if (!sessionId) return;
    const request = releaseRequest(sessionId, tabId);
    try {
      await fetch(request.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.body),
      });
    } catch {
      setError(t('dsh.noHub'));
    }
  };

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
        {!connected && attempts > 0 ? (
          <span className="shrink-0 text-[11px] text-amber-600 dark:text-amber-300">
            {t('dsh.reconnecting', { n: attempts })}
          </span>
        ) : null}
      </div>
      {chips.length ? (
        <div className="flex flex-wrap items-center gap-1 border-b border-nb-border/40 px-3 py-1.5">
          <span className="mr-0.5 text-[10px] font-medium uppercase tracking-wide text-nb-muted">
            {t('dsh.taskTabs')}
          </span>
          {chips.map(chip => (
            <span
              key={chip.tabId}
              className="inline-flex max-w-[46%] items-center gap-0.5 rounded-full border border-nb-border bg-nb-surface/60 py-0.5 pl-2 pr-0.5 text-[11px] text-nb-fg">
              <button
                type="button"
                className="min-w-0 truncate text-left hover:underline"
                title={chip.title}
                aria-label={`${chip.title} · ${t('dsh.tabSwitch')}`}
                onClick={() => void focusTab(chip.tabId)}>
                {chip.title}
              </button>
              <button
                type="button"
                aria-label={t('dsh.tabRemove')}
                title={t('dsh.tabRemove')}
                className="shrink-0 rounded-full px-1 leading-4 text-nb-muted transition-colors hover:text-red-600"
                onClick={() => void dropTab(chip.tabId)}>
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
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
            className="mx-3 mb-2 flex flex-col gap-2 rounded-2xl border border-amber-300/90 bg-amber-50/80 px-3.5 py-3 text-[13px] leading-normal text-amber-950 dark:border-amber-700/70 dark:bg-amber-950/50 dark:text-amber-50">
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
                className="rounded-full p-1.5 text-xs text-amber-800/80 hover:underline dark:text-amber-200/80"
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
            className="min-h-[56px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] leading-normal text-nb-fg placeholder:text-nb-muted focus:outline-none"
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
              aria-label={t('dsh.newTask')}
              title={t('dsh.newTask')}
              className="flex size-8 items-center justify-center rounded-full border border-nb-border text-nb-muted transition-colors hover:border-nb-accent/50 hover:text-nb-accent disabled:opacity-50"
              disabled={!connected || !input.trim() || starting}
              onClick={() => void onStartTask()}>
              <PlusIcon size={14} />
            </button>
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
