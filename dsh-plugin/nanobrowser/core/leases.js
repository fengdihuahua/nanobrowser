// A client owns a set of tabs: one usually, more when a task opened a page or the user attached a second one. A tab
// still belongs to exactly one client. A lease may exist before any tab is known (the first attach binds it), and a
// lease with no tabs owns nothing yet, so it does not authorize an action.

/** The lease as callers see it: the set as an array, and `tabId` = the tab it was last given. */
function snapshot(lease) {
  return { ...lease, tabs: [...lease.tabs] };
}

export class LeaseManager {
  #byTab = new Map();
  #byClient = new Map();

  /** Takes a tab for this client: it joins the set, or the lease is created with it. Another client's tab is refused. */
  acquire(clientId, { tabId = null, sessionId = null, kind = 'unknown' } = {}) {
    const existing = this.#byClient.get(clientId);
    if (existing) {
      if (tabId === null) return { ok: true, reused: true, lease: snapshot(existing) };
      const joined = this.bind(clientId, tabId);
      return joined.ok ? { ...joined, reused: true } : joined;
    }
    const lease = { clientId, sessionId, kind, tabId: null, tabs: new Set(), since: Date.now() };
    this.#byClient.set(clientId, lease);
    if (tabId === null) return { ok: true, lease: snapshot(lease) };
    const joined = this.bind(clientId, tabId);
    if (!joined.ok) {
      this.#byClient.delete(clientId);
      return joined;
    }
    return { ok: true, lease: snapshot(lease) };
  }

  /** Adds a tab to a lease. Refuses a tab owned by another client; taking the same one twice is not an error. */
  bind(clientId, tabId) {
    const lease = this.#byClient.get(clientId);
    if (!lease) return { ok: false, reason: 'no-lease' };
    const owner = this.#byTab.get(tabId);
    if (owner && owner.clientId !== clientId) return { ok: false, reason: 'tab-leased', owner: snapshot(owner) };
    if (lease.tabs.has(tabId)) return { ok: true, reused: true, lease: snapshot(lease) };
    lease.tabs.add(tabId);
    lease.tabId = tabId;
    this.#byTab.set(tabId, lease);
    return { ok: true, lease: snapshot(lease) };
  }

  /** Gives one tab back, leaving the rest of the set alone. The lease goes when its last tab does. */
  giveBack(clientId, tabId) {
    const lease = this.#byClient.get(clientId);
    if (!lease || !lease.tabs.has(tabId)) return false;
    lease.tabs.delete(tabId);
    if (this.#byTab.get(tabId) === lease) this.#byTab.delete(tabId);
    if (lease.tabId === tabId) lease.tabId = lease.tabs.values().next().value ?? null;
    if (lease.tabs.size === 0) this.#byClient.delete(clientId);
    return true;
  }

  release(clientId) {
    const lease = this.#byClient.get(clientId);
    if (!lease) return false;
    for (const tabId of lease.tabs) if (this.#byTab.get(tabId) === lease) this.#byTab.delete(tabId);
    this.#byClient.delete(clientId);
    return true;
  }

  releaseTab(tabId) {
    const lease = this.#byTab.get(tabId);
    if (!lease) return false;
    this.giveBack(lease.clientId, tabId);
    return true;
  }

  leaseOf(clientId) {
    const lease = this.#byClient.get(clientId);
    return lease ? snapshot(lease) : undefined;
  }

  /** The tab this client was last given, or null when it holds none: no lease, or a lease with no tabs yet. */
  ownedTabId(clientId) {
    const lease = this.#byClient.get(clientId);
    return lease && lease.tabId !== null ? lease.tabId : null;
  }

  /** Every tab this client owns, oldest first. */
  tabsOf(clientId) {
    const lease = this.#byClient.get(clientId);
    return lease ? [...lease.tabs] : [];
  }

  ownerOf(tabId) {
    const lease = this.#byTab.get(tabId);
    return lease ? snapshot(lease) : undefined;
  }

  list() {
    return [...this.#byClient.values()].map(snapshot);
  }

  clear() {
    this.#byTab.clear();
    this.#byClient.clear();
  }
}
