import http from "node:http";
import express from "express";
import cors from "cors";
import { API } from "@cameras/protocol";
import { config, hasSupabase } from "./config";
import { seedDemo, store } from "./store";
import { healthRouter } from "./routes/health";
import { storageRouter } from "./routes/storage";
import { camerasRouter, streamsRouter } from "./routes/cameras";
import { agentRouter } from "./routes/agent";
import { authRouter } from "./routes/auth";
import { keysRouter } from "./routes/keys";
import { eventsRouter } from "./routes/events";
import { webhooksRouter } from "./routes/webhooks";
import { discoverRouter } from "./routes/discover";
import { docsRouter } from "./routes/docs";
import { seedWebhooksFromEnv, loadPersistedWebhooks } from "./webhooks";
import { runRetention, retentionStatus } from "./retention";
import { verifySchema } from "./db/supabase";
import { createGateway } from "./ws/gateway";
import { globalRateLimit } from "./middleware/rateLimit";

const app = express();

app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: "1mb" }));

// el agent habla por HTTP interno: fuera del rate limit (sólo sale hacia LAN)
app.use("/api/agent", agentRouter);

// F5: techo global por IP para TODO lo público de la API
app.use("/api", globalRateLimit);

app.use(healthRouter);
app.use("/api/auth", authRouter);
app.use(API.cameras, camerasRouter);
app.use("/api/v1/streams", streamsRouter); // F5: MJPEG para terceros
app.use(API.keys, keysRouter);
app.use(API.events, eventsRouter); // F6: historial de eventos
app.use(API.webhooks, webhooksRouter); // F6: avisos a otras apps
app.use(API.storage, storageRouter); // uso de almacenamiento + purga manual
app.use(API.discover, discoverRouter); // F8: búsqueda de cámaras en la LAN (la hace el agent)
app.use(docsRouter); // /api/docs y /api/openapi.json

// 404 JSON (evita que un 404 en HTML rompa a los clientes de API)
app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada", path: req.path });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[server] error no controlado:", err);
  res.status(500).json({ error: "Error interno del servidor" });
});

const httpServer = http.createServer(app);
const gateway = createGateway(httpServer);
// el health expone cuántos agents/espectadores hay conectados
app.locals.gateway = gateway;

// F3: el server pedirá al agent que arranque/pare streams según espectadores.
gateway.onStreamRequest(({ cameraId, profile }) => {
  console.log(`[gateway] solicitar stream -> ${cameraId} (${profile})`);
});
gateway.onStreamRelease((cameraId) => {
  console.log(`[gateway] sin espectadores -> parar ${cameraId}`);
});

async function bootstrap() {
  if (hasSupabase) {
    try {
      const schema = await verifySchema(true);
      if (!schema.ok) {
        console.warn(`\n  ⚠️  Supabase: faltan tablas (${schema.missing.join(", ")})`);
        console.warn("     Ejecuta supabase/migrations/0001_init.sql en el SQL Editor");
        console.warn("     Verifica con: npm run db:ping\n");
      } else {
        console.log("  ✅ Supabase: esquema completo\n");
      }
    } catch (error) {
      console.warn("  ⚠️  No se pudo verificar el esquema:", error instanceof Error ? error.message : error);
    }
  }

  try {
    await seedDemo();
  } catch (error) {
    console.warn("[server] seed omitido:", error instanceof Error ? error.message : error);
  }

  // F6: webhooks declarados en .env (WEBHOOK_URL / WEBHOOK_SECRET) + los
  // guardados en Supabase (sobreviven reinicios; ver 0002_webhooks.sql)
  seedWebhooksFromEnv();
  await loadPersistedWebhooks().catch(() => undefined);

  // Retención diaria de eventos/assets viejos (primera pasada al minuto para
  // no frenar el arranque; las siguientes cada 24 h).
  if (retentionStatus.enabled) {
    setTimeout(() => void runRetention("schedule"), 60_000);
    setInterval(() => void runRetention("schedule"), 24 * 3600_000);
  }

  httpServer.listen(config.port, () => {
    console.log(`\n  🖥  server   http://localhost:${config.port}`);
    console.log(`     health   http://localhost:${config.port}${API.health}`);
    console.log(`     api      http://localhost:${config.port}${API.cameras}`);
    console.log(`     auth     http://localhost:${config.port}/api/auth/status`);
    console.log(`     docs     http://localhost:${config.port}${API.docs}`);
    console.log(`     storage  ${store.backend}${hasSupabase ? "" : " (sin SUPABASE_SERVICE_KEY)"}`);
    console.log(`     ws       origin=${config.corsOrigin}\n`);
  });
}

void bootstrap();
