// One tab is owned by one client at a time. A client is a DSH session, an MCP client, or a panel.
// A lease may exist before its tab is known (the first action binds it); releasing it clears both directions.

export class LeaseManager {
  #byTab = new Map();
  #byClient = new Map();

  /** Acquires or returns this client's lease. A different tab for the same client is refused until it detaches. */
  acquire(clientId, { tabId = null, sessionId = null, kind = 'unknown' } = {}) {
    const existing = this.#byClient.get(clientId);
    if (existing) {
      if (tabId !== null && existing.tabId !== null && existing.tabId !== tabId) {
        return { ok: false, reason: 'client-busy', leasedTab: existing.tabId, lease: { ...existing } };
      }
      if (tabId !== null && existing.tabId === null) {
        const bound = this.bind(clientId, tabId);
        return bound.ok ? { ...bound, reused: true } : bound;
      }
      return { ok: true, reused: true, lease: { ...existing } };
    }
    if (tabId !== null) {
      const owner = this.#byTab.get(tabId);
      if (owner && owner.clientId !== clientId) return { ok: false, reason: 'tab-leased', owner: { ...owner } };
    }
    const lease = { clientId, sessionId, kind, tabId, since: Date.now() };
    this.#byClient.set(clientId, lease);
    if (tabId !== null) this.#byTab.set(tabId, lease);
    return { ok: true, lease: { ...lease } };
  }

  /** Binds a tab to an existing lease. Refuses a tab owned by another client. */
  bind(clientId, tabId) {
    const lease = this.#byClient.get(clientId);
    if (!lease) return { ok: false, reason: 'no-lease' };
    if (lease.tabId === tabId) return { ok: true, reused: true, lease: { ...lease } };
    const owner = this.#byTab.get(tabId);
    if (owner && owner.clientId !== clientId) return { ok: false, reason: 'tab-leased', owner: { ...owner } };
    if (lease.tabId !== null && this.#byTab.get(lease.tabId) === lease) this.#byTab.delete(lease.tabId);
    lease.tabId = tabId;
    this.#byTab.set(tabId, lease);
    return { ok: true, lease: { ...lease } };
  }

  release(clientId) {
    const lease = this.#byClient.get(clientId);
    if (!lease) return false;
    this.#byClient.delete(clientId);
    if (lease.tabId !== null && this.#byTab.get(lease.tabId) === lease) this.#byTab.delete(lease.tabId);
    return true;
  }

  releaseTab(tabId) {
    const lease = this.#byTab.get(tabId);
    if (!lease) return false;
    this.#byTab.delete(tabId);
    if (this.#byClient.get(lease.clientId) === lease) this.#byClient.delete(lease.clientId);
    return true;
  }

  leaseOf(clientId) {
    const lease = this.#byClient.get(clientId);
    return lease ? { ...lease } : undefined;
  }

  ownerOf(tabId) {
    const lease = this.#byTab.get(tabId);
    return lease ? { ...lease } : undefined;
  }

  list() {
    return [...this.#byClient.values()].map(lease => ({ ...lease }));
  }

  clear() {
    this.#byTab.clear();
    this.#byClient.clear();
  }
}
