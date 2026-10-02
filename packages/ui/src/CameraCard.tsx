import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { Camera, CameraStatus } from "@cameras/protocol";
import { StatusBadge } from "./StatusBadge";

export interface CameraCardProps {
  camera: Camera;
  status?: CameraStatus;
  /** URL de la imagen en vivo (MJPEG/HLS poster). Si no hay, muestra placeholder. */
  streamUrl?: string;
  /** Thumbnail de Cloudinary como fallback estático. */
  thumbnailUrl?: string;
  /** FPS configurados de la cámara (para la pastilla de telemetría). */
  encodingFps?: number | null;
  /** Se dispara si la imagen en vivo falla (p.ej. el agent no está en la LAN). */
  onStreamError?: () => void;
  activeViewers?: number;
  children?: ReactNode;
  onSelect?: (camera: Camera) => void;
}

export function CameraCard({
  camera,
  status = "unknown",
  streamUrl,
  thumbnailUrl,
  encodingFps = null,
  onStreamError,
  activeViewers,
  children,
  onSelect,
}: CameraCardProps) {
  const [imageOk, setImageOk] = useState(true);
  const [loaded, setLoaded] = useState(false);
  /** Resolución real medida del <img> (naturalWidth/Height al cargar). */
  const [frameSize, setFrameSize] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // cambiar de fuente reinicia el estado del <img>
  useEffect(() => {
    setImageOk(true);
    setLoaded(false);
    setFrameSize(null);
  }, [streamUrl]);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void boxRef.current?.requestFullscreen().catch(() => undefined);
    }
  };

  const poster = streamUrl && imageOk ? streamUrl : thumbnailUrl;
  // Estado intuitivo derivado de lo que se VE (no del reporte del agent, que
  // esta UI no recibe): en pausa / sin señal / conectando / en vivo.
  const effectiveStatus: CameraStatus = !streamUrl
    ? "paused"
    : !imageOk
      ? "offline"
      : !loaded
        ? "starting"
        : "online";

  const metaParts: string[] = [];
  if (frameSize) metaParts.push(frameSize);
  if (encodingFps !== null && encodingFps !== undefined) metaParts.push(`${encodingFps} fps`);
  const metaText = metaParts.join(" · ");

  return (
    <article
      onClick={() => onSelect?.(camera)}
      style={{
        background: "#14161c",
        border: "1px solid #242833",
        borderRadius: 12,
        overflow: "hidden",
        cursor: onSelect ? "pointer" : "default",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        ref={boxRef}
        style={{
          position: "relative",
          aspectRatio: "16 / 9",
          background: "#0b0c10",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {poster ? (
          <img
            src={poster}
            alt={camera.name}
            onLoad={(e) => {
              setLoaded(true);
              const img = e.currentTarget;
              if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                setFrameSize(`${img.naturalWidth}×${img.naturalHeight}`);
              }
            }}
            onError={() => {
              setImageOk(false);
              if (streamUrl) onStreamError?.();
            }}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        ) : (
          <span style={{ color: "#4a5060", fontSize: 13 }}>
            {streamUrl && !loaded ? "Conectando…" : "Sin señal de video"}
          </span>
        )}

        <div style={{ position: "absolute", top: 8, left: 8 }}>
          <StatusBadge status={effectiveStatus} />
        </div>

        <button
          type="button"
          title={isFullscreen ? "Salir de pantalla completa" : "Ver en pantalla completa"}
          onClick={(e) => {
            e.stopPropagation();
            toggleFullscreen();
          }}
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            background: "rgba(0,0,0,.65)",
            color: "#dfe3ea",
            border: "1px solid #2c3140",
            fontSize: 13,
            padding: "2px 8px",
            borderRadius: 999,
            cursor: "pointer",
          }}
        >
          {isFullscreen ? "⛶ Salir" : "⛶ Ampliar"}
        </button>

        {loaded && metaText !== "" && (
          <div
            style={{
              position: "absolute",
              right: 8,
              bottom: 8,
              background: "rgba(0,0,0,.55)",
              color: "rgba(255,255,255,0.9)",
              fontSize: 10,
              fontWeight: 600,
              padding: "2px 8px",
              borderRadius: 999,
            }}
          >
            {metaText}
          </div>
        )}

        {typeof activeViewers === "number" && activeViewers > 0 && (
          <div
            style={{
              position: "absolute",
              top: 40,
              right: 8,
              background: "rgba(0,0,0,.65)",
              color: "#dfe3ea",
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 999,
            }}
          >
            👁 {activeViewers}
          </div>
        )}
      </div>

      <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 2 }}>
        <strong style={{ fontSize: 14, color: "#eef1f6" }}>{camera.name}</strong>
        <span style={{ fontSize: 12, color: "#8b93a5" }}>
          {camera.brand ?? camera.sourceType.toUpperCase()} · {camera.host}
        </span>
        {children}
      </div>
    </article>
  );
}
