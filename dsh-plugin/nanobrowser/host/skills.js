// Model-facing Browser Skill tools and the DSH skill provider.
//
// A skill is captured from a real turn, stored as SKILL.md + recipe.json, discovered through ctx.skills, and replayed
// through the same hub the browser tools use. The runner is deterministic; the model supplies parameters.

import { captureTurn } from '../core/capture.js';
import { jsonSafe } from '../core/json.js';
import { listSkills, normalizeName, readSkill, renderSkillMd, skillExists, writeSkill } from '../core/skills.js';
import { runSkill } from '../core/run.js';

const RICH_OUTPUT = {
  schema: {
    type: 'object',
    properties: { ok: { type: 'boolean' }, text: { type: 'string' }, data: {} },
    required: ['ok', 'text'],
    additionalProperties: false,
  },
  render(_args, value) {
    return [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }];
  },
};

async function activeTab(hub, clientId, signal) {
  const result = await hub.call(clientId, 'tabs', { action: 'list' }, { signal });
  if (!result || result.ok === false) return undefined;
  const match = /\*\s+tab\s+(\d+)\s+·\s+«(.*?)»\s+·\s+«(.*?)»/.exec(String(result.text ?? ''));
  return match ? { tabId: Number(match[1]), title: match[2], url: match[3] } : undefined;
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function skillMetadata(skill) {
  const metadata = { path: skill.dir };
  if (skill.recipe?.version !== undefined) metadata.version = skill.recipe.version;
  if (skill.recipe?.origin) metadata.origin = skill.recipe.origin;
  if (Array.isArray(skill.recipe?.steps)) metadata.steps = skill.recipe.steps.length;
  return metadata;
}

export function registerSkillTools(ctx, hub, settings) {
  const disposers = [];
  const define = definition => disposers.push(ctx.tools.register(definition));
  define(saveTool(hub, settings));
  define(listTool(settings));
  define(showTool(settings));
  define(runTool(hub, settings));
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}

export function registerSkillProvider(ctx, settings) {
  let control;
  const dispose = ctx.skills.registerProvider(c => {
    control = c;
    return {
      name: 'nanobrowser',
      async list() {
        const skills = await listSkills(settings.skillsDir);
        return skills.map((skill, index) => ({
          name: skill.name,
          description: skill.description,
          ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
          invocation: {
            modelInvocable: skill.recipe?.modelInvocable !== false,
            userInvocable: true,
          },
          source: 'custom',
          provider: 'nanobrowser',
          rank: index,
          locator: skill.dir,
          metadata: skillMetadata(skill),
        }));
      },
      async get(candidate) {
        try {
          const skill = await readSkill(settings.skillsDir, candidate.name);
          return {
            name: skill.name,
            description: skill.description,
            ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
            content: skill.content,
            invocation: {
              modelInvocable: skill.recipe?.modelInvocable !== false,
              userInvocable: true,
            },
            source: 'custom',
            provider: 'nanobrowser',
            resourceBase: { kind: 'directory', path: skill.dir },
            metadata: skillMetadata(skill),
          };
        } catch {
          return undefined;
        }
      },
    };
  });
  return {
    dispose,
    invalidate() {
      try {
        control?.invalidate();
      } catch {
        // A disposed provider needs no cache invalidation.
      }
    },
  };
}

function saveTool(hub, settings) {
  return {
    name: 'browser_skill_save',
    description:
      'Save the browser actions from one turn as a reusable skill. Records only successful actions, turns refs into role and name targets, and writes SKILL.md and recipe.json under the browser skills directory.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Kebab-case skill name, such as export-orders.' },
        description: { type: 'string', description: 'One line for the skill catalog.' },
        whenToUse: { type: 'string', description: 'When the model should use this skill.' },
        params: {
          type: 'object',
          description:
            'Map each parameter name to the literal value recorded in this run; every exact match becomes {{name}} in the recipe.',
          additionalProperties: { type: 'string' },
        },
        turn: {
          type: 'integer',
          minimum: 1,
          description: 'Turn to capture; omitted captures the latest turn that used browser tools.',
        },
        last: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Capture only the last N browser actions from that turn.',
        },
        overwrite: { type: 'boolean', description: 'Replace an existing skill and increment its version.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: RICH_OUTPUT,
    async execute(args, exec) {
      const agent = exec.agent;
      if (!agent?.session) throw new Error('Saving a skill needs a live session.');
      const name = normalizeName(args.name);
      const exists = await skillExists(settings.skillsDir, name);
      if (exists && args.overwrite !== true) {
        throw new Error(`Skill "${name}" already exists; pass overwrite: true to replace it.`);
      }
      let version = 1;
      if (exists) {
        try {
          version = Number((await readSkill(settings.skillsDir, name)).recipe?.version ?? 1) + 1;
        } catch {
          version = 1;
        }
      }
      const clientId = agent.id;
      hub.registerClient({ clientId, kind: 'dsh', sessionId: clientId });
      const tab = await activeTab(hub, clientId, exec.signal);
      const captured = captureTurn(agent.session, {
        params: args.params,
        turn: args.turn,
        last: args.last,
        activeOrigin: tab ? originOf(tab.url) : undefined,
        maxSteps: settings.maxSteps,
      });
      const recipe = {
        name,
        version,
        description: args.description || `Browser skill captured from turn ${captured.turn}.`,
        ...(args.whenToUse ? { whenToUse: args.whenToUse } : {}),
        ...(captured.origin ? { origin: captured.origin } : {}),
        params: captured.params,
        steps: captured.steps,
        assert: captured.assert,
        createdFrom: { sessionId: agent.id, turn: captured.turn, at: Date.now() },
        needsReview: captured.needsReview,
      };
      const content = renderSkillMd(recipe);
      const dir = await writeSkill(settings.skillsDir, recipe, content);
      settings.invalidate?.();
      const paramNames = Object.keys(recipe.params);
      const detail = [
        `Saved skill "${name}" · ${recipe.steps.length} step${recipe.steps.length === 1 ? '' : 's'}`,
        recipe.origin ? `origin ${recipe.origin}` : 'no origin lock',
        paramNames.length > 0 ? `params ${paramNames.join(', ')}` : 'no params',
        recipe.needsReview ? 'some targets need review' : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return {
        ok: true,
        text: `${detail}.\n${dir}`,
        data: jsonSafe({
          name,
          dir,
          version,
          steps: recipe.steps.length,
          params: paramNames,
          origin: recipe.origin,
          needsReview: recipe.needsReview,
          notes: captured.notes,
        }),
      };
    },
  };
}

function listTool(settings) {
  return {
    name: 'browser_skill_list',
    description: 'List saved browser skills: name, description, steps and origin.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: RICH_OUTPUT,
    async execute() {
      const skills = await listSkills(settings.skillsDir);
      if (skills.length === 0) return { ok: true, text: 'No browser skills are saved yet.', data: { skills: [] } };
      const lines = skills.map(skill => {
        const bits = [`- ${skill.name}`, `${skill.recipe?.steps?.length ?? 0} steps`];
        if (skill.recipe?.origin) bits.push(skill.recipe.origin);
        if (skill.description) bits.push(skill.description);
        return bits.join(' · ');
      });
      return {
        ok: true,
        text: `Browser skills in ${settings.skillsDir}:\n${lines.join('\n')}`,
        data: jsonSafe({
          skills: skills.map(skill => ({
            name: skill.name,
            description: skill.description,
            whenToUse: skill.whenToUse,
            dir: skill.dir,
            version: skill.recipe?.version,
            steps: skill.recipe?.steps?.length,
            origin: skill.recipe?.origin,
            modelInvocable: skill.recipe?.modelInvocable !== false,
          })),
        }),
      };
    },
  };
}

function showTool(settings) {
  return {
    name: 'browser_skill_show',
    description: "Show a saved browser skill's instructions and recipe.",
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    output: RICH_OUTPUT,
    async execute(args) {
      const skill = await readSkill(settings.skillsDir, args.name);
      return {
        ok: true,
        text: `${skill.content}\nrecipe.json:\n${JSON.stringify(skill.recipe, null, 2)}`,
        data: jsonSafe({ name: skill.name, dir: skill.dir, recipe: skill.recipe }),
      };
    },
  };
}

function runTool(hub, settings) {
  return {
    name: 'browser_skill_run',
    description:
      "Run a saved browser skill in the user's tab. Steps run in order with the same browser tools; write steps still ask for approval. Returns each step's outcome and any failed check.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        params: { type: 'object', additionalProperties: {}, description: 'Values for the recipe placeholders.' },
        dryRun: {
          type: 'boolean',
          description: 'Resolve targets and check text without clicking, typing or navigating.',
        },
        stepDelayMs: {
          type: 'integer',
          minimum: 0,
          maximum: 2000,
          description: 'Pause between steps so the replay is visible.',
        },
        quiet: { type: 'boolean', description: 'Do not write step notes to the side panel.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: RICH_OUTPUT,
    async execute(args, exec) {
      const skill = await readSkill(settings.skillsDir, args.name);
      const clientId = exec.agent?.id ?? 'dsh:unscoped';
      hub.registerClient({ clientId, kind: 'dsh', sessionId: exec.agent?.id ?? null });
      return jsonSafe(
        await runSkill(hub, clientId, settings, skill, {
          params: args.params,
          dryRun: args.dryRun,
          stepDelayMs: args.stepDelayMs,
          quiet: args.quiet,
          signal: exec.signal,
        }),
      );
    },
  };
}
