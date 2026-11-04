// The grouping rules, without a browser: which task's tabs go in which group, and which group is renamed or adopted.
import { describe, expect, it, vi } from 'vitest';
import { GROUP_TITLE_MAX, groupTitle, planTaskGroups } from '../task-tabs';
import type { GroupState } from '../task-tabs';

const fresh = (): GroupState => ({ owned: new Map(), grouped: new Map(), named: new Set() });

describe('task tab groups', () => {
  it('puts a task’s tabs in one group, named after the task', () => {
    const plan = planTaskGroups(
      [{ id: 's1', title: 'Submit the order', tabs: [3, 4] }],
      new Map([
        [3, -1],
        [4, -1],
      ]),
      fresh(),
    );
    expect(plan).toEqual({
      place: [{ sessionId: 's1', tabIds: [3, 4], title: 'Submit the order', rename: true }],
      remove: [],
    });
  });

  it('keeps the group it made and renames it when the task’s name changes', () => {
    const state: GroupState = { owned: new Map([['s1', 11]]), grouped: new Map(), named: new Set([11]) };
    const plan = planTaskGroups([{ id: 's1', title: 'Send the order', tabs: [3] }], new Map([[3, 11]]), state);
    expect(plan.place).toEqual([{ sessionId: 's1', tabIds: [3], groupId: 11, title: 'Send the order', rename: true }]);
  });

  it('adopts a group it did not make, and leaves that group’s name alone', () => {
    const plan = planTaskGroups(
      [{ id: 's1', title: 'A new task name', tabs: [3, 4] }],
      new Map([
        [3, 7],
        [4, 7],
      ]),
      fresh(),
    );
    expect(plan.place).toEqual([
      { sessionId: 's1', tabIds: [3, 4], title: 'A new task name', groupId: 7, rename: false },
    ]);
    // Once adopted the group is the task's, but its name stays the user's: adopting does not make it renameable.
    const adopted: GroupState = { owned: new Map([['s1', 7]]), grouped: new Map(), named: new Set() };
    const later = planTaskGroups([{ id: 's1', title: 'Another name', tabs: [3] }], new Map([[3, 7]]), adopted);
    expect(later.place).toEqual([{ sessionId: 's1', tabIds: [3], groupId: 7, title: 'Another name', rename: false }]);
  });

  it('does not adopt a group another task already owns', () => {
    const state: GroupState = { owned: new Map([['s0', 7]]), grouped: new Map(), named: new Set([7]) };
    const plan = planTaskGroups(
      [
        { id: 's0', title: 'First', tabs: [3] },
        { id: 's1', title: 'Second', tabs: [4] },
      ],
      new Map([
        [3, 7],
        [4, 7],
      ]),
      state,
    );
    // The second task gets its own group; the first keeps the one it has.
    expect(plan.place).toEqual([
      { sessionId: 's0', tabIds: [3], groupId: 7, title: 'First', rename: true },
      { sessionId: 's1', tabIds: [4], title: 'Second', rename: true },
    ]);
  });

  it('takes a page out of the group when no task holds it any more', () => {
    const state: GroupState = { owned: new Map([['s1', 9]]), grouped: new Map([[5, 's1']]), named: new Set([9]) };
    const plan = planTaskGroups([{ id: 's1', title: 'Task', tabs: [3] }], new Map([[5, 9]]), state);
    expect(plan.remove).toEqual([5]);
  });

  it('leaves a page alone once the user moved it to another group', () => {
    const state: GroupState = { owned: new Map([['s1', 9]]), grouped: new Map([[5, 's1']]), named: new Set([9]) };
    const plan = planTaskGroups([{ id: 's1', title: 'Task', tabs: [] }], new Map([[5, 4]]), state);
    expect(plan.remove).toEqual([]);
  });

  it('moves a page out of another task’s group into the group of the task that holds it now', () => {
    const state: GroupState = { owned: new Map([['s1', 9]]), grouped: new Map([[5, 's1']]), named: new Set([9]) };
    const plan = planTaskGroups([{ id: 's2', title: 'Other', tabs: [5] }], new Map([[5, 9]]), state);
    // The other task's group is not adopted: this task gets its own, and the page moves into it.
    expect(plan.place).toEqual([{ sessionId: 's2', tabIds: [5], title: 'Other', rename: true }]);
    expect(plan.remove).toEqual([]);
  });

  it('gives a page to the first task that names it, and groups nothing when no task has pages', () => {
    const plan = planTaskGroups(
      [
        { id: 'a', title: 'A', tabs: [3] },
        { id: 'b', title: 'B', tabs: [3] },
      ],
      new Map([[3, -1]]),
      fresh(),
    );
    expect(plan.place.map(entry => [entry.sessionId, entry.tabIds])).toEqual([['a', [3]]]);
    expect(planTaskGroups([], new Map(), fresh())).toEqual({ place: [], remove: [] });
  });

  it('makes one line of a long name, and still names an untitled task', () => {
    const long = groupTitle(`  a\n  ${'very long '.repeat(10)}`);
    expect(long.startsWith('a very long')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(GROUP_TITLE_MAX);
    expect(long.endsWith('…')).toBe(true);
    expect(groupTitle('   ')).toBe('DSH');
  });
});

/** A browser with tabs and groups, enough of `chrome` for the grouping: the record of calls is what the tests assert. */
function fakeBrowser(tabs: Array<{ tabId: number; groupId: number; windowId?: number }>) {
  const state = new Map(tabs.map(tab => [tab.tabId, { windowId: 1, ...tab }]));
  const calls: string[] = [];
  let nextGroup = 100;
  const chrome = {
    tabs: {
      get: async (tabId: number) => {
        const tab = state.get(tabId);
        if (!tab) throw new Error(`no tab ${tabId}`);
        return { id: tabId, windowId: tab.windowId, groupId: tab.groupId };
      },
      group: async ({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) => {
        const id = groupId ?? nextGroup++;
        calls.push(`group ${tabIds.join(',')} → ${groupId === undefined ? 'new' : id}`);
        for (const tabId of tabIds) state.get(tabId)!.groupId = id;
        return id;
      },
      ungroup: async (tabId: number) => {
        calls.push(`ungroup ${tabId}`);
        const tab = state.get(tabId);
        if (tab) tab.groupId = -1;
      },
    },
    tabGroups: {
      update: async (groupId: number, props: { title: string }) => {
        calls.push(`title ${groupId} ${props.title}`);
      },
    },
  };
  return { chrome, state, calls };
}

describe('task tab groups in a browser', () => {
  it('groups a task’s pages once, renames them, and takes one out when the task gives it back', async () => {
    vi.resetModules();
    const browser = fakeBrowser([
      { tabId: 1, groupId: -1 },
      { tabId: 2, groupId: -1 },
    ]);
    vi.stubGlobal('chrome', browser.chrome);
    const { syncTaskGroups } = await import('../task-tabs');

    await syncTaskGroups([{ id: 's1', title: 'New session', tabs: [1, 2] }]);
    expect(browser.state.get(1)!.groupId).toBe(100);
    expect(browser.state.get(2)!.groupId).toBe(100);
    expect(browser.calls).toEqual(['group 1,2 → new', 'title 100 New session']);

    // A second pass with the same pages moves nothing; only a new name is set, as the task gets its title.
    browser.calls.length = 0;
    await syncTaskGroups([{ id: 's1', title: 'Submit the order', tabs: [1, 2] }]);
    expect(browser.calls).toEqual(['title 100 Submit the order']);

    // One page goes back to the extension: it leaves the group, the task keeps the other.
    browser.calls.length = 0;
    await syncTaskGroups([{ id: 's1', title: 'Submit the order', tabs: [1] }]);
    expect(browser.calls).toEqual(['title 100 Submit the order', 'ungroup 2']);
    expect(browser.state.get(2)!.groupId).toBe(-1);
    expect(browser.state.get(1)!.groupId).toBe(100);

    // The task ends and no session has pages: the last page leaves the group too, and the group goes with it.
    browser.calls.length = 0;
    await syncTaskGroups([]);
    expect(browser.calls).toEqual(['ungroup 1']);
    vi.unstubAllGlobals();
  });

  it('adopts a group the panel did not make, and leaves its name alone', async () => {
    vi.resetModules();
    const browser = fakeBrowser([{ tabId: 7, groupId: 42 }]);
    vi.stubGlobal('chrome', browser.chrome);
    const { syncTaskGroups } = await import('../task-tabs');
    await syncTaskGroups([{ id: 's9', title: 'A task', tabs: [7] }]);
    expect(browser.calls).toEqual([]);
    expect(browser.state.get(7)!.groupId).toBe(42);
    vi.unstubAllGlobals();
  });
});
