// The manifest's permission lists. The product must not require a permission that adds an install warning the old
// Nanobrowser did not have, or Chrome turns it off on update until the user accepts.
import { describe, expect, it } from 'vitest';
import { permissionLists } from '../manifest-permissions';

describe('manifest permission lists', () => {
  it('the product requires only what the layer, the panel and the Hub client use', () => {
    const product = permissionLists('product');
    expect([...product.permissions].sort()).toEqual(
      ['alarms', 'debugger', 'scripting', 'sidePanel', 'storage', 'tabs', 'webNavigation'].sort(),
    );
    expect(product.optional_permissions).toEqual([]);
  });

  it('the product does not ask for the permissions the agent features needed', () => {
    const product = permissionLists('product');
    for (const p of ['tabGroups', 'notifications', 'downloads', 'downloads.open', 'offscreen', 'contextMenus'])
      expect([...product.permissions, ...product.optional_permissions]).not.toContain(p);
    expect([...product.permissions, ...product.optional_permissions]).not.toContain('activeTab');
  });

  it('both builds ask for the same thing', () => {
    expect(permissionLists('autorun').permissions).toEqual(permissionLists('product').permissions);
    expect(permissionLists('autorun').optional_permissions).toEqual([]);
  });
});
