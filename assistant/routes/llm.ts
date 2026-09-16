import { Router } from "express";
import { LlmManagerError, type LlmManager } from "../llm/manager.js";

export function createLlmRouter(llmManager: LlmManager): Router {
  const router = Router();

  router.get("/llm", (_req, res) => {
    res.json({ current: llmManager.getCurrent(), providers: llmManager.listProviders() });
  });

  router.get("/llm/ollama-models", async (_req, res) => {
    try {
      res.json({ models: await llmManager.listOllamaModels() });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/llm", (req, res) => {
    const { provider, model } = req.body ?? {};
    if (typeof provider !== "string" || provider.trim() === "") {
      res.status(400).json({ error: "provider is required" });
      return;
    }
    try {
      const current = llmManager.switchTo(provider, typeof model === "string" ? model : undefined);
      res.json({ current });
    } catch (err) {
      if (err instanceof LlmManagerError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
