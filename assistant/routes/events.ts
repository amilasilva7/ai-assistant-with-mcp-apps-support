import { Router } from "express";
import type { ServerRegistry } from "../registry.js";
import { toPublicServerRecord } from "../types.js";

export function createEventsRouter(registry: ServerRegistry): Router {
  const router = Router();

  router.get("/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });

    const unsubscribe = registry.onEvent((e) => {
      const line = e.t === "server_status" ? { t: "server_status", server: toPublicServerRecord(e.server) } : e;
      res.write(JSON.stringify(line) + "\n");
    });

    req.on("close", () => unsubscribe());
  });

  return router;
}
