// Plugin settings. The bundle patch supplies them; the defaults keep a local checkout usable without configuration.

import { homedir } from 'node:os';
import { join } from 'node:path';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function resolveConfig(config = {}) {
  return {
    port: Number(config.port ?? process.env.NANOBROWSER_BRIDGE_PORT ?? 8790),
    token: String(config.token ?? process.env.NANOBROWSER_BRIDGE_TOKEN ?? 'dev-token'),
    callTimeoutMs: Number(config.callTimeoutMs ?? 360_000),
    // Where a skill the agent saves goes. It belongs to the user, not to whichever folder DSH happens to run in, so
    // every workspace sees the same skills.
    skillsDir: String(config.skillsDir ?? join(homedir(), '.dsh', 'skills', 'browser')),
    // Read-only skills that ship with the checkout. Empty means "none"; index.js fills in the repository's own folder.
    builtinSkillsDir: String(config.builtinSkillsDir ?? ''),
    // The DSH tool names the plugin registers; the skill runner resolves through this prefix first.
    toolPrefix: String(config.toolPrefix ?? 'nanobrowser_'),
    // The MCP adapter's public names, so a skill recorded through MCP can still be replayed through either surface.
    mcpToolPrefix: String(config.mcpToolPrefix ?? 'mcp__nanobrowser__'),
    stepDelayMs: clamp(Number(config.stepDelayMs ?? 350), 0, 2000),
    maxSteps: clamp(Number(config.maxSteps ?? 40), 1, 100),
    pageContextChars: clamp(Number(config.pageContextChars ?? 4000), 500, 12_000),
    approvalTimeoutMs: clamp(Number(config.approvalTimeoutMs ?? 120_000), 5_000, 600_000),
    userStepTimeoutMs: clamp(Number(config.userStepTimeoutMs ?? 120_000), 5_000, 600_000),
  };
}
