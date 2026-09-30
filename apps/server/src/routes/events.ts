import { Router } from "express";
import { z } from "zod";
import { requireAuth, requirePrincipal } from "../middleware/auth";
import { principalRateLimit } from "../middleware/rateLimit";
import { eventCount, listEvents, removeEvent } from "../events";

/**
 * F6 — historial de eventos (movimiento).
 *
 *  - `GET    /api/v1/events`   lista (JWT o API key con scope `read`)
 *  - `DELETE /api/v1/events/:id` borra uno (sólo `owner`)
 *
 * Por defecto devuelve sólo los de movimiento: las miniaturas de F4 también
 * viven en la tabla `events` y no interesan a un tercero.
 */
export const eventsRouter = Router();

function handleError(res: import("express").Response, error: unknown, context: string) {
  console.error(`[events] ${context}:`, error);
  return res.status(500).json({ error: error instanceof Error ? error.message : "Error interno" });
}

const ListQuerySchema = z.object({
  type: z.string().trim().max(32).optional(),
  cameraId: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

eventsRouter.get("/", requirePrincipal, principalRateLimit, async (req, res) => {
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Consulta inválida", issues: parsed.error.issues });
  }
  try {
    const { type, cameraId, limit } = parsed.data;
    const events = await listEvents({ type, cameraId, limit });
    res.json({ events, count: events.length, total: await eventCount(type ?? "motion") });
  } catch (error) {
    handleError(res, error, "list");
  }
});

eventsRouter.delete("/:id", requireAuth, async (req, res) => {
  if (res.locals.userRole !== "owner") {
    return res.status(403).json({ error: "Sólo el usuario owner puede borrar eventos" });
  }
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "Falta el id" });
    const removed = await removeEvent(id);
    if (!removed) return res.status(404).json({ error: "Evento no encontrado" });
    res.status(204).end();
  } catch (error) {
    handleError(res, error, "remove");
  }
});
