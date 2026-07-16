#!/usr/bin/env node
// Entry point: runs the MCP server on stdio and a WebSocket listener that the
// Chrome extension pushes captured calls into.

import { WebSocketServer } from "ws";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EndpointRegistry } from "./registry.js";
import type { InboundMessage } from "./types.js";

const WS_PORT = Number(process.env.SCRAPE_MCP_WS_PORT ?? 8787);

// stdout carries the MCP protocol — everything else goes to stderr.
function log(...args: unknown[]): void {
  console.error("[scrape-mcp]", ...args);
}

const registry = new EndpointRegistry();

// --- WebSocket ingest -------------------------------------------------------

function startWebSocket(): WebSocketServer {
  const wss = new WebSocketServer({ port: WS_PORT });

  // Captures arrive in bursts (one per keystroke), so coalesce the pushes
  // rather than re-sending the whole list for each one.
  let pending: ReturnType<typeof setTimeout> | undefined;
  const broadcast = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      const msg = JSON.stringify({ type: "endpoints", endpoints: registry.list() });
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN) client.send(msg);
      }
    }, 200);
  };

  wss.on("connection", (socket) => {
    log("extension connected");

    socket.on("message", (raw) => {
      let msg: InboundMessage;
      try {
        msg = JSON.parse(raw.toString()) as InboundMessage;
      } catch {
        log("dropped malformed message");
        return;
      }

      switch (msg.type) {
        case "hello":
          log(`extension v${msg.extensionVersion ?? "unknown"}`);
          break;
        case "capture": {
          const id = registry.ingest(msg.data);
          if (id) log(`captured ${msg.data.method} ${msg.data.url} -> ${id}`);
          broadcast();
          break;
        }
        case "clear":
          registry.clear();
          log("registry cleared by extension");
          broadcast();
          break;
        case "list":
          socket.send(JSON.stringify({ type: "endpoints", endpoints: registry.list() }));
          break;
      }
    });

    socket.on("close", () => log("extension disconnected"));
  });

  wss.on("listening", () => log(`listening for captures on ws://localhost:${WS_PORT}`));

  wss.on("error", (err: NodeJS.ErrnoException) => {
    // Without the port we can never receive a capture, so the registry would
    // stay empty forever while still answering tool calls — an agent reading
    // from this process would silently see nothing. Fail loudly instead.
    if (err.code === "EADDRINUSE") {
      log(
        `FATAL: port ${WS_PORT} is already in use — another scrape-mcp server is ` +
          `probably still running. Kill it (lsof -ti :${WS_PORT} | xargs kill) and retry.`,
      );
    } else {
      log("FATAL: websocket error:", err);
    }
    process.exit(1);
  });

  return wss;
}

// --- MCP tools --------------------------------------------------------------

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "scrape-mcp", version: "0.1.0" });

  server.registerTool(
    "list_endpoints",
    {
      description:
        "List the API endpoints captured from the browser so far, most frequently seen first. " +
        "Returns summaries only — call get_endpoint for schemas and sample bodies.",
      inputSchema: {
        host: z
          .string()
          .optional()
          .describe("Only return endpoints whose host contains this substring."),
      },
    },
    async ({ host }) => {
      let endpoints = registry.list();
      if (host) {
        const needle = host.toLowerCase();
        endpoints = endpoints.filter((e) => e.origin.toLowerCase().includes(needle));
      }
      return json({ count: endpoints.length, endpoints });
    },
  );

  server.registerTool(
    "get_endpoint",
    {
      description:
        "Get the full detail for one captured endpoint: inferred request/response JSON Schemas, " +
        "sample bodies, observed status codes, and which auth headers it requires.",
      inputSchema: {
        id: z.string().describe("Endpoint id from list_endpoints."),
      },
    },
    async ({ id }) => {
      const ep = registry.get(id);
      if (!ep) {
        return {
          content: [{ type: "text" as const, text: `No endpoint with id ${id}.` }],
          isError: true,
        };
      }
      // authHeaderNames is safe to expose; the values stay in the registry.
      return json(ep);
    },
  );

  server.registerTool(
    "replay_endpoint",
    {
      description:
        "Re-issue a captured request, reusing the auth headers observed on the original call. " +
        "Use this to explore an API's behaviour with different parameters.",
      inputSchema: {
        id: z.string().describe("Endpoint id from list_endpoints."),
        path: z
          .string()
          .optional()
          .describe("Concrete path to hit, filling in any {id}/{uuid} placeholders. Defaults to the template."),
        query: z.record(z.string()).optional().describe("Query parameters."),
        body: z.unknown().optional().describe("JSON request body."),
      },
    },
    async ({ id, path, query, body }) => {
      const ep = registry.get(id);
      if (!ep) {
        return {
          content: [{ type: "text" as const, text: `No endpoint with id ${id}.` }],
          isError: true,
        };
      }

      const url = new URL(path ?? ep.pathTemplate, ep.origin);
      for (const [k, v] of Object.entries(query ?? {})) {
        url.searchParams.set(k, v);
      }
      // Re-attach credentials that travelled in the query string. Applied last
      // so the agent can't override them with a value of its own.
      for (const [k, v] of Object.entries(registry.getAuthQuery(id))) {
        url.searchParams.set(k, v);
      }

      const headers: Record<string, string> = { ...registry.getAuthHeaders(id) };
      if (body !== undefined) headers["content-type"] = "application/json";

      try {
        const res = await fetch(url, {
          method: ep.method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        return json({
          status: res.status,
          contentType: res.headers.get("content-type"),
          body: text.slice(0, 50_000),
        });
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Request failed: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "clear_endpoints",
    {
      description: "Discard every captured endpoint and start fresh.",
      inputSchema: {},
    },
    async () => {
      const n = registry.size();
      registry.clear();
      return json({ cleared: n });
    },
  );

  return server;
}

// --- main -------------------------------------------------------------------

async function main(): Promise<void> {
  startWebSocket();
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  log("MCP server ready on stdio");
}

main().catch((err) => {
  log("fatal:", err);
  process.exit(1);
});
