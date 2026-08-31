import { Router } from "express";
import { RegistryError, type ServerRegistry } from "../registry.js";
import { toPublicServerRecord } from "../types.js";

export function createServersRouter(registry: ServerRegistry): Router {
  const router = Router();

  router.get("/servers", (_req, res) => {
    res.json({ servers: registry.list().map(toPublicServerRecord) });
  });

  router.post("/servers", async (req, res) => {
    const { url, name } = req.body ?? {};
    if (typeof url !== "string" || url.trim() === "") {
      res.status(400).json({ error: "url is required" });
      return;
    }
    try {
      const server = await registry.addHttp(url.trim(), typeof name === "string" ? name : undefined, undefined);
      const status = server.status === "connected" ? 201 : 502;
      res.status(status).json({ server: toPublicServerRecord(server) });
    } catch (err) {
      if (err instanceof RegistryError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.patch("/servers/:id", (req, res) => {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean" });
      return;
    }
    try {
      const server = registry.setEnabled(req.params.id, enabled);
      res.json({ server: toPublicServerRecord(server) });
    } catch (err) {
      if (err instanceof RegistryError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete("/servers/:id", async (req, res) => {
    try {
      await registry.remove(req.params.id);
      res.status(204).end();
    } catch (err) {
      if (err instanceof RegistryError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/servers/:id/reconnect", async (req, res) => {
    try {
      const server = await registry.reconnect(req.params.id);
      res.json({ server: toPublicServerRecord(server) });
    } catch (err) {
      if (err instanceof RegistryError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
