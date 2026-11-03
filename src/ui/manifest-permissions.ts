// The extension's Chrome permissions, for the build config, the worker, the pages and the checks.
//
// The product asks for nothing optional: the features that needed tab groups, notifications or saving files (the
// agent's tab groups, its saved files, the rating card) went with the model. The autorun build keeps the same list, so
// a check that needs one of them must add it here first.

/** Nothing is optional any more; the list stays so callers have one place to ask. */
export const OPTIONAL_PERMISSIONS = [] as const satisfies readonly chrome.runtime.ManifestOptionalPermission[];

export type OptionalPermission = (typeof OPTIONAL_PERMISSIONS)[number];

/** Always required. None of them adds a warning the old version did not have. */
export const REQUIRED_PERMISSIONS = [
  'debugger',
  'tabs',
  'sidePanel',
  'storage',
  'webNavigation',
  'alarms',
  'scripting',
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
