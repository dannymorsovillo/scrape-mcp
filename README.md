# scrape-mcp

Turns the APIs a website uses into tools an AI agent can explore.

A browser extension watches the XHR/fetch calls a page makes and streams them to
a local bridge, which exposes what it learned over MCP. Point it at a site with
no public API docs, click around, and an agent can ask what endpoints exist, what
they return, and replay them with different parameters.

```
Browser tab                Extension             Bridge server          Agent
XHR / fetch --debugger--> background.js --ws--> registry --stdio--> MCP tools
                                        8787    dedupe + schema
```

Requests aren't just logged. They're collapsed into distinct endpoints
(`/users/42/posts` and `/users/43/posts` become one `/users/{id}/posts`), counted,
and a JSON Schema is inferred from the response bodies observed.

## Setup

Requires Node 18+ and a Chromium browser (Chrome, Brave, Edge). From a fresh
clone, all four steps are needed — the agent won't attach without step 2.

**1. Build the server.**

```sh
cd server && npm install && npm run build
```

**2. Point your agent at it.** Run this from the repo root, not from `server/`:

```sh
cd ..                          # back to the repo root after step 1
node server/dist/install.js
```

Pick your client from the list and it writes the config for you. This can't be
committed to the repo and shared: a client spawns the server by absolute path,
so the config only works on the machine that generated it. `.mcp.json` is
gitignored for that reason — everyone runs this once after cloning.

The working directory matters for project-scoped clients (Claude Code, VS Code):
the config is written to the directory you run this from, and that's the project
your agent will have the tools in. Run it from `server/` and the config lands in
`server/`, where no client looks. Claude Desktop and Cursor are configured
per-user, so for those it makes no difference.

**3. Load the extension.** Open `chrome://extensions` (or `brave://extensions`),
enable **Developer mode**, click **Load unpacked**, select the `extension/`
folder.

**4. Restart your client.** Clients read MCP config only at startup, and starting
it is how the server gets spawned. Don't start the server yourself — see
[Running](#running).

## Running

The server speaks MCP over stdio *and* listens for captures on port 8787. The
registry lives in that process's memory, so **only one instance may run** — a
second exits immediately rather than serve a registry nothing feeds.

**With an agent — you never start the server.** The client spawns it, on startup,
from the config the installer wrote in step 2. Launching the client *is* running
the server; there's no command to type. Quitting the client stops it.

This is a plain stdio MCP server, so it works with any MCP client — Claude Code,
Claude Desktop, Cursor, VS Code, Gemini CLI, Windsurf, Cline, Zed, or your own.
MCP is a client-side protocol and the server never talks to a model: there's no
API key here and no inference. Whichever model your client drives — Claude, GPT,
Gemini, something local — makes no difference, and the server can't tell.

The installer (`node server/dist/install.js`) knows these:

| `--client=` | Config it writes |
|---|---|
| `claude-code` | `.mcp.json` (project) |
| `claude-desktop` | `claude_desktop_config.json` |
| `cursor` | `~/.cursor/mcp.json` |
| `vscode` | `.vscode/mcp.json` (project) |
| `gemini-cli` | `~/.gemini/settings.json` |
| `windsurf` | `~/.codeium/windsurf/mcp_config.json` |
| `cline` | the VS Code extension's `cline_mcp_settings.json` |
| `zed` | `~/.config/zed/settings.json` |
| `manual` | prints the block for anything else |

Omit `--client` to pick from a list. It merges `scrape-mcp` in, leaves servers
you already had alone, and backs up whatever it rewrites to `<config>.bak`.

For anything not listed, `--client=manual` prints the block. The inner
`command`/`args` is identical across every MCP client — only the wrapping key
varies (`mcpServers` for most, `servers` for VS Code, `context_servers` for Zed),
so adding a new client by hand is a copy-paste.

**Configs with comments.** Zed and VS Code allow comments and trailing commas in
their JSON, which `JSON.parse` rejects. Rather than rewrite the file and silently
strip your comments, the installer stops and tells you to use `--client=manual`.
Nothing is modified when that happens.

Run it from the directory you want the tools in. Project-scoped configs
(`.mcp.json` for Claude Code, `.vscode/mcp.json`) are written to the current
directory, so running it from `server/` puts them where no client will look.
Claude Desktop and Cursor are per-user, so location doesn't matter for those.

To write it by hand instead:

```jsonc
{
  "mcpServers": {
    "scrape-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/scrape-mcp/server/dist/index.js"]
    }
  }
}
```

The path must be absolute — clients spawn servers with an unpredictable working
directory. Some clients use a `servers` key instead of `mcpServers`, but
`command`/`args` is the same everywhere.

**Port 8787** is a constant of the project, not a local detail: the extension
dials `ws://localhost:8787` hardcoded, and the server listens there by default.
It's localhost-only, so every machine uses the same number without conflict.
Moving it takes *both* sides — `SCRAPE_MCP_WS_PORT` on the server and `WS_URL` in
`extension/background.js`. Change only the env var and the extension keeps dialing
8787, finds nothing, and reads "Bridge offline" forever.

**Standalone**, for browsing without an agent — captures log to stderr and appear
in the popup, which will show **No agent attached**:

```sh
cd server && npm run dev
```

**Don't run both — and know what it looks like when you do.** Both modes are the
same program, and the bridge is simply whichever process is up. Only one can hold
8787: whoever starts first wins, and the loser exits.

`npm run dev` is *not* what makes capture work. The client's server opens 8787
just the same, so in agent mode you get capture and an agent from one process. Run
`npm run dev` alongside and it only gets there first, locking your client out.

The loser's error is invisible. `FATAL: port 8787 already in use` goes to a stderr
your client discards, so the client reports a bare `MCP error -32000: Connection
closed`. And when the dev server is the one that won, **capture keeps working
perfectly while the agent light stays dark** — which reads like a broken agent
rather than a port conflict. If the agent never attaches, check 8787 first:

```sh
lsof -iTCP:8787 -sTCP:LISTEN
```

`dist/index.js` means your client spawned it and the agent is real. `tsx` means a
dev server is up and no agent can attach until it's gone.

## Capturing

Click the **Scrape MCP** icon, check both dots are green (**Bridge connected**
and an agent attached), hit **Start capturing**, then use the site. Endpoints
appear in the popup live.

The second row names the MCP client currently attached — **Agent: Claude Code
2.1** — or reads **No agent attached** when the server is running standalone.
It's a readout, not a switch: stdio allows exactly one client, whichever one
spawned the process, so there's nothing here to choose. If it says no agent while
your client is running, the client never spawned this server — most often because
a `npm run dev` beat it to port 8787. See [Troubleshooting](#troubleshooting).

`hn.algolia.com` is a good test — every keystroke in the search box fires a JSON
API call.

The popup renders the *server's* registry, not its own tally, so it can never
disagree with what the agent sees.

## MCP tools

| Tool | Purpose |
|---|---|
| `list_endpoints` | Everything found, most-seen first. Optional `host` filter. |
| `get_endpoint` | One endpoint in full: schemas, sample bodies, statuses. |
| `replay_endpoint` | Re-issue a request with your captured credentials. |
| `clear_endpoints` | Empty the registry. |

## Credentials

Captured requests carry live session credentials, so they're treated as a one-way
boundary. Values are held privately in the registry and **never** serialized to
the agent. Agents see names and a `requiresAuth` flag:

```jsonc
{
  "queryParams": ["x-algolia-agent"],      // ordinary params
  "authQueryNames": ["x-algolia-api-key"], // name only, value withheld
  "authHeaderNames": ["cookie"],           // name only, value withheld
  "requiresAuth": true
}
```

Both auth headers (`authorization`, `cookie`, `x-api-key`, …) and credentials in
the query string (`?api_key=`, `?access_token=`, vendor-prefixed variants) are
covered. It's enforced by the type system, not by redaction: `Endpoint` has no
field to hold a value.

The exception is `replay_endpoint`, which re-attaches real credentials to re-issue
a request. **An agent calling it acts as you.** Bear that in mind on logged-in
sites.

## Gotchas

- **Capture is per-tab**, and the popup acts on whichever tab is active when you
  click the icon. Clicking **Start** from another tab arms *that* tab.
- **DevTools conflicts** — one debugger client per tab, so **Start** fails if
  DevTools is open on it. The popup shows the error.
- **Captures are lost on restart.** In-memory only; nothing is written to disk.
- **Reloading the extension detaches the debugger.** Hit **Start** again.
- **Only XHR and fetch** are captured — static pages produce nothing.
- **Numeric path segments become `{id}`**, so a version prefix like `/1/indexes/`
  templates to `/{id}/indexes/`.
- Chrome shows a **"started debugging this browser"** banner while capturing.
  It's mandatory for the debugger API; closing it stops capture.

## Troubleshooting

**"No agent attached" while capture works** — the usual one. A standalone
`npm run dev` holds 8787, so your client's server exited the moment it started;
the bridge feeding the popup is the dev server, which has no client on its stdio
and never will. Capture looks healthy because it *is* healthy — it's just not the
process your agent needs. Stop the dev server and restart the client:

```sh
pkill -f "tsx watch src/index.ts"    # then quit and reopen your client
```

Also check the extension has been reloaded since the last pull — the background
script is cached until you reload it at `chrome://extensions`, and a stale one
can't report an agent it doesn't know about.

**"MCP error -32000: Connection closed"** (or a client showing the server as
Failed) — the server process exited on startup, and the closed stdio is all your
client can see. Nearly always the port: something else has 8787, so kill it as
above. Otherwise check `npm run build` has been run, since the config points at
`dist/`, not `src/`. To see the real error, run the client's exact command
yourself — the stderr your client swallowed prints straight out:

```sh
node server/dist/index.js < /dev/null
```

**"Bridge offline"** — no server running, or something else holds the port
(`lsof -i :8787`). The extension reconnects on its own within ~3s. In agent mode
this also means your client isn't running — it owns the server process.

**Port already in use** — a previous server is still alive:
`lsof -ti :8787 | xargs kill`. If it keeps coming back, a `tsx watch` is
respawning it; kill the watcher, not the child.

**Connected but nothing captured** — the debugger isn't attached where you think.
Ask the browser, from the extension's service worker console
(`chrome://extensions` → **service worker**):

```js
chrome.debugger.getTargets().then(t => console.log(t.filter(x => x.attached)))
```

**MCP tools missing** — most clients only read config at startup, so restart
after editing. Check the path is absolute, and rebuild (`npm run build`) after
changing `src/` — the config points at `dist/`.

## Layout

```
extension/       background.js  debugger capture + bridge socket
                 popup.html/js  status, start/stop, live endpoint list
server/src/      index.ts       MCP tools + WebSocket listener
                 install.ts     writes the server into a client's MCP config
                 registry.ts    dedupe, path templating, credential boundary
                 schema.ts      JSON Schema inference
                 types.ts       wire protocol + domain types
```

## Status

Early. Capture, dedup, schema inference, and the credential boundary work
end-to-end. Not yet built: persistence, multi-tab capture, and handling for
credentials in path segments or request bodies.
