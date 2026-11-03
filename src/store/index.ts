// Settings and site rules in chrome.storage.local. The extension keeps no conversations, keys or model config of its
// own: those belong to DSH or to the MCP client above the layer.
export * from './types';
export * from './settings';
export { createStorage } from './storage';
export type { Storage } from './storage';
