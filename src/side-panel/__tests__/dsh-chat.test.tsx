// The DSH drawer's initial render and its two pure presentation helpers. The live socket path is covered on the
// host side by test/chat.test.mjs; this keeps the panel component from breaking without a browser.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DshChat, displayUser, releaseRequest, taskRequest, toolLine } from '../DshChat';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('DSH chat drawer', () => {
  it('renders its empty state, session picker and composer', () => {
    const markup = renderToStaticMarkup(<DshChat />);
    const plain = text(markup);
    expect(plain).toContain('DSH');
    expect(plain).toContain('No live DSH session.');
    expect(plain).toContain('No messages yet.');
    expect(markup).toContain('placeholder="Message DSH…"');
    // Send and the task button are icons now: their labels are the accessible names, not visible text.
    expect(markup).toContain('aria-label="Send"');
    expect(markup).toContain('aria-label="New task here"');
    expect(plain).toContain('Include current page');
  });

  it('asks the hub for a task on this tab, with the text trimmed', () => {
    const request = taskRequest('  look at this  ', 7, true);
    expect(request.url).toContain('/client/task');
    expect(request.body).toEqual({ text: 'look at this', tabId: 7, includePage: true });
  });

  it('gives one page back by naming the task and the tab', () => {
    const request = releaseRequest('s1', 7);
    expect(request.url).toContain('/client/tab/release');
    expect(request.body).toEqual({ clientId: 's1', tabId: 7 });
  });

  it('shows only what the user typed, not the page-context block', () => {
    expect(displayUser('<page_context url="https://example.test">body</page_context>\n\nhello')).toBe('hello');
    expect(displayUser('plain text')).toBe('plain text');
  });

  it('labels tool rows and marks a failed result', () => {
    expect(toolLine({ kind: 'tool-call', name: 'click' })).toBe('click');
    expect(toolLine({ kind: 'tool-result', text: 'ok' })).toBe('ok');
    expect(toolLine({ kind: 'tool-result', text: 'boom', isError: true })).toBe('✗ boom');
  });
});
