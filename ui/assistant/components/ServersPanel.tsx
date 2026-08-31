/**
 * FR-C3/C4 (design §3.2's `ServersPanel.tsx`): list, status, expandable
 * tools, add form, enable/disable toggle, remove, reconnect. Live push via
 * `GET /api/events` is a nice-to-have per design §3.2 — this implementation
 * keeps scope tight with fetch-on-mount + a manual refresh button, which the
 * design explicitly allows as a fallback.
 */
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import * as api from "../api";
import type { PublicServerRecord } from "../api";

export function ServersPanel() {
  const [servers, setServers] = useState<PublicServerRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  async function refresh() {
    setLoading(true);
    try {
      setServers(await api.listServers());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    if (url.trim() === "") return;
    setAdding(true);
    setError(null);
    try {
      await api.addServer(url.trim(), name.trim() || undefined);
      setUrl("");
      setName("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  async function handleToggle(server: PublicServerRecord) {
    try {
      await api.setServerEnabled(server.id, !server.enabled);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRemove(server: PublicServerRecord) {
    if (!server.removable) return;
    try {
      await api.removeServer(server.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleReconnect(server: PublicServerRecord) {
    try {
      await api.reconnectServer(server.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="assistant-servers-panel">
      <div className="assistant-servers-header">
        <button type="button" onClick={() => void refresh()} disabled={loading}>
          Refresh
        </button>
      </div>
      {error && <div className="assistant-notice assistant-notice-warn">{error}</div>}
      <ul className="assistant-servers-list">
        {servers.map((server) => (
          <li key={server.id} className="assistant-server-row">
            <div className="assistant-server-summary">
              <span className={`assistant-server-status assistant-server-status-${server.status}`}>{server.status}</span>
              <span className="assistant-server-name">{server.name}</span>
              <span className="assistant-server-trust">{server.trust}</span>
              <button type="button" onClick={() => toggleExpanded(server.id)}>
                {expanded.has(server.id) ? "Hide tools" : `${server.tools.length} tool(s)`}
              </button>
            </div>
            {server.transport.kind === "streamable-http" && <div className="assistant-server-url">{server.transport.url}</div>}
            {server.lastError && <div className="assistant-server-error">{server.lastError.message}</div>}
            <div className="assistant-server-actions">
              <button type="button" onClick={() => void handleToggle(server)}>
                {server.enabled ? "Disable" : "Enable"}
              </button>
              <button type="button" onClick={() => void handleReconnect(server)}>
                Reconnect
              </button>
              <button
                type="button"
                disabled={!server.removable}
                title={server.removable ? undefined : "The built-in server cannot be removed, only disabled."}
                onClick={() => void handleRemove(server)}
              >
                Remove
              </button>
            </div>
            {expanded.has(server.id) && (
              <ul className="assistant-server-tools">
                {server.tools.map((tool) => (
                  <li key={tool.alias || tool.name}>
                    <code>{tool.name}</code>
                    {tool.appOnly && <span className="assistant-tool-badge">app-only</span>}
                    {!tool.offeredToModel && !tool.appOnly && <span className="assistant-tool-badge">not offered</span>}
                    {tool.widgetUnavailable && <span className="assistant-tool-badge">widget unavailable</span>}
                  </li>
                ))}
                {server.tools.length === 0 && <li className="assistant-server-tools-empty">No tools.</li>}
              </ul>
            )}
          </li>
        ))}
        {servers.length === 0 && !loading && <li className="assistant-servers-empty">No servers.</li>}
      </ul>
      <form className="assistant-add-server-form" onSubmit={handleAdd}>
        <h3>Add server</h3>
        <input type="text" placeholder="https://example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Server URL" />
        <input type="text" placeholder="Display name (optional)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Server name" />
        <button type="submit" disabled={adding || url.trim() === ""}>
          {adding ? "Adding…" : "Add server"}
        </button>
      </form>
    </div>
  );
}
