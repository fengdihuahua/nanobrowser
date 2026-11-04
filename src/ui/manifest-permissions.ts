// The extension's Chrome permissions, for the build config, the worker, the pages and the checks.
//
// The product asks for nothing optional. What needs a permission says so: reaching the page needs `debugger`, the panel
// and the browser tools need `tabs`, the page border needs `scripting`, and naming the group each task's pages get
// needs `tabGroups`. Notifications, downloads and offscreen went with the model. The autorun build keeps the same list,
// so a check that needs one of them must add it here first.

/** Nothing is optional any more; the list stays so callers have one place to ask. */
export const OPTIONAL_PERMISSIONS = [] as const satisfies readonly chrome.runtime.ManifestOptionalPermission[];

export type OptionalPermission = (typeof OPTIONAL_PERMISSIONS)[number];

/**
 * Always required. None of them adds an install warning the old version did not have: `tabGroups` has no warning of its
 * own, and the previous Nanobrowser asked for it too.
 */
export const REQUIRED_PERMISSIONS = [
  'debugger',
  'tabs',
  'sidePanel',
  'storage',
  'webNavigation',
  'alarms',
  'scripting',
  // `chrome.tabs.group` needs no permission of its own; naming the group it makes needs this one, because the
  // `chrome.tabGroups` namespace is only there when the extension asked for it.
  'tabGroups',
] as const satisfies readonly chrome.runtime.ManifestPermission[];

export interface PermissionLists {
  permissions: chrome.runtime.ManifestPermission[];
  optional_permissions: chrome.runtime.ManifestOptionalPermission[];
}

/** The manifest's two lists: the autorun build installs with everything the product would ever ask for. */
export function permissionLists(build: 'product' | 'autorun'): PermissionLists {
  return build === 'product'
    ? { permissions: [...REQUIRED_PERMISSIONS], optional_permissions: [...OPTIONAL_PERMISSIONS] }
    : { permissions: [...REQUIRED_PERMISSIONS, ...OPTIONAL_PERMISSIONS], optional_permissions: [] };
}
