// DSH tool values must be lossless JSON; an `undefined` object property is not. Tool results are built from optional
// fields (a lease tab, a failed step, an origin), so every skill result passes through this once.

export function jsonSafe(value) {
  if (Array.isArray(value)) return value.map(item => jsonSafe(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out[key] = jsonSafe(item);
    }
    return out;
  }
  return value;
}
