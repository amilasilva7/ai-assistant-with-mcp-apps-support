/**
 * Owns the currently-active `LlmProvider` and lets it be swapped at runtime
 * (the UI's model switcher — routes/llm.ts) without restarting the process.
 * `config` stays the source of truth for credentials/keys read at boot;
 * switching only ever picks among providers those credentials already
 * cover (see `configuredReason`) — there is no way to type a new API key in
 * from the browser, deliberately: that would mean a client-supplied secret
 * flowing into server config at runtime.
 */
import { AnthropicProvider } from "./anthropic.js";
import { BedrockProvider } from "./bedrock.js";
import { GeminiProvider } from "./gemini.js";
import { OllamaProvider } from "./ollama.js";
import type { LlmProvider } from "./provider.js";
import type { Config } from "../config.js";

export type LlmProviderId = "anthropic" | "gemini" | "ollama" | "bedrock";

const PROVIDER_IDS: LlmProviderId[] = ["anthropic", "gemini", "ollama", "bedrock"];

const LABELS: Record<LlmProviderId, string> = {
  anthropic: "Anthropic (Claude)",
  gemini: "Google Gemini",
  ollama: "Ollama (local)",
  bedrock: "AWS Bedrock",
};

// A short, curated starting point per provider — not exhaustive (Anthropic
// and Gemini both rev model ids faster than this file would stay accurate),
// which is why the UI always also accepts a free-typed model id.
const SUGGESTED_MODELS: Record<LlmProviderId, string[]> = {
  anthropic: ["claude-sonnet-4-5-20250929", "claude-opus-4-1-20250805", "claude-haiku-4-5-20251001"],
  gemini: ["gemini-3.6-flash", "gemini-3.6-pro"],
  ollama: ["llama3.1:8b", "llama3.1:70b", "qwen2.5:7b"],
  bedrock: ["anthropic.claude-sonnet-4-5-20250929-v1:0", "us.anthropic.claude-opus-4-1-20250805-v1:0"],
};

const DEFAULT_MODELS: Record<LlmProviderId, string> = {
  anthropic: "claude-sonnet-4-5-20250929",
  gemini: "gemini-3.6-flash",
  ollama: "llama3.1:8b",
  bedrock: "anthropic.claude-sonnet-4-5-20250929-v1:0",
};

export interface LlmProviderInfo {
  id: LlmProviderId;
  label: string;
  configured: boolean;
  /** Set when `configured` is false: why, so the UI can explain it in place rather than just graying an option out. */
  reason?: string;
  defaultModel: string;
  suggestedModels: string[];
}

export class LlmManagerError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "LlmManagerError";
    this.status = status;
  }
}

export class LlmManager {
  private providerId: LlmProviderId;
  private model: string;
  private instance: LlmProvider;

  constructor(private config: Config) {
    this.providerId = config.llmProvider;
    this.model = config.model;
    this.instance = this.build(this.providerId, this.model);
  }

  private build(id: LlmProviderId, model: string): LlmProvider {
    switch (id) {
      case "gemini":
        return new GeminiProvider(this.config.geminiApiKey, model, this.config.maxOutputTokens);
      case "ollama":
        return new OllamaProvider(this.config.ollamaBaseUrl, model);
      case "bedrock":
        return new BedrockProvider(this.config.awsRegion, model, this.config.maxOutputTokens);
      case "anthropic":
        return new AnthropicProvider(this.config.anthropicApiKey, model, this.config.maxOutputTokens);
    }
  }

  /** The live provider instance — call this per turn (routes/chat.ts), never cache the result, since a switch swaps it out. */
  getProvider(): LlmProvider {
    return this.instance;
  }

  getCurrent(): { provider: LlmProviderId; model: string } {
    return { provider: this.providerId, model: this.model };
  }

  private configuredReason(id: LlmProviderId): string | undefined {
    if (id === "anthropic" && !this.config.anthropicApiKey) return "ANTHROPIC_API_KEY is not set.";
    if (id === "gemini" && !this.config.geminiApiKey) return "GEMINI_API_KEY is not set.";
    if (id === "bedrock" && !this.config.awsRegion) return "AWS_REGION (or AWS_DEFAULT_REGION) is not set.";
    return undefined;
  }

  listProviders(): LlmProviderInfo[] {
    return PROVIDER_IDS.map((id) => {
      const reason = this.configuredReason(id);
      return {
        id,
        label: LABELS[id],
        configured: !reason,
        reason,
        defaultModel: DEFAULT_MODELS[id],
        suggestedModels: SUGGESTED_MODELS[id],
      };
    });
  }

  /** Ollama has no fixed catalog — this asks the running server what's actually pulled, for the UI's model dropdown. */
  async listOllamaModels(): Promise<string[]> {
    let res: Response;
    try {
      res = await fetch(`${this.config.ollamaBaseUrl}/api/tags`);
    } catch (err) {
      throw new Error(`Could not reach Ollama at ${this.config.ollamaBaseUrl} (${err instanceof Error ? err.message : String(err)})`);
    }
    if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => m.name);
  }

  switchTo(providerIdRaw: string, modelRaw: string | undefined): { provider: LlmProviderId; model: string } {
    if (!PROVIDER_IDS.includes(providerIdRaw as LlmProviderId)) {
      throw new LlmManagerError(`Unknown provider "${providerIdRaw}".`);
    }
    const id = providerIdRaw as LlmProviderId;
    const reason = this.configuredReason(id);
    if (reason) {
      throw new LlmManagerError(`${LABELS[id]} is not configured: ${reason} Add it to .env and restart the assistant, then try again.`);
    }
    const model = modelRaw?.trim() || DEFAULT_MODELS[id];
    this.instance = this.build(id, model);
    this.providerId = id;
    this.model = model;
    return this.getCurrent();
  }
}
