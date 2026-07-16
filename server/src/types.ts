// Shared protocol + domain types.

/** A single raw API call captured by the Chrome extension and sent over the WebSocket. */
export interface CaptureMessage {
  type: "capture";
  data: CapturedCall;
}

export interface HelloMessage {
  type: "hello";
  extensionVersion?: string;
}

export interface ClearMessage {
  type: "clear";
}

/** Extension asking for the current registry contents (e.g. popup opened). */
export interface ListMessage {
  type: "list";
}

export type InboundMessage = CaptureMessage | HelloMessage | ClearMessage | ListMessage;

/**
 * Server -> extension. Carries EndpointSummary, the same redacted view the
 * agent gets, so the popup can never render a credential value.
 */
export interface EndpointsMessage {
  type: "endpoints";
  endpoints: EndpointSummary[];
}

export type OutboundMessage = EndpointsMessage;

/** Raw captured call as produced by the extension's debugger/network listener. */
export interface CapturedCall {
  url: string;
  method: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string; // raw string; may be JSON
  status?: number;
  responseContentType?: string;
  responseBody?: string; // raw string; may be JSON
  tabUrl?: string;
  timestamp?: number;
}

/** A deduped, schema-enriched endpoint held in the registry. */
export interface Endpoint {
  id: string;
  method: string;
  origin: string; // scheme://host[:port]
  host: string;
  pathTemplate: string; // e.g. /users/{id}/posts
  queryParams: string[];
  seenCount: number;
  lastSeen: number;
  statuses: number[];
  requestContentType?: string;
  responseContentType?: string;
  requestSchema?: unknown;
  responseSchema?: unknown;
  sampleRequestBody?: unknown;
  sampleResponseBody?: unknown;
  // Header names observed that carry auth (kept for replay). Values are stored
  // separately and never serialized to the agent unless replay is invoked.
  authHeaderNames: string[];
  // Query param names that carry auth (e.g. ?api_key=). Same rule as headers:
  // names are public, values stay in the registry. Excluded from queryParams.
  authQueryNames: string[];
}

/** Public view of an endpoint returned to the agent (no secret values). */
export interface EndpointSummary {
  id: string;
  method: string;
  origin: string;
  pathTemplate: string;
  queryParams: string[];
  seenCount: number;
  responseContentType?: string;
  requiresAuth: boolean;
}
