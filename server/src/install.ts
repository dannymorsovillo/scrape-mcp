#!/usr/bin/env node
// Writes the scrape-mcp server entry into an MCP client's config file.
//
// Every client takes the same command/args pair — only the file location and
// the top-level key differ — so this is mostly a matter of knowing where each
// one looks and not clobbering servers the user already configured.

import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import { createInterface } from "node:readline/promises";

// dist/install.js sits beside dist/index.js, which is what clients must spawn.
// Resolved from this file rather than cwd: npm scripts, npx, and a global
// install all run with a different working directory.
const SERVER_ENTRY = resolve(fileURLToPath(import.meta.url), "../index.js");

interface Client {
  id: string;
  label: string;
  /** Key holding the server map. Most use "mcpServers"; a few differ. */
  key: string;
  /** Undefined when the client isn't available on this platform. */
  configPath: () => string | undefined;
  note?: string;
}

/** Per-OS base for app config dirs that follow the VS Code convention. */
function appSupport(app: string): string | undefined {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", app);
    case "win32": {
      const appData = process.env.APPDATA;
      return appData ? join(appData, app) : undefined;
    }
    default:
      return join(home, ".config", app);
  }
}

function claudeDesktopPath(): string | undefined {
  const base = appSupport("Claude");
  return base ? join(base, "claude_desktop_config.json") : undefined;
}

// Cline stores MCP config in the VS Code extension's globalStorage rather than
// anywhere the editor exposes. Only the stock VS Code install is covered here —
// the same extension under Cursor or Windsurf lives beneath their own dirs.
function clinePath(): string | undefined {
  const base = appSupport("Code");
  return base
    ? join(base, "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")
    : undefined;
}

const CLIENTS: Client[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    key: "mcpServers",
    configPath: () => join(process.cwd(), ".mcp.json"),
    note: "project-scoped — run this from the repo you want to scrape from",
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    key: "mcpServers",
    configPath: claudeDesktopPath,
  },
  {
    id: "cursor",
    label: "Cursor",
    key: "mcpServers",
    configPath: () => join(homedir(), ".cursor", "mcp.json"),
  },
  {
    id: "vscode",
    label: "VS Code",
    key: "servers",
    configPath: () => join(process.cwd(), ".vscode", "mcp.json"),
    note: "project-scoped",
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    key: "mcpServers",
    configPath: () => join(homedir(), ".gemini", "settings.json"),
  },
  {
    id: "windsurf",
    label: "Windsurf",
    key: "mcpServers",
    configPath: () => join(homedir(), ".codeium", "windsurf", "mcp_config.json"),
  },
  {
    id: "cline",
    label: "Cline",
    key: "mcpServers",
    configPath: clinePath,
    note: "the VS Code extension",
  },
  {
    id: "zed",
    label: "Zed",
    // Zed calls them context servers, but the value is the same command/args.
    key: "context_servers",
    configPath: () => join(homedir(), ".config", "zed", "settings.json"),
  },
];

const serverBlock = { command: "node", args: [SERVER_ENTRY] };

/** Read a config file, tolerating both "missing" and "present but empty". */
async function readConfig(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Zed and VS Code allow comments in their config; JSON.parse doesn't, and
    // rewriting through it would strip them along with any formatting. Refuse
    // rather than quietly destroy hand-written config.
    throw new Error(
      `${path} isn't plain JSON — it may contain comments or trailing commas.\n` +
        `Add the server by hand instead: re-run with --client=manual to print the block.`,
    );
  }
}

async function install(client: Client): Promise<void> {
  const path = client.configPath();
  if (!path) {
    throw new Error(`Can't locate ${client.label}'s config on this platform.`);
  }

  const config = await readConfig(path);
  const servers = (config[client.key] ?? {}) as Record<string, unknown>;
  const replacing = "scrape-mcp" in servers;

  servers["scrape-mcp"] = serverBlock;
  config[client.key] = servers;

  // Back up anything we're about to rewrite. These files hold other servers'
  // config, and this runs unattended via --client.
  if (replacing || Object.keys(servers).length > 1) {
    await copyFile(path, `${path}.bak`).catch(() => {});
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n");

  console.log(`\n${replacing ? "Updated" : "Added"} scrape-mcp in ${path}`);
  console.log(`  node ${SERVER_ENTRY}`);
  console.log(`\nRestart ${client.label} to pick it up — most clients only read MCP config at startup.`);
}

function printManual(): void {
  console.log("\nAdd this to your client's MCP config by hand:\n");
  console.log(JSON.stringify({ mcpServers: { "scrape-mcp": serverBlock } }, null, 2));
  console.log(
    "\nThe inner block is the same for every MCP client; only the wrapping key\n" +
      'varies — "mcpServers" for most, "servers" for VS Code, "context_servers"\n' +
      "for Zed.",
  );
}

async function main(): Promise<void> {
  const flag = process.argv.find((a) => a.startsWith("--client="))?.split("=")[1];

  if (flag === "manual") return printManual();

  if (flag) {
    const client = CLIENTS.find((c) => c.id === flag);
    if (!client) {
      console.error(`Unknown client "${flag}". Options: ${CLIENTS.map((c) => c.id).join(", ")}, manual`);
      process.exitCode = 1;
      return;
    }
    return install(client);
  }

  if (!process.stdin.isTTY) {
    // Piped or CI: nothing to prompt with, so print the block and let them paste.
    printManual();
    return;
  }

  console.log("Which MCP client?\n");
  CLIENTS.forEach((c, i) => {
    const path = c.configPath();
    const where = path ? path.replace(homedir(), "~") : "unavailable on this platform";
    console.log(`  ${i + 1}) ${c.label}${c.note ? ` — ${c.note}` : ""}`);
    console.log(`     ${where}`);
  });
  console.log(`  ${CLIENTS.length + 1}) Something else — just print the JSON\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Choice [1-${CLIENTS.length + 1}]: `);
  rl.close();

  const choice = Number(answer.trim());
  if (choice === CLIENTS.length + 1) return printManual();

  const client = CLIENTS[choice - 1];
  if (!client) {
    console.error("Not a valid choice.");
    process.exitCode = 1;
    return;
  }
  await install(client);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
