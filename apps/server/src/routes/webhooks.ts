import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { createWebhook, listWebhooks, removeWebhook, webhookInfo } from "../webhooks";

/**
 * F6 — gestión de webhooks.
 *
 *  - `GET    /api/v1/webhooks`     lista (sin secretos) + estadísticas
 *  - `POST   /api/v1/webhooks`     crea uno → el secreto se devuelve **una vez**
 *  - `DELETE /api/v1/webhooks/:id` lo elimina
 *
 * Sólo `owner`: quien crea un webhook puede hacer que el server envíe peticiones
 * a una URL. El secreto permite verificar la firma HMAC de cada envío.
 */
export const webhooksRouter = Router();

function handleError(res: import("express").Response, error: unknown, context: string) {
  console.error(`[webhooks] ${context}:`, error);
  return res.status(500).json({ error: error instanceof Error ? error.message : "Error interno" });
}

const CreateWebhookSchema = z.object({
  url: z.string().trim().url("URL no válida").max(500),
  secret: z.string().trim().min(8, "El secreto necesita 8 caracteres").max(128).optional(),
  events: z.array(z.enum(["motion", "clip"])).min(1).max(5).optional(),
});

webhooksRouter.get("/", requireAuth, (_req, res) => {
  res.json({ webhooks: listWebhooks(), stats: webhookInfo() });
});

webhooksRouter.post("/", requireAuth, (req, res) => {
  if (res.locals.userRole !== "owner") {
    return res.status(403).json({ error: "Sólo el usuario owner puede crear webhooks" });
  }
  const parsed = CreateWebhookSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Payload inválido", issues: parsed.error.issues });
  }
  try {
    const { webhook, secret } = createWebhook(parsed.data);
    res.status(201).json({
      webhook,
      secret, // única vez: sirve para verificar la firma de los envíos
      warning: "Guarda el secreto ahora: no volverá a mostrarse.",
      signature: {
        header: "x-cameras-signature",
        scheme: "HMAC-SHA256 sobre `${x-cameras-timestamp}.${body}` (sha256=<hex>)",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(400).json({ error: message });
  }
});

webhooksRouter.delete("/:id", requireAuth, (req, res) => {
  if (res.locals.userRole !== "owner") {
    return res.status(403).json({ error: "Sólo el usuario owner puede borrar webhooks" });
  }
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: "Falta el id" });
  if (!removeWebhook(id)) return res.status(404).json({ error: "Webhook no encontrado" });
  res.status(204).end();
});
