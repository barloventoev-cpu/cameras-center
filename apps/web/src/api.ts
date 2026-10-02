import { API, type Camera, type CreateCameraInput, type CreateCameraPayload } from "@cameras/protocol";

const TOKEN_KEY = "cc_token";

// ---------------------------------------------------------------------------
// Token (localStorage). El JWT nunca se envía a terceros: sólo a nuestra API.
// ---------------------------------------------------------------------------
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // modo privado / storage bloqueado
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(path, { ...init, headers });

  if (response.status === 401) {
    setToken(null);
    throw new ApiError("Sesión expirada o no válida", 401);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `Error ${response.status}`, response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface HealthResponse {
  status: string;
  version: string;
  env: string;
  time: string;
  uptimeSec: number;
  storage?: { cameras: string; supabase: string };
  /** F3: conexiones WS vivas */
  ws?: {
    connected: number;
    agents: number;
    viewers: number;
    /** F5: espectadores del endpoint MJPEG */
    http?: number;
    cameras: Array<{ cameraId: string; viewers: number }>;
  };
  /** F4: miniaturas en Cloudinary */
  cloudinary?: {
    configured: boolean;
    folder: string;
    intervalMs: number;
    status: string;
    uploads: number;
    failures: number;
    thumbnails: number;
    lastOkAt: string | null;
    lastError: string | null;
  };
  /** F5: API keys de terceros y límites de peticiones */
  apiKeys?: { backend: string; total?: number; active?: number; revoked?: number; error?: string };
  rateLimit?: {
    global: { rpm: number; buckets?: number; requests?: number; blocked?: number };
    auth: { rpm: number; buckets?: number; requests?: number; blocked?: number };
    principal: { buckets?: number; requests?: number; blocked?: number };
  };
  /** F6: eventos de movimiento */
  events?: {
    type: string;
    total: number;
    received: number;
    persisted: number;
    snapshots: number;
    snapshotFailures: number;
    lastAt: string | null;
    lastError: string | null;
  };
  /** F6: webhooks registrados */
  webhooks?: WebhookStats;
}

export interface AuthStatus {
  backend: string;
  needsSetup: boolean;
  allowRegister: boolean;
  jwt: string;
}

export interface AuthResponse {
  token: string;
  user: { id: string; email: string; role: string };
}

/** F5: API key de un tercero (nunca incluye la clave en claro). */
export interface ApiKeyInfo {
  id: string;
  label: string;
  scopes: string[];
  rateLimit: number;
  revoked: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

/** F6: evento de movimiento detectado por el agent. */
export interface MotionEvent {
  id: string;
  cameraId: string;
  cameraName: string | null;
  type: string;
  score: number | null;
  at: number;
  createdAt: string;
  snapshot: string | null;
  /** F7: URL del clip MP4 grabado con este evento (null si no tiene). */
  clip: string | null;
}

/** F6: webhook registrado (el secreto sólo se ve al crearlo). */
export interface WebhookInfo {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
  deliveries: number;
  failures: number;
  lastStatus: number | null;
  lastAt: string | null;
  lastError: string | null;
}

export interface WebhookStats {
  configured: boolean;
  total: number;
  active: number;
  seeded: number;
  timeoutMs: number;
  attempts: number;
  deliveries: number;
  failures: number;
  lastStatus: number | null;
  lastAt: string | null;
  lastError: string | null;
}

export const api = {
  health: () => request<HealthResponse>(API.health),

  auth: {
    status: () => request<AuthStatus>("/api/auth/status"),
    login: (email: string, password: string) =>
      request<AuthResponse>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
    register: (email: string, password: string) =>
      request<AuthResponse>("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password }) }),
  },

  listCameras: async (): Promise<Camera[]> => {
    const data = await request<{ cameras: Camera[] }>(API.cameras);
    return data.cameras;
  },

  /** F4: última thumbnail (Cloudinary) de cada cámara. */
  thumbnails: async (): Promise<Record<string, string>> => {
    const data = await request<{ thumbnails: Record<string, string> }>(`${API.cameras}/thumbnails`);
    return data.thumbnails ?? {};
  },
  /** Codificación configurada (resolución/FPS) para la pastilla de telemetría. */
  cameraEncoding: async (id: string): Promise<{ cameraId: string; width: number; fps: number }> => {
    return request<{ cameraId: string; width: number; fps: number }>(`${API.camera(id)}/encoding`);
  },

  /** F4: captura y sube un thumbnail ahora. Devuelve su URL o lanza ApiError. */
  captureThumbnail: async (id: string): Promise<string> => {
    const data = await request<{ thumbnail: { url: string } }>(`${API.camera(id)}/thumbnail`, { method: "POST" });
    return data.thumbnail.url;
  },

  createCamera: async (payload: CreateCameraPayload): Promise<Camera> => {
    const data = await request<{ camera: Camera }>(API.cameras, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return data.camera;
  },

  deleteCamera: async (id: string): Promise<void> => {
    await request<void>(API.camera(id), { method: "DELETE" });
  },

  /** F5: API keys para terceros. */
  keys: {
    list: async (): Promise<ApiKeyInfo[]> => (await request<{ keys: ApiKeyInfo[] }>(API.keys)).keys,
    create: async (payload: { label: string; scopes?: string[]; rate_limit?: number }): Promise<{ key: string; apikey: ApiKeyInfo }> =>
      request<{ key: string; apikey: ApiKeyInfo }>(API.keys, { method: "POST", body: JSON.stringify(payload) }),
    revoke: async (id: string): Promise<void> => {
      await request<void>(API.key(id), { method: "DELETE" });
    },
  },

  /** F6/F7: historial de eventos (avisos de movimiento + clips grabados). */
  events: {
    list: async (limit = 20): Promise<MotionEvent[]> => {
      // dos consultas y se mezclan: el endpoint filtra por `type` y por defecto
      // devuelve sólo los de movimiento (así lo exige su API)
      const [motion, clips] = await Promise.all([
        request<{ events: MotionEvent[] }>(`${API.events}?type=motion&limit=${limit}`),
        request<{ events: MotionEvent[] }>(`${API.events}?type=clip&limit=${limit}`),
      ]);
      return [...(motion.events ?? []), ...(clips.events ?? [])]
        .sort((a, b) => b.at - a.at)
        .slice(0, limit);
    },
    remove: async (id: string): Promise<void> => {
      await request<void>(API.event(id), { method: "DELETE" });
    },
    /** F7: pide al agent que grabe un clip (202 = pedido, la subida llega después). */
    record: async (cameraId: string, durationMs?: number): Promise<void> => {
      await request(`${API.camera(cameraId)}/clip`, {
        method: "POST",
        body: JSON.stringify(durationMs ? { durationMs } : {}),
      });
    },
  },

  /** F6: webhooks (el secreto sólo se devuelve al crearlo). */
  webhooks: {
    list: async (): Promise<{ webhooks: WebhookInfo[]; stats: WebhookStats }> => request(API.webhooks),
    create: async (payload: { url: string; secret?: string }): Promise<{ webhook: WebhookInfo; secret: string }> =>
      request(API.webhooks, { method: "POST", body: JSON.stringify(payload) }),
    remove: async (id: string): Promise<void> => {
      await request<void>(API.webhook(id), { method: "DELETE" });
    },
  },
};

export type { CreateCameraInput };
