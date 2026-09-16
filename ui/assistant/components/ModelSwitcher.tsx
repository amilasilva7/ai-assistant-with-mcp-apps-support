/**
 * Lets the user switch which LLM provider/model answers the chat, without a
 * restart — a thin client over GET/POST /api/llm (assistant/routes/llm.ts,
 * backed by assistant/llm/manager.ts). Sits directly under the composer so
 * it reads as "what's answering me" rather than a buried settings toggle.
 *
 * Only providers with credentials already in the server's .env are
 * selectable (backend enforces this too — this UI just explains why an
 * option is greyed out instead of letting the user hit a confusing error).
 * There is deliberately no field to type in a new API key here: that would
 * mean a client-supplied secret reaching server config at runtime.
 */
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import * as api from "../api";
import type { LlmProviderId, LlmProviderInfo } from "../api";

const CUSTOM = "__custom__";

export function ModelSwitcher() {
  const [providers, setProviders] = useState<LlmProviderInfo[]>([]);
  const [provider, setProvider] = useState<LlmProviderId | null>(null);
  const [model, setModel] = useState("");
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const [customValue, setCustomValue] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const settings = await api.getLlmSettings();
        if (cancelled) return;
        setProviders(settings.providers);
        setProvider(settings.current.provider);
        setModel(settings.current.model);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (provider !== "ollama") return;
    let cancelled = false;
    (async () => {
      try {
        const models = await api.getOllamaModels();
        if (!cancelled) {
          setOllamaModels(models);
          setOllamaError(null);
        }
      } catch (err) {
        if (!cancelled) setOllamaError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const currentInfo = useMemo(() => providers.find((p) => p.id === provider), [providers, provider]);

  const modelOptions = useMemo(() => {
    const base = provider === "ollama" && ollamaModels.length > 0 ? ollamaModels : (currentInfo?.suggestedModels ?? []);
    return model && !base.includes(model) ? [model, ...base] : base;
  }, [provider, ollamaModels, currentInfo, model]);

  async function apply(nextProvider: LlmProviderId, nextModel: string) {
    setSaving(true);
    setError(null);
    try {
      const current = await api.setLlmSettings(nextProvider, nextModel);
      setProvider(current.provider);
      setModel(current.model);
      setCustomMode(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function handleProviderChange(nextProvider: LlmProviderId) {
    const info = providers.find((p) => p.id === nextProvider);
    if (!info?.configured) return;
    setCustomMode(false);
    void apply(nextProvider, info.defaultModel);
  }

  function handleModelSelectChange(value: string) {
    if (value === CUSTOM) {
      setCustomValue(model);
      setCustomMode(true);
      return;
    }
    if (!provider) return;
    void apply(provider, value);
  }

  function handleCustomSubmit(e: FormEvent) {
    e.preventDefault();
    if (!provider || customValue.trim() === "") return;
    void apply(provider, customValue.trim());
  }

  const unconfigured = providers.filter((p) => !p.configured);

  if (loading) {
    return <div className="assistant-model-switcher assistant-model-switcher-loading">Loading model settings…</div>;
  }

  return (
    <div className="assistant-model-switcher">
      <div className="assistant-model-switcher-row">
        <span className="assistant-model-switcher-label">Model</span>
        <select
          className="assistant-model-switcher-select"
          aria-label="LLM provider"
          value={provider ?? ""}
          disabled={saving}
          onChange={(e) => handleProviderChange(e.target.value as LlmProviderId)}
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id} disabled={!p.configured}>
              {p.label}
              {p.configured ? "" : " — not configured"}
            </option>
          ))}
        </select>
        <select
          className="assistant-model-switcher-select"
          aria-label="Model"
          value={customMode ? CUSTOM : model}
          disabled={saving || !provider}
          onChange={(e) => handleModelSelectChange(e.target.value)}
        >
          {modelOptions.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value={CUSTOM}>Custom model…</option>
        </select>
        {saving && <span className="assistant-model-switcher-status">Switching…</span>}
        {!saving && savedFlash && <span className="assistant-model-switcher-status assistant-model-switcher-ok">✓ using {model}</span>}
      </div>

      {customMode && (
        <form className="assistant-model-switcher-custom" onSubmit={handleCustomSubmit}>
          <input
            type="text"
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            placeholder={provider === "ollama" ? "e.g. llama3.1:70b" : "Exact model id"}
            aria-label="Custom model id"
            autoFocus
          />
          <button type="submit" disabled={customValue.trim() === "" || saving}>
            Use
          </button>
          <button type="button" onClick={() => setCustomMode(false)}>
            Cancel
          </button>
        </form>
      )}

      {provider === "ollama" && ollamaError && (
        <div className="assistant-model-switcher-hint">Could not list local Ollama models ({ollamaError}) — pick "Custom model…" to type one in.</div>
      )}
      {error && <div className="assistant-notice assistant-notice-warn">{error}</div>}
      {unconfigured.length > 0 && (
        <div className="assistant-model-switcher-hint">
          Not available: {unconfigured.map((p) => `${p.label} (${p.reason})`).join(" · ")}
        </div>
      )}
    </div>
  );
}
