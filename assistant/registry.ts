/**
 * ServerRegistry: owns one MCP `Client` (+ transport) per connected server,
 * every one of them a user-added or seeded server connected over Streamable
 * HTTP (D-1). Emits status events consumed by routes/events.ts.
 */
import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ErrorCode,
  McpError,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { logError, logServerStatus } from "./log.js";
import { assignAliases, buildRegisteredTools, refreshOfferedToModel, slugify } from "./tools.js";
import type { ServerId, ServerRecord } from "./types.js";

const CLIENT_INFO = { name: "income-mcp-assistant", version: "0.1.0" };

export class RegistryError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type RegistryEvent = { t: "server_status"; server: ServerRecord } | { t: "server_removed"; serverId: ServerId };

interface Connection {
  client: Client;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export class ServerRegistry {
  private servers = new Map<ServerId, ServerRecord>();
  private connections = new Map<ServerId, Connection>();
  private emitter = new EventEmitter();

  constructor(private config: Config) {
    this.emitter.setMaxListeners(50);
  }

  onEvent(cb: (e: RegistryEvent) => void): () => void {
    this.emitter.on("event", cb);
    return () => this.emitter.off("event", cb);
  }

  private emit(e: RegistryEvent): void {
    this.emitter.emit("event", e);
  }

  private emitStatus(server: ServerRecord): void {
    logServerStatus(server.id, server.status, server.lastError?.message);
    this.emit({ t: "server_status", server });
  }

  list(): ServerRecord[] {
    return [...this.servers.values()];
  }

  get(id: ServerId): ServerRecord | undefined {
    return this.servers.get(id);
  }

  private mustGet(id: ServerId): ServerRecord {
    const server = this.servers.get(id);
    if (!server) throw new RegistryError(404, `Unknown server "${id}"`);
    return server;
  }

  getConnectedClient(id: ServerId): Client | undefined {
    const server = this.servers.get(id);
    if (!server || server.status !== "connected") return undefined;
    return this.connections.get(id)?.client;
  }

  // --- connecting ------------------------------------------------------

  // `trust` defaults to "user" — the runtime "Add server" UI never passes anything else, since a
  // human clicking "add" has no way to vouch for a server the way a startup-config seed can. Only
  // `ASSISTANT_SERVERS` seeds (main.ts) can request "builtin": that's a deliberate operator decision
  // made in `.env`, not something reachable from the browser.
  async addHttp(
    url: string,
    name: string | undefined,
    headers: Record<string, string> | undefined,
    trust: "builtin" | "user" = "user",
  ): Promise<ServerRecord> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new RegistryError(400, `"${url}" is not a valid URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new RegistryError(400, "Only http:// and https:// URLs are supported");
    }
    const dup = [...this.servers.values()].find((s) => s.transport.kind === "streamable-http" && s.transport.url === url);
    if (dup) throw new RegistryError(409, `This URL is already added as "${dup.name}"`);

    const displayName = this.dedupeName(name?.trim() || parsed.host || "server");
    const id = this.generateId(displayName);
    const server: ServerRecord = {
      id,
      name: displayName,
      transport: { kind: "streamable-http", url, headers },
      trust,
      removable: trust !== "builtin",
      enabled: true,
      status: "connecting",
      tools: [],
    };
    this.servers.set(id, server);
    this.emitStatus(server);

    const client = new Client(CLIENT_INFO, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(parsed, headers ? { requestInit: { headers } } : undefined);
    await this.establish(server, client, transport);
    return server;
  }

  async reconnect(id: ServerId): Promise<ServerRecord> {
    const server = this.mustGet(id);
    await this.closeConnection(id);
    server.status = "connecting";
    server.lastError = undefined;
    this.emitStatus(server);

    const client = new Client(CLIENT_INFO, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(
      new URL(server.transport.url),
      server.transport.headers ? { requestInit: { headers: server.transport.headers } } : undefined,
    );
    await this.establish(server, client, transport);
    return server;
  }

  private async establish(server: ServerRecord, client: Client, transport: Transport): Promise<void> {
    try {
      await withTimeout(client.connect(transport), this.config.connectTimeoutMs, `connect:${server.id}`);
      await withTimeout(this.finishConnect(server, client), this.config.connectTimeoutMs, `listTools:${server.id}`);
    } catch (err) {
      server.status = "error";
      server.lastError = { message: errMessage(err), code: "SERVER_CONNECT_FAILED", at: new Date().toISOString() };
      logError(`registry:${server.id}`, err);
    }
    this.emitStatus(server);
  }

  private async finishConnect(server: ServerRecord, client: Client): Promise<void> {
    const version = client.getServerVersion();
    server.serverInfo = version ? { name: version.name, version: version.version } : undefined;
    server.serverCapabilities = client.getServerCapabilities() as Record<string, unknown> | undefined;

    const { tools: rawTools } = await client.listTools();
    const { tools, dropped } = buildRegisteredTools(rawTools, server.name);
    server.tools = tools;
    if (dropped.length > 0) {
      console.warn(
        `[registry] server="${server.name}" dropped ${dropped.length} tool(s): ${dropped.map((d) => `${d.name}(${d.reason})`).join(", ")}`,
      );
    }
    server.status = "connected";
    server.connectedAt = new Date().toISOString();
    this.connections.set(server.id, { client });

    refreshOfferedToModel(server);
    assignAliases(this.list());

    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      await this.refreshTools(server.id);
    });

    // D-11 / review G-7: we advertise no client capabilities, so sampling /
    // elicitation / roots requests from the server already fail with
    // "method not found" automatically. This makes that decline visible
    // once per server instead of silent.
    client.fallbackRequestHandler = async (request) => {
      if (!server.declinedCapabilityNotice) {
        server.declinedCapabilityNotice = true;
        console.warn(`[registry] server="${server.name}" requested "${request.method}", which this host does not support`);
        this.emitStatus(server);
      }
      throw new McpError(ErrorCode.MethodNotFound, `Method not found: ${request.method}`);
    };
  }

  async refreshTools(id: ServerId): Promise<void> {
    const server = this.servers.get(id);
    const client = this.connections.get(id)?.client;
    if (!server || !client) return;
    try {
      const { tools: rawTools } = await client.listTools();
      const { tools, dropped } = buildRegisteredTools(rawTools, server.name);
      server.tools = tools;
      if (dropped.length > 0) {
        console.warn(`[registry] server="${server.name}" dropped ${dropped.length} tool(s) on refresh`);
      }
      refreshOfferedToModel(server);
      assignAliases(this.list());
      this.emitStatus(server);
    } catch (err) {
      logError(`registry:refreshTools:${id}`, err);
    }
  }

  // --- mutation ----------------------------------------------------------

  setEnabled(id: ServerId, enabled: boolean): ServerRecord {
    const server = this.mustGet(id);
    server.enabled = enabled;
    refreshOfferedToModel(server);
    this.emitStatus(server);
    return server;
  }

  async remove(id: ServerId): Promise<void> {
    const server = this.mustGet(id);
    if (!server.removable) throw new RegistryError(409, "The built-in server cannot be removed, only disabled.");
    await this.closeConnection(id);
    this.servers.delete(id);
    this.emit({ t: "server_removed", serverId: id });
  }

  private async closeConnection(id: ServerId): Promise<void> {
    const conn = this.connections.get(id);
    this.connections.delete(id);
    if (conn) {
      try {
        await conn.client.close();
      } catch (err) {
        logError(`registry:close:${id}`, err);
      }
    }
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.connections.keys()]) await this.closeConnection(id);
  }

  private dedupeName(name: string): string {
    const existing = new Set(this.list().map((s) => s.name));
    if (!existing.has(name)) return name;
    let n = 2;
    while (existing.has(`${name} (${n})`)) n++;
    return `${name} (${n})`;
  }

  private generateId(displayName: string): ServerId {
    const base = slugify(displayName);
    let id = base;
    let n = 2;
    while (this.servers.has(id)) id = `${base}-${n++}`;
    return id;
  }

  // --- proxied MCP calls (used by routes/mcp.ts on behalf of widgets) ----

  async callTool(serverId: ServerId, name: string, args: Record<string, unknown>, timeoutMs: number): Promise<CallToolResult> {
    const client = this.getConnectedClient(serverId);
    if (!client) throw new RegistryError(409, `Server "${serverId}" is not connected`);
    return client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs }) as Promise<CallToolResult>;
  }

  async readResource(serverId: ServerId, uri: string, timeoutMs: number): Promise<ReadResourceResult> {
    const client = this.getConnectedClient(serverId);
    if (!client) throw new RegistryError(409, `Server "${serverId}" is not connected`);
    return client.readResource({ uri }, { timeout: timeoutMs });
  }

  async listResources(serverId: ServerId, cursor: string | undefined, timeoutMs: number) {
    const client = this.getConnectedClient(serverId);
    if (!client) throw new RegistryError(409, `Server "${serverId}" is not connected`);
    return client.listResources(cursor ? { cursor } : undefined, { timeout: timeoutMs });
  }

  async listResourceTemplates(serverId: ServerId, cursor: string | undefined, timeoutMs: number) {
    const client = this.getConnectedClient(serverId);
    if (!client) throw new RegistryError(409, `Server "${serverId}" is not connected`);
    return client.listResourceTemplates(cursor ? { cursor } : undefined, { timeout: timeoutMs });
  }

  async listPrompts(serverId: ServerId, cursor: string | undefined, timeoutMs: number) {
    const client = this.getConnectedClient(serverId);
    if (!client) throw new RegistryError(409, `Server "${serverId}" is not connected`);
    return client.listPrompts(cursor ? { cursor } : undefined, { timeout: timeoutMs });
  }
}
