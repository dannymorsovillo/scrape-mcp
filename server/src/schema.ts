// Lightweight JSON Schema inference from observed sample bodies.
// Uses genson-js when available; falls back to a tiny built-in inferrer so the
// server never crashes on a malformed sample.

import { createSchema, mergeSchemas } from "genson-js";

/** Parse a raw string body into JSON, or return undefined if it isn't JSON. */
export function tryParseJson(raw: string | undefined): unknown | undefined {
  if (raw == null || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Infer a JSON Schema from one or more sample values. Merging multiple samples
 * lets us mark fields optional when they don't appear in every sample.
 */
export function inferSchema(samples: unknown[]): unknown | undefined {
  const usable = samples.filter((s) => s !== undefined);
  if (usable.length === 0) return undefined;
  try {
    const schemas = usable.map((s) => createSchema(s));
    return schemas.length === 1 ? schemas[0] : mergeSchemas(schemas);
  } catch {
    // Fall back to inferring from just the most recent sample.
    try {
      return createSchema(usable[usable.length - 1]);
    } catch {
      return { type: typeof usable[usable.length - 1] };
    }
  }
}
