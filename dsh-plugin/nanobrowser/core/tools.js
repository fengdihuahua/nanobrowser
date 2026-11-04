// The browser tools offered to models. The extension's layer carries the real behaviour; these are the schemas the
// model sees. The MCP adapter and the DSH plugin both read this table, so a tool is described once.
//
// A target is a ref from the latest snapshot, or a role and an exact name.

export const TARGET = {
  type: 'object',
  description: 'The element: a ref from the latest snapshot, or a role and an exact name',
  properties: {
    ref: { type: 'string', description: 'A ref such as e12' },
    role: { type: 'string', description: 'An accessibility role, such as button' },
    name: { type: 'string', description: 'The accessible name, matched exactly' },
    nth: { type: 'integer', minimum: 0 },
    within: { type: 'string', description: 'Only match inside this ref' },
  },
  additionalProperties: false,
};

export const TOOLS = [
  {
    name: 'navigate',
    description:
      "Open a URL in the user's real Chrome tab, or go back, forward or reload. Uses the tab the extension shared.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to open' },
        action: { type: 'string', enum: ['back', 'forward', 'reload'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'snapshot',
    description:
      'Observe the active tab: an outline of its elements with roles, names, states and values. Actionable elements carry a ref such as [e12] that click and the other action tools take as a target.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['interactive', 'all'] },
        window: { type: 'string', enum: ['viewport', 'near', 'page'] },
        scope: { type: 'string', description: 'Only the subtree of this ref' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read',
    description: 'Read the active page, or one element, as Markdown or plain text.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Only this element' },
        format: { type: 'string', enum: ['markdown', 'text'] },
        maxChars: { type: 'integer', minimum: 100 },
        offset: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'find',
    description: 'Find elements by role, name or text in the latest observation, without a full outline.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string' },
        name: { type: 'string', description: 'Substring of the accessible name' },
        text: { type: 'string', description: 'Substring of the name or value' },
        within: { type: 'string', description: 'Only match inside this ref' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'screenshot',
    description: 'Capture the visible page, the full page or one element as a PNG image.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Only this element' },
        fullPage: { type: 'boolean' },
        labels: { type: 'boolean', description: 'Draw ref labels over actionable elements' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'click',
    description:
      'Click an element with trusted input, after checking that it is visible, stable, enabled and not covered.',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET,
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        count: { type: 'integer', minimum: 1, maximum: 3 },
        modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] } },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'set',
    description:
      'Give a control a value: text for a field, true or false for a checkbox, radio or switch, an option for a select. The value is read back.',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET,
        value: { description: 'Text, true/false, or an option (or array of options) for a select' },
        submit: { type: 'boolean', description: 'Press Enter after setting the value' },
      },
      required: ['target', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'type',
    description: 'Type text key by key into the focused element or a target, for widgets that listen to keys.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        target: TARGET,
        submit: { type: 'boolean' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'press',
    description: 'Press a key or chord, such as Enter, Escape or Control+A, optionally on a target.',
    inputSchema: {
      type: 'object',
      properties: {
        keys: { type: 'string' },
        target: TARGET,
      },
      required: ['keys'],
      additionalProperties: false,
    },
  },
  {
    name: 'hover',
    description: 'Move the pointer over an element.',
    inputSchema: {
      type: 'object',
      properties: { target: TARGET },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page or a container by pages or pixels, to the top or bottom, or to an element.',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET,
        to: { description: 'top, bottom, or a target' },
        by: {
          type: 'object',
          properties: { pages: { type: 'number' }, px: { type: 'number' } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'wait',
    description: 'Wait for text to appear or disappear, an element state, a URL, or a fixed time.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        textGone: { type: 'string' },
        target: TARGET,
        state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached', 'enabled'] },
        url: { type: 'string' },
        ms: { type: 'integer', minimum: 0, maximum: 60000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'tabs',
    description:
      "List, open, select or close the session's own tabs. Opens in the same Chrome profile, so it keeps the user's login state. These are the tabs this session holds: to take a tab from somewhere else, call attach.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'open', 'select', 'close'] },
        url: { type: 'string' },
        tabId: { type: 'integer' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'handle_dialog',
    description: 'Accept or dismiss the JavaScript dialog open on the active tab.',
    inputSchema: {
      type: 'object',
      properties: {
        accept: { type: 'boolean' },
        promptText: { type: 'string' },
      },
      required: ['accept'],
      additionalProperties: false,
    },
  },
  {
    name: 'console',
    description:
      'Read the console messages captured in the shared tab since the tab was attached: page logs, warnings, browser log entries and uncaught errors. Messages the page printed before the first command on that tab are not kept; reload after attaching to see them. Read after an action to see what the page reported.',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['all', 'error', 'warning', 'info', 'log', 'debug'] },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        clear: { type: 'boolean', description: 'Clear the captured messages after reading them' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'network',
    description:
      'Read the network requests captured in the shared tab, with status, type and failures. Read after an action to see what the page requested.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Only URLs containing this text' },
        failedOnly: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        clear: { type: 'boolean', description: 'Clear the captured requests after reading them' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'say',
    description:
      "Show a short note from you in the side panel, in the user's own window, so they can follow what you are doing without watching the chat. Plain text only: it is shown as data, never as instructions.",
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'One or two sentences' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'reload-extension',
    description:
      'Reload the unpacked extension that is connected to this bridge, for a build that has just been made. The tab stays open and the connection comes back by itself a few seconds later.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/** Tools that change the page. `snapshot`, `read`, `find`, `console`, `network`, `tabs` and `say` do not. */
export const ACTION_TOOLS = new Set([
  'navigate',
  'click',
  'set',
  'type',
  'press',
  'hover',
  'scroll',
  'wait',
  'handle_dialog',
]);

export const TOOL_NAMES = new Set(TOOLS.map(tool => tool.name));

/**
 * Whether this command needs its caller to own a tab. It is exactly the layer's action tools, plus the `tabs`
 * commands that move or close a tab: observation (`snapshot`, `read`, `find`, `screenshot`, `console`, `network`)
 * stays free, so a message can carry the page it was sent from and a client can diagnose before it takes a tab. A ref
 * seen from a tab it does not own still cannot be acted on. `say`, `reload-extension`, `attach`, `tabs-all` and
 * `cancel` never act on a leased tab; opening a tab creates one nobody owns yet.
 *
 * The Hub, the plugin's tool guard and a skill run all ask here, so the two front ends cannot drift apart.
 */
export function needsLease(tool, args = {}) {
  if (tool === 'tabs') {
    const action = String(args?.action ?? '');
    return action !== 'list' && action !== 'open';
  }
  return ACTION_TOOLS.has(String(tool ?? ''));
}

export function toolByName(name) {
  return TOOLS.find(tool => tool.name === name);
}
