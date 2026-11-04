// The write card the layer opens for a classified write: the panel's own words around the facts the layer sent, and
// three answers. A card nobody answers is a decline when the layer's clock runs out, so the buttons never imply that
// anything was dispatched yet.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WriteCard } from '../WriteCards';
import type { OpenPrompt } from '@src/ui/protocol';

const prompt = (data: Record<string, unknown>): OpenPrompt => ({
  id: 'p1',
  kind: 'write-card',
  conversationId: 'browser',
  tabId: 7,
  data,
  openedAt: new Date(0).toISOString(),
});

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

describe('write card', () => {
  it('names the action, the target and the site', () => {
    const html = renderToStaticMarkup(
      <WriteCard
        prompt={prompt({ action: 'click', target: 'button "提交"', site: 'example.test' })}
        onAnswer={() => {}}
      />,
    );
    const plain = text(html);
    expect(plain).toContain('The agent wants to click button "提交"');
    expect(plain).toContain('on example.test');
    expect(plain).toContain('Allow once');
    expect(plain).toContain('Deny');
  });

  it('offers to remember the site only when the layer says it can', () => {
    const withRemember = renderToStaticMarkup(
      <WriteCard
        prompt={prompt({ action: 'click', target: 'x', site: 'example.test', canRemember: true })}
        onAnswer={() => {}}
      />,
    );
    expect(text(withRemember)).toContain('Always allow on example.test');

    const without = renderToStaticMarkup(
      <WriteCard
        prompt={prompt({ action: 'upload', target: 'x', site: 'example.test', canRemember: false })}
        onAnswer={() => {}}
      />,
    );
    expect(text(without)).not.toContain('Always allow');
  });

  it('offers three answers, and a fourth only when the site can be remembered', () => {
    const plain = renderToStaticMarkup(
      <WriteCard prompt={prompt({ action: 'click', target: 'x' })} onAnswer={() => {}} />,
    );
    expect(plain.match(/<button/g)?.length).toBe(3);
    expect(text(plain)).not.toContain('Always allow');
    expect(text(plain)).toContain('Allow for this task');

    const remember = renderToStaticMarkup(
      <WriteCard
        prompt={prompt({ action: 'click', target: 'x', site: 'example.test', canRemember: true })}
        onAnswer={() => {}}
      />,
    );
    expect(remember.match(/<button/g)?.length).toBe(4);
  });
});
