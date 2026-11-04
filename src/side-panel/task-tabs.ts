// One Chrome tab group per DSH task. The panel is where the two facts meet: the hub says which tabs a session holds and
// what the session is called, and the browser is where those tabs are. A group is a view, not ownership (ADR 0002), so
// nothing here takes a page away from a task; it only shows which pages belong to which one.

/** A session, as grouping needs it: its name and the tabs the hub has leased to it. */
export interface TaskTabs {
  id: string;
  title: string;
  tabs: number[];
}

/**
 * What the panel has already done: the group it made per session, the session each grouped tab was put in, and the
 * groups whose name it set. A group it only adopted is in `owned` but not in `named`, so its name is never touched.
 */
export interface GroupState {
  owned: Map<string, number>;
  grouped: Map<number, string>;
  named: Set<number>;
}

/** One group to make or keep. The panel creates it when `groupId` is missing. */
export interface GroupToPlace {
  sessionId: string;
  tabIds: number[];
  groupId?: number;
  title: string;
  /** The group is the panel's own, so it may be renamed; an adopted group is never renamed. */
  rename: boolean;
}

export interface GroupPlan {
  place: GroupToPlace[];
  /** Tabs to take out of a group: no task holds them any more. */
  remove: number[];
}

/** Chrome cuts a group's name down to whatever fits the tab strip; this keeps the panel from sending a paragraph. */
export const GROUP_TITLE_MAX = 40;

/** A session title as a group title: one line, short. A session with no title yet is still DSH's. */
export function groupTitle(title: string): string {
  const text = String(title ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return 'DSH';
  return text.length > GROUP_TITLE_MAX ? `${text.slice(0, GROUP_TITLE_MAX - 1)}…` : text;
}

/**
 * The grouping that would make the browser match the sessions. Pure: the caller reads the tabs' current groups and
 * applies the answer with `chrome.tabs.group`. Two rules decide everything:
 * - a tab belongs to one session and a session's tabs go in one group, so a task is one group;
 * - a group the panel did not make (the user's, or one from before a reload) is adopted and not renamed, so a name the
 *   user chose survives.
 */
export function planTaskGroups(sessions: TaskTabs[], groupOf: Map<number, number>, state: GroupState): GroupPlan {
  const ownerOfGroup = new Map<number, string>();
  for (const [sessionId, groupId] of state.owned) ownerOfGroup.set(groupId, sessionId);
  // A tab in two sessions cannot happen (a lease is exclusive), but the first session to name it keeps it.
  const assigned = new Map<number, string>();
  for (const session of sessions) {
    for (const tabId of session.tabs) if (!assigned.has(tabId)) assigned.set(tabId, session.id);
  }

  const place: GroupToPlace[] = [];
  const grouped = new Map<number, string>();
  for (const session of sessions) {
    const tabIds = [...new Set(session.tabs)].filter(tabId => assigned.get(tabId) === session.id);
    if (tabIds.length === 0) continue;
    const known = state.owned.get(session.id);
    const alive = known !== undefined && tabIds.some(tabId => groupOf.get(tabId) === known);
    let groupId = alive ? known : undefined;
    if (groupId === undefined) {
      // A group this task already sits in: made by an earlier panel, or the user grouping the pages by hand.
      const counts = new Map<number, number>();
      for (const tabId of tabIds) {
        const current = groupOf.get(tabId) ?? -1;
        if (current < 0 || ownerOfGroup.has(current)) continue;
        counts.set(current, (counts.get(current) ?? 0) + 1);
      }
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (best) {
        groupId = best[0];
        ownerOfGroup.set(groupId, session.id);
      }
    }
    for (const tabId of tabIds) grouped.set(tabId, session.id);
    place.push({
      sessionId: session.id,
      tabIds,
      ...(groupId !== undefined ? { groupId } : {}),
      title: groupTitle(session.title),
      // A new group is named after the task, and a group this panel named follows the task's name; an adopted one keeps
      // whatever name it has.
      rename: groupId === undefined || state.named.has(groupId),
    });
  }

  const remove: number[] = [];
  for (const [tabId, sessionId] of state.grouped) {
    if (grouped.has(tabId)) continue;
    const groupId = state.owned.get(sessionId);
    if (groupId === undefined) continue;
    // Only a tab still sitting where the panel put it is taken out; one the user moved is theirs now.
    if (groupOf.get(tabId) === groupId) remove.push(tabId);
  }
  return { place, remove };
}

/** The groups this panel made, kept for the life of the side panel page: a reload starts again by adopting them. */
const state: GroupState = { owned: new Map(), grouped: new Map(), named: new Set() };

/** The newest list to apply, and whether an application is running: two at once would make two groups for one task. */
let queued: TaskTabs[] | null = null;
let running = false;

/**
 * Brings the browser's groups in line with the sessions, one application at a time. The hub sends the list again on
 * every lease change, so a page can arrive while the previous list is still being applied; the newest list wins and is
 * applied after the current one, never beside it.
 */
export async function syncTaskGroups(sessions: TaskTabs[]): Promise<void> {
  queued = sessions;
  if (running) return;
  running = true;
  try {
    while (queued) {
      const next = queued;
      queued = null;
      await applyTaskGroups(next);
    }
  } finally {
    running = false;
  }
}

/**
 * Reads every session's tabs, then makes the browser's groups match. Grouping is a view, so every failure is silent: a
 * tab that closed, a browser without the `tabGroups` permission, a tab in a window the group cannot reach.
 */
async function applyTaskGroups(sessions: TaskTabs[]): Promise<void> {
  // The tabs of the tasks, and the tabs this panel grouped last time: a page that has left its task has to be read too,
  // or the group could never be taken apart when the task gives it back.
  const wanted = [...new Set([...sessions.flatMap(session => session.tabs), ...state.grouped.keys()])];
  if (wanted.length === 0) return;
  const tabs = new Map<number, { windowId: number; groupId: number }>();
  for (const tabId of wanted) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.windowId !== undefined) tabs.set(tabId, { windowId: tab.windowId, groupId: tab.groupId ?? -1 });
  }
  // A group lives in one window, so a task whose tabs are in two is grouped in the window its first tab is in.
  const inside = sessions.map(session => {
    const present = session.tabs.filter(tabId => tabs.has(tabId));
    const windowId = present.length ? tabs.get(present[0])?.windowId : undefined;
    return {
      id: session.id,
      title: session.title,
      tabs: present.filter(tabId => windowId !== undefined && tabs.get(tabId)?.windowId === windowId),
    };
  });
  const groupOf = new Map<number, number>();
  for (const [tabId, tab] of tabs) groupOf.set(tabId, tab.groupId);
  const plan = planTaskGroups(inside, groupOf, state);

  const settle = async (entry: GroupToPlace, groupId: number) => {
    state.owned.set(entry.sessionId, groupId);
    for (const tabId of entry.tabIds) state.grouped.set(tabId, entry.sessionId);
    if (entry.groupId === undefined) state.named.add(groupId);
    if (entry.rename) await chrome.tabGroups?.update(groupId, { title: entry.title }).catch(() => undefined);
  };

  for (const entry of plan.place) {
    // A page that is already where it belongs is left alone: grouping it again would only reorder the tab strip. The
    // name may still need to change, as the task gets its title from the first message.
    if (entry.groupId !== undefined && entry.tabIds.every(tabId => groupOf.get(tabId) === entry.groupId)) {
      await settle(entry, entry.groupId);
      continue;
    }
    // A group needs at least one tab, and the planner never hands out an empty list.
    const tabIds = entry.tabIds as [number, ...number[]];
    const groupId = await chrome.tabs
      .group({ tabIds, ...(entry.groupId !== undefined ? { groupId: entry.groupId } : {}) })
      .catch(() => null);
    if (groupId === null || groupId === undefined) continue;
    await settle(entry, groupId);
  }
  for (const tabId of plan.remove) {
    await chrome.tabs.ungroup(tabId).catch(() => undefined);
    state.grouped.delete(tabId);
  }
  // The record is what this panel grouped, not a history: a page that is no longer a task's is forgotten, so the list
  // does not grow with every tab the browser ever had.
  for (const tabId of [...state.grouped.keys()]) if (!tabs.has(tabId)) state.grouped.delete(tabId);
}
