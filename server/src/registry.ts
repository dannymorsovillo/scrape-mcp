// Endpoint registry: normalizes raw captured calls into deduped endpoints,
// accumulates samples, and infers request/response schemas.

import { createHash } from "node:crypto";
import type { CapturedCall, Endpoint, EndpointSummary } from "./types.js";
import { inferSchema, tryParseJson } from "./schema.js";

const MAX_SAMPLES = 15;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{16,}$/i;
const AUTH_HEADER_RE = /^(authorization|cookie|x-api-key|x-auth-token|x-csrf-token|api-key)$/i;

// Credentials also travel in query strings (?api_key=, ?access_token=, and
// vendor-prefixed variants like x-algolia-api-key). Matched as a delimited word
// so "query" or "application-id" don't trip it.
const AUTH_QUERY_RE =
  /(^|[-_.])(api[-_]?key|apikey|access[-_]?token|auth[-_]?token|token|auth|secret|password|passwd|signature|sig|session)([-_.]|$)/i;

/** Collapse a single path segment to a placeholder if it looks dynamic. */
function templateSegment(seg: string): string {
  if (seg === "") return seg;
  if (/^\d+$/.test(seg)) return "{id}";
  if (UUID_RE.test(seg)) return "{uuid}";
  if (HEX_RE.test(seg)) return "{hash}";
  return seg;
}

function templatePath(pathname: string): string {
  return pathname
    .split("/")
    .map(templateSegment)
    .join("/");
}

interface RegistryEntry {
  endpoint: Endpoint;
  requestSamples: unknown[];
  responseSamples: unknown[];
  // Latest observed auth header values, kept private for replay only.
  authHeaders: Record<string, string>;
  // Latest observed auth query param values. Private for the same reason.
  authQuery: Record<string, string>;
}

export class EndpointRegistry {
  private entries = new Map<string, RegistryEntry>();

  /** Ingest one raw captured call. Returns the endpoint id it mapped to. */
  ingest(call: CapturedCall): string | undefined {
    let parsed: URL;
    try {
      parsed = new URL(call.url);
    } catch {
      return undefined;
    }

    const method = (call.method || "GET").toUpperCase();
    const pathTemplate = templatePath(parsed.pathname);
    const origin = parsed.origin;
    const id = createHash("sha1")
      .update(`${method} ${origin}${pathTemplate}`)
      .digest("hex")
      .slice(0, 12);

    let entry = this.entries.get(id);
    if (!entry) {
      entry = {
        endpoint: {
          id,
          method,
          origin,
          host: parsed.host,
          pathTemplate,
          queryParams: [],
          seenCount: 0,
          lastSeen: 0,
          statuses: [],
          authHeaderNames: [],
          authQueryNames: [],
        },
        requestSamples: [],
        responseSamples: [],
        authHeaders: {},
        authQuery: {},
      };
      this.entries.set(id, entry);
    }

    const ep = entry.endpoint;
    ep.seenCount += 1;
    ep.lastSeen = call.timestamp ?? Date.now();

    // Merge query params. Credential-bearing ones are diverted into the private
    // map so their values never reach the agent — same rule as auth headers.
    for (const [key, value] of parsed.searchParams) {
      if (AUTH_QUERY_RE.test(key)) {
        entry.authQuery[key] = value;
        if (!ep.authQueryNames.includes(key)) ep.authQueryNames.push(key);
      } else if (!ep.queryParams.includes(key)) {
        ep.queryParams.push(key);
      }
    }

    // Track statuses.
    if (call.status && !ep.statuses.includes(call.status)) {
      ep.statuses.push(call.status);
    }

    // Content types.
    if (call.responseContentType) ep.responseContentType = call.responseContentType;
    const reqCt = call.requestHeaders?.["content-type"] ?? call.requestHeaders?.["Content-Type"];
    if (reqCt) ep.requestContentType = reqCt;

    // Auth headers (names public, values private).
    if (call.requestHeaders) {
      for (const [k, v] of Object.entries(call.requestHeaders)) {
        if (AUTH_HEADER_RE.test(k)) {
          entry.authHeaders[k] = v;
          if (!ep.authHeaderNames.includes(k)) ep.authHeaderNames.push(k);
        }
      }
    }

    // Sample bodies + schema inference.
    const reqJson = tryParseJson(call.requestBody);
    if (reqJson !== undefined) {
      pushSample(entry.requestSamples, reqJson);
      ep.sampleRequestBody = reqJson;
      ep.requestSchema = inferSchema(entry.requestSamples);
    }
    const resJson = tryParseJson(call.responseBody);
    if (resJson !== undefined) {
      pushSample(entry.responseSamples, resJson);
      ep.sampleResponseBody = resJson;
      ep.responseSchema = inferSchema(entry.responseSamples);
    }

    return id;
  }

  list(): EndpointSummary[] {
    return [...this.entries.values()]
      .map((e) => e.endpoint)
      .sort((a, b) => b.seenCount - a.seenCount)
      .map(toSummary);
  }

  get(id: string): Endpoint | undefined {
    return this.entries.get(id)?.endpoint;
  }

  /** Private replay data for an endpoint (auth header values). */
  getAuthHeaders(id: string): Record<string, string> {
    return this.entries.get(id)?.authHeaders ?? {};
  }

  /** Private replay data for an endpoint (auth query param values). */
  getAuthQuery(id: string): Record<string, string> {
    return this.entries.get(id)?.authQuery ?? {};
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}

function pushSample(arr: unknown[], value: unknown): void {
  arr.push(value);
  if (arr.length > MAX_SAMPLES) arr.shift();
}

function toSummary(ep: Endpoint): EndpointSummary {
  return {
    id: ep.id,
    method: ep.method,
    origin: ep.origin,
    pathTemplate: ep.pathTemplate,
    queryParams: ep.queryParams,
    seenCount: ep.seenCount,
    responseContentType: ep.responseContentType,
    requiresAuth: ep.authHeaderNames.length > 0 || ep.authQueryNames.length > 0,
  };
}
