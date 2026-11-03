import { describe, expect, it } from 'vitest';
import { INITIAL, reduce } from '../state';
import type { PanelEvent, PanelEventBody } from '@src/ui/protocol';

function event(body: PanelEventBody): PanelEvent {
  return { ...body, seq: 1, conversationId: 'c1' } as PanelEvent;
}

describe('the browser view of an external session', () => {
  it('shows what the session is doing, then clears the working state', () => {
    const working = reduce(INITIAL, event({ type: 'browser-session', active: true, tabId: 7, lastAction: 'click «Send»' }));
    expect(working.browser).toEqual({ active: true, tabId: 7, lastAction: 'click «Send»' });

    const idle = reduce(working, event({ type: 'browser-session', active: false }));
    expect(idle.browser).toEqual({ active: false, tabId: undefined, lastAction: undefined });
  });

  it('keeps the last eight notes', () => {
    let state = INITIAL;
    for (let i = 0; i < 10; i++)
      state = reduce(state, event({ type: 'browser-note', text: `note ${i}`, at: '2026-01-01T00:00:00.000Z' }));
    expect(state.notes.map(n => n.text)).toEqual(['note 2', 'note 3', 'note 4', 'note 5', 'note 6', 'note 7', 'note 8', 'note 9']);
  });
});
