/**
 * The Mac's own remote-task settings. Nothing here is reachable from Ensemble
 * on the web: the sidecar binds loopback, and the switch can only be turned
 * on by this route.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { appendLedger } from "../lib/ledger.js";
import { resolveWorkFolder } from "../workspace/guard.js";
import { checkApiBase, hostedClient, registerDevice, RemoteError } from "./client.js";
import { parseRegistered } from "./contract.js";
import { deviceCapabilities, devicePlatform, REMOTE_NOTICE, remotePresence, stopRemoteWork, wakeRemote } from "./loop.js";
import { dropDeviceToken, loadSettings, readDeviceToken, saveDeviceToken, saveSettings, updateSettings, type SharedFolder } from "./store.js";

const CODE = /^[A-Za-z0-9]{8}$/;

function loopback(ip: string): boolean {
  const host = ip.replace(/^::ffff:/, "");
  return host === "127.0.0.1" || host === "::1";
}

async function status(app: FastifyInstance) {
  const settings = loadSettings();
  const token = await readDeviceToken();
  const presence = remotePresence();
  return {
    apiBase: process.env.ENSEMBLE_REMOTE_API?.trim().replace(/\/+$/, "") || settings.apiBase,
    deviceName: settings.deviceName,
    deviceId: settings.deviceId,
    paired: Boolean(token && settings.pairedAt),
    enabled: settings.enabled,
    runBranchPush: settings.runBranchPush,
    online: presence.online,
    lastHeartbeatAt: presence.lastHeartbeatAt || null,
    disconnected: settings.disconnected,
    unreachable: settings.unreachable,
    folders: settings.folders,
    platform: devicePlatform(),
  };
}

export async function remoteRoutes(app: FastifyInstance): Promise<void> {
  const userId = env.ENSEMBLE_DEV_USER_ID;

  app.get("/api/remote", async () => status(app));

  app.put("/api/remote", async (request, reply) => {
    if (!loopback(request.ip)) return reply.code(403).send({ error: "Remote tasks can only be changed on this Mac." });
    const body = z
      .object({
        enabled: z.boolean().optional(),
        runBranchPush: z.boolean().optional(),
        apiBase: z.string().max(300).nullable().optional(),
        deviceName: z.string().min(1).max(60).optional(),
      })
      .parse(request.body);
    const current = loadSettings();
    let apiBase = current.apiBase;
    if (body.apiBase !== undefined) apiBase = body.apiBase ? checkApiBase(body.apiBase) : null;
    if (body.enabled === true) {
      const token = await readDeviceToken();
      const base = process.env.ENSEMBLE_REMOTE_API?.trim() || apiBase;
      if (!token || !base) return reply.code(400).send({ error: "Pair this Mac with Ensemble on the web first." });
    }
    const next = saveSettings({
      ...current,
      apiBase,
      ...(body.deviceName ? { deviceName: body.deviceName } : {}),
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      ...(body.runBranchPush === undefined ? {} : { runBranchPush: body.runBranchPush }),
      ...(body.enabled === true ? { disconnected: null, unreachable: null } : {}),
      ...(body.enabled === false
        ? { disconnected: { at: new Date().toISOString(), reason: REMOTE_NOTICE.switchedOff }, unreachable: null }
        : {}),
    });
    if (body.enabled === false || body.runBranchPush !== undefined || body.enabled === true) {
      const action = body.enabled === true ? "remote.enable" : body.enabled === false ? "remote.disable" : "remote.push_setting";
      await appendLedger({ userId, actor: "me", action, payload: { enabled: next.enabled, runBranchPush: next.runBranchPush } });
    }
    if (body.enabled === false) await stopRemoteWork(app, REMOTE_NOTICE.switchedOff, "cancelled");
    wakeRemote();
    return status(app);
  });

  app.post("/api/remote/pair", async (request, reply) => {
    if (!loopback(request.ip)) return reply.code(403).send({ error: "Pairing can only be done on this Mac." });
    const body = z.object({ apiBase: z.string().min(1).max(300), code: z.string(), name: z.string().min(1).max(60).optional() }).parse(request.body);
    if (!CODE.test(body.code.trim())) return reply.code(400).send({ error: "The pairing code is 8 letters or numbers." });
    const settings = loadSettings();
    let registered: unknown;
    let base: string;
    try {
      base = checkApiBase(body.apiBase);
      registered = await registerDevice(base, {
        code: body.code.trim().toUpperCase(),
        name: body.name?.trim() || settings.deviceName,
        platform: devicePlatform(),
        appVersion: process.env.ENSEMBLE_APP_VERSION ?? "0.1.0",
        capabilities: await deviceCapabilities(app),
      });
    } catch (error) {
      if (error instanceof RemoteError) return reply.code(error.status || 502).send({ error: error.message });
      throw error;
    }
    const parsed = parseRegistered(registered);
    await saveDeviceToken(parsed.token, base);
    saveSettings({
      ...loadSettings(),
      apiBase: base,
      deviceId: parsed.deviceId,
      deviceName: body.name?.trim() || parsed.name || settings.deviceName,
      pairedAt: new Date().toISOString(),
      enabled: false,
      disconnected: null,
      unreachable: null,
    });
    await appendLedger({ userId, actor: "me", action: "remote.pair", payload: { apiBase: base, deviceId: parsed.deviceId, name: body.name ?? settings.deviceName } });
    return status(app);
  });

  app.post("/api/remote/unpair", async (request, reply) => {
    if (!loopback(request.ip)) return reply.code(403).send({ error: "Unpair can only be done on this Mac." });
    await stopRemoteWork(app, "This Mac was unpaired. Remote tasks were turned off.", "cancelled");
    const settings = loadSettings();
    const token = await readDeviceToken();
    const baseValue = process.env.ENSEMBLE_REMOTE_API?.trim() || settings.apiBase;
    if (token && baseValue) {
      try {
        await hostedClient(checkApiBase(baseValue), token).unpairSelf();
      } catch (error) {
        request.log.warn({ err: error }, "could not revoke hosted device during local unpair");
      }
    }
    await dropDeviceToken();
    updateSettings({ enabled: false, pairedAt: null, deviceId: null, disconnected: null, unreachable: null });
    wakeRemote();
    await appendLedger({ userId, actor: "me", action: "remote.unpair", payload: {} });
    return reply.code(200).send(await status(app));
  });

  app.post("/api/remote/folders", async (request, reply) => {
    if (!loopback(request.ip)) return reply.code(403).send({ error: "Folders can only be shared from this Mac." });
    const body = z
      .object({
        label: z.string().min(1).max(60),
        path: z.string().min(1).max(1000),
        kind: z.enum(["folder", "repo"]).default("folder"),
        access: z.enum(["review", "read-write"]).default("review"),
      })
      .parse(request.body);
    if (/[/\\]/.test(body.label)) return reply.code(400).send({ error: "The label is a name, not a path." });
    const path = await resolveWorkFolder(body.path);
    const current = loadSettings();
    const folder: SharedFolder = { label: body.label.trim(), path, kind: body.kind, access: body.access };
    const folders = [...current.folders.filter((row) => row.label !== folder.label), folder];
    updateSettings({ folders });
    await appendLedger({ userId, actor: "me", action: "remote.folder", payload: { label: folder.label, kind: folder.kind, access: folder.access } });
    return { folders };
  });

  app.delete("/api/remote/folders/:label", async (request, reply) => {
    if (!loopback(request.ip)) return reply.code(403).send({ error: "Folders can only be shared from this Mac." });
    const { label } = request.params as { label: string };
    const current = loadSettings();
    updateSettings({ folders: current.folders.filter((row) => row.label !== label) });
    return reply.code(204).send();
  });
}
