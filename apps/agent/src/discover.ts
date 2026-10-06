import dgram from "node:dgram";
import net from "node:net";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import {
  DiscoverOptionsSchema,
  type AgentDiscoverResult,
  type DiscoverOptions,
  type DiscoveredHost,
  type HttpInfo,
  type OnvifInfo,
  type RtspInfo,
} from "@cameras/protocol";

/**
 * F8 — búsqueda de cámaras en la red local.
 *
 * Dos sondeos en paralelo, sin dependencias externas:
 *
 *   1. TCP  : puertos típicos de cámaras en cada host de la subred; los que
 *             abren se sondean con HTTP (`Server`/`Title`) y con `DESCRIBE`
 *             RTSP (varias rutas: la O-KAM sólo contesta a `/tcp/av0_0`).
 *   2. ONVIF: M-SEARCH WS-Discovery a 239.255.255.250:3702 y, por cada XAddr,
 *             GetDeviceInformation → GetCapabilities → GetProfiles →
 *             GetStreamUri (marca, modelo y URL RTSP).
 *
 * Es un puerto TypeScript de `tools/lan-scan.mjs` + `tools/onvif-discover.mjs`,
 * pensado para servir a la UI: todo va acotado en el tiempo porque el server
 * espera la respuesta por WebSocket.
 */

const DEFAULT_PORTS = [80, 443, 554, 8554, 8080, 8000, 37777, 8899, 10554, 34567];
const CONNECT_TIMEOUT = 800;
const RTSP_TIMEOUT = 2500;
const HTTP_TIMEOUT = 3000;
const ONVIF_LISTEN_MS = 4000;
const ONVIF_SOAP_MS = 4000;
/** Tope de toda la búsqueda: el server espera 60 s y hay que responder antes. */
const OVERALL_DEADLINE_MS = 45_000;

const HOST_POOL = 250;
const PORT_POOL = 8;
const DETAIL_POOL = 8;
const ONVIF_DEVICE_POOL = 4;
const MAX_ONVIF_DEVICES = 20;

/** Puertos que suelen hablar RTSP. */
const RTSP_PORTS = [554, 8554, 10554, 5540];
/** Puertos por los que probar la interfaz HTTP. */
const HTTP_PORTS = [80, 443, 8080, 8000, 8899];

let active = false;
/** true mientras hay una búsqueda en marcha (evita dos a la vez). */
export const discoveryActive = (): boolean => active;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = index++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Subred de la interfaz activa (se salta docker/vm/wsl…). */
export function guessSubnet(): string {
  const skip = /vbox|vmware|vmnet|docker|veth|br-|tun|tap|wsl|hyper-v/i;
  const preferred = /^(en|eth|wl|wlan|wi-fi|ethernet|wi fi)/i;
  const candidates: Array<{ name: string; address: string }> = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) candidates.push({ name, address: addr.address });
    }
  }
  const pick =
    candidates.find((c) => preferred.test(c.name) && !skip.test(c.name)) ??
    candidates.find((c) => !skip.test(c.name)) ??
    candidates[0];
  if (!pick) return "192.168.1.0/24";
  const parts = pick.address.split(".");
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

function hostsOf(subnet: string, explicitIp?: string): string[] {
  if (explicitIp) return [explicitIp];
  const base = subnet.split("/")[0] ?? "";
  const parts = base.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) throw new Error(`Subred inválida: ${subnet}`);
  const list: string[] = [];
  for (let i = 1; i <= 254; i++) list.push(`${parts[0]}.${parts[1]}.${parts[2]}.${i}`);
  return list;
}

function ipToNum(ip: string): number {
  return ip.split(".").reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0) >>> 0;
}

function tryConnect(ip: string, port: number, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, ip);
  });
}

// ---------------------------------------------------------------------------
// Sondas de protocolo
// ---------------------------------------------------------------------------
// Las cámaras O-KAM/EZVIZ ignoran `OPTIONS /` y cierran el socket, así que se
// manda `DESCRIBE` directamente: un 401 ya prueba que hay RTSP con Digest.
const RTSP_PROBE_URIS = ["/tcp/av0_0", "/", "/live", "/Streaming/Channels/101", "/h264_preview_01"];

function rtspDescribe(ip: string, port: number, uri: string, timeout = RTSP_TIMEOUT): Promise<{ ok: boolean; banner: string }> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let buffer = "";
    let settled = false;
    const done = (result: { ok: boolean; banner: string }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.on("connect", () => {
      socket.write(`DESCRIBE rtsp://${ip}:${port}${uri} RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("RTSP/1.0")) done({ ok: true, banner: buffer.split("\r\n")[0] ?? "" });
    });
    socket.on("timeout", () => done({ ok: false, banner: buffer.slice(0, 80) }));
    socket.on("error", () => done({ ok: false, banner: "" }));
    socket.on("close", () => done({ ok: buffer.includes("RTSP/1.0"), banner: buffer.split("\r\n")[0] ?? "" }));
    socket.connect(port, ip);
  });
}

async function probeRtsp(ip: string, port: number): Promise<RtspInfo> {
  for (const uri of RTSP_PROBE_URIS) {
    const res = await rtspDescribe(ip, port, uri);
    if (res.ok) return { port, ok: true, uri, banner: res.banner };
  }
  return { port, ok: false, uri: null, banner: "" };
}

function probeHttp(ip: string, port: number, timeout = HTTP_TIMEOUT): Promise<HttpInfo | null> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let buffer = "";
    let settled = false;
    /** Los cabecales llegan enseguida; el `<title>` puede venir en el cuerpo. */
    let titleTimer: ReturnType<typeof setTimeout> | null = null;

    const parse = (): HttpInfo => {
      const server = /Server:\s*([^\r\n]+)/i.exec(buffer)?.[1] ?? "";
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(buffer)?.[1] ?? "";
      return { port, server: server.trim().slice(0, 60), title: title.trim().slice(0, 80) };
    };
    const done = (result: HttpInfo | null) => {
      if (settled) return;
      settled = true;
      if (titleTimer) clearTimeout(titleTimer);
      socket.destroy();
      resolve(result);
    };
    /** Hay cabecales = es HTTP de verdad, aunque no llegue el cuerpo. */
    const httpSoFar = () => (/^HTTP\/\d/.test(buffer) ? parse() : null);

    socket.setTimeout(timeout);
    socket.on("connect", () => socket.write(`GET / HTTP/1.1\r\nHost: ${ip}\r\nConnection: close\r\n\r\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      // No se espera a que cierre: hay equipos (routers) que ignoran
      // `Connection: close` y dejarían la sonda colgada hasta el timeout.
      if (!buffer.includes("\r\n\r\n")) return;
      if (/<\/title>/i.test(buffer)) return done(parse());
      // unos ms de gracia para el título; después, con lo que haya
      if (!titleTimer) titleTimer = setTimeout(() => done(parse()), 500);
    });
    socket.on("timeout", () => done(httpSoFar()));
    socket.on("error", () => done(httpSoFar()));
    socket.on("close", () => done(httpSoFar()));
    socket.connect(port, ip);
  });
}

// ---------------------------------------------------------------------------
// ONVIF (WS-Discovery + SOAP)
// ---------------------------------------------------------------------------
const MULTICAST = "239.255.255.250";
const DISCOVERY_PORT = 3702;
const NS = {
  s: "http://www.w3.org/2003/05/soap-envelope",
  tds: "http://www.onvif.org/ver10/device/wsdl",
  trt: "http://www.onvif.org/ver10/media/wsdl",
  tt: "http://www.onvif.org/ver10/schema",
  wsa: "http://www.w3.org/2005/08/addressing",
  wsse: "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd",
  wsu: "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd",
};

function uuid(): string {
  const b = randomBytes(16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const xmlEscape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function probeMessage(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <e:Header>
    <w:MessageID>uuid:${uuid()}</w:MessageID>
    <w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
    <w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
  </e:Header>
  <e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body>
</e:Envelope>`;
}

function soapEnvelope(action: string, bodyXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="${NS.s}" xmlns:tds="${NS.tds}" xmlns:trt="${NS.trt}" xmlns:tt="${NS.tt}" xmlns:wsa="${NS.wsa}">
  <s:Header><wsa:Action s:mustUnderstand="1">${xmlEscape(action)}</wsa:Action><wsa:To s:mustUnderstand="1">${xmlEscape(
    action,
  )}Service</wsa:To><wsa:MessageID>urn:uuid:${uuid()}</wsa:MessageID></s:Header>
  <s:Body>${bodyXml}</s:Body>
</s:Envelope>`;
}

/** POST SOAP. Devuelve el XML o lanza con `status` para detectar el 401. */
async function soapPost(url: string, xml: string, timeoutMs = ONVIF_SOAP_MS): Promise<string> {
  const response = await fetch(url, {
    method: "POST",
    body: xml,
    headers: { "content-type": "application/soap+xml; charset=utf-8" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return text;
}

function tag(xml: string, name: string): string | null {
  return new RegExp(`<(?:\\w+:)?${name}[^>]*>([^<]*)</(?:\\w+:)?${name}>`, "i").exec(xml)?.[1]?.trim() ?? null;
}

/** Escucha WS-Discovery y devuelve los XAddr que responden. */
async function discoverXAddrs(timeoutMs = ONVIF_LISTEN_MS): Promise<string[]> {
  const interfaces: Array<{ name: string; address: string }> = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) interfaces.push({ name, address: entry.address });
    }
  }
  if (interfaces.length === 0) interfaces.push({ name: "default", address: "0.0.0.0" });

  const found = new Set<string>();
  const sockets: dgram.Socket[] = [];
  const message = Buffer.from(probeMessage(), "utf8");

  await Promise.all(
    interfaces.map(
      (iface) =>
        new Promise<void>((resolve) => {
          const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
          sockets.push(socket);
          socket.on("message", (msg) => {
            const match = /<a:XAddrs>([^<]+)<\/a:XAddrs>|<XAddrs>([^<]+)<\/XAddrs>/i.exec(msg.toString("utf8"));
            const value = match?.[1] ?? match?.[2];
            if (!value) return;
            for (const xaddr of value.split(/\s+/)) {
              if (/^https?:\/\//i.test(xaddr)) found.add(xaddr);
            }
          });
          socket.on("error", () => resolve());
          socket.bind({ address: iface.address, port: 0 }, () => {
            try {
              socket.setMulticastTTL(4);
              socket.setMulticastLoopback(false);
              socket.addMembership(MULTICAST, iface.address);
            } catch {
              // hay interfaces que no dejan unirse al grupo: igual se envía
            }
            socket.send(message, DISCOVERY_PORT, MULTICAST, () => resolve());
          });
        }),
    ),
  );

  await sleep(timeoutMs);
  for (const socket of sockets) {
    try {
      socket.close();
    } catch {
      // ya estaba cerrado
    }
  }
  return [...found];
}

/** GetDeviceInformation → GetCapabilities → GetProfiles → GetStreamUri. */
async function describeDevice(xaddr: string): Promise<OnvifInfo> {
  const result: OnvifInfo = {
    xaddr,
    manufacturer: null,
    model: null,
    firmware: null,
    rtsp: null,
    authRequired: false,
    error: null,
  };

  try {
    const info = await soapPost(
      xaddr,
      soapEnvelope("http://www.onvif.org/ver10/device/wsdl/GetDeviceInformation", "<tds:GetDeviceInformation/>"),
    );
    result.manufacturer = tag(info, "Manufacturer");
    result.model = tag(info, "Model");
    result.firmware = tag(info, "FirmwareVersion");
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 401) {
      result.authRequired = true;
      result.error = "requiere credenciales";
      return result;
    }
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }

  // GetCapabilities → dónde está el servicio de media
  let media = xaddr;
  try {
    const caps = await soapPost(
      xaddr,
      soapEnvelope("http://www.onvif.org/ver10/device/wsdl/GetCapabilities", "<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>"),
    );
    media = /<(?:\w+:)?Media\b[^>]*>[\s\S]*?<(?:\w+:)?XAddr>([^<]+)<\/(?:\w+:)?XAddr>/i.exec(caps)?.[1]?.trim() || xaddr;
  } catch {
    media = xaddr; // muchas cámaras resuelven todo en device_service
  }

  try {
    const profiles = await soapPost(media, soapEnvelope("http://www.onvif.org/ver10/media/wsdl/GetProfiles", "<trt:GetProfiles/>"));
    const tokens = [...profiles.matchAll(/<(?:\w+:)?Profiles\b[^>]*\stoken="([^"]+)"/gi)].map((m) => m[1]);
    if (tokens[0]) {
      const stream = await soapPost(
        media,
        soapEnvelope(
          "http://www.onvif.org/ver10/media/wsdl/GetStreamUri",
          `<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${xmlEscape(
            tokens[0],
          )}</trt:ProfileToken></trt:GetStreamUri>`,
        ),
      );
      result.rtsp = tag(stream, "Uri");
    }
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 401) {
      result.authRequired = true;
      result.error = "requiere credenciales";
    } else if (!result.error) {
      result.error = `media: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Búsqueda completa
// ---------------------------------------------------------------------------
/** URL RTSP candidata (sin credenciales: hay que añadir usuario y contraseña). */
function suggestionFor(host: DiscoveredHost): string | null {
  if (host.onvif?.rtsp) return host.onvif.rtsp;
  if (host.rtsp?.ok && host.rtsp.uri) return `rtsp://${host.ip}:${host.rtsp.port}${host.rtsp.uri}`;
  return null;
}

export interface DiscoverSummary {
  subnet: string;
  scanned: number;
  elapsedMs: number;
  hosts: DiscoveredHost[];
}

/**
 * Barre la red y devuelve los hosts vivos con lo que se pudo averiguar.
 * Lanza si ya hay otra búsqueda en marcha o si la subred no es válida.
 */
export async function discoverCameras(input: unknown): Promise<DiscoverSummary> {
  if (active) throw new Error("Ya hay una búsqueda en curso");

  const options: DiscoverOptions = DiscoverOptionsSchema.parse(input ?? {});
  active = true;
  try {
    const started = Date.now();
    const ports = options.ports?.length ? options.ports : DEFAULT_PORTS;
    const timeout = options.timeoutMs ?? CONNECT_TIMEOUT;
    const subnet = options.ip ?? options.subnet ?? guessSubnet();
    const hosts = hostsOf(subnet, options.ip);

    const scanned: DiscoveredHost[] = [];
    const onvifDevices: OnvifInfo[] = [];

    // Los dos sondeos en paralelo; el reloj global corta con lo que haya.
    await Promise.race([
      Promise.all([
        // --- 1) TCP + HTTP + RTSP ------------------------------------------
        mapPool(hosts, HOST_POOL, async (ip) => {
          const open: number[] = [];
          await mapPool(ports, PORT_POOL, async (port) => {
            if (await tryConnect(ip, port, timeout)) open.push(port);
          });
          if (open.length === 0) return;

          const host: DiscoveredHost = { ip, open: open.sort((a, b) => a - b), http: null, rtsp: null, onvif: null, suggestion: null };
          scanned.push(host);
        }).then(async () => {
          await mapPool(scanned, DETAIL_POOL, async (host) => {
            const httpPort = HTTP_PORTS.find((p) => host.open.includes(p));
            if (httpPort) host.http = await probeHttp(host.ip, httpPort);

            const rtspPort = host.open.find((p) => RTSP_PORTS.includes(p));
            if (rtspPort) host.rtsp = await probeRtsp(host.ip, rtspPort);
          });
        }),

        // --- 2) ONVIF (WS-Discovery) ---------------------------------------
        options.onvif
          ? discoverXAddrs().then(async (xaddrs) => {
              const found = await mapPool(xaddrs.slice(0, MAX_ONVIF_DEVICES), ONVIF_DEVICE_POOL, (xaddr) => describeDevice(xaddr));
              onvifDevices.push(...found);
            })
          : Promise.resolve(),
      ]),
      sleep(OVERALL_DEADLINE_MS),
    ]);

    // Fusionar lo ONVIF por IP: un dispositivo que no abra puertos típicos
    // también tiene que aparecer en la lista.
    for (const device of onvifDevices) {
      const ip = (() => {
        try {
          return new URL(device.xaddr).hostname;
        } catch {
          return null;
        }
      })();
      if (!ip) continue;
      const host = scanned.find((h) => h.ip === ip);
      if (host) host.onvif = device;
      else scanned.push({ ip, open: [], http: null, rtsp: null, onvif: device, suggestion: null });
    }

    const hostsFound = scanned
      .map((host) => ({ ...host, suggestion: suggestionFor(host) }))
      .sort((a, b) => ipToNum(a.ip) - ipToNum(b.ip));

    return { subnet, scanned: hosts.length, elapsedMs: Date.now() - started, hosts: hostsFound };
  } finally {
    active = false;
  }
}

/** Construye la respuesta completa del protocolo (`agent:discoverResult`). */
export function toDiscoverResult(
  requestId: string,
  agentId: string,
  summary: DiscoverSummary,
): AgentDiscoverResult {
  return {
    type: "agent:discoverResult",
    requestId,
    ok: true,
    agentId,
    subnet: summary.subnet,
    scanned: summary.scanned,
    elapsedMs: summary.elapsedMs,
    hosts: summary.hosts,
  };
}
