import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { templateById } from "@ensemble/shared-types/templates";
import { requireBrowserSession } from "../bridge/auth.js";
import { revokePairedDevice } from "../devices/revoke.js";
import { applyOnboarding } from "../layouts/apply.js";
import { deleteAccountData } from "../lib/account-data.js";
import { appendLedger } from "../lib/ledger.js";
import { copySettings, createSpaceUser, listSpaces, mirrorSettings, openableSpace, setSpaceCookie, spaceIds } from "./store.js";
import { accountIdOf, ownsOpenSpace, settingsUserOf } from "../lib/auth.js";
import { sharedWithMe } from "../sharing/store.js";
import { sseHub } from "../lib/sse.js";

/** Not a UUID check: the local and desktop account id is "local". Ownership is checked by `mine`. */
const Id = z.string().trim().min(1).max(64);
const Name = z.string().trim().min(1, "Name the space.").max(60);
/** One emoji (with modifiers or a ZWJ sequence). Letters are not icons; the initial is the fallback. */
const Icon = z
  .string()
  .trim()
  .max(16)
  .refine((value) => !/[\p{L}\p{N}]/u.test(value), "Pick an emoji.")
  .nullable()
  .optional();

const CreateBody = z.object({
  name: Name,
  icon: Icon,
  templateId: z.string().min(1).max(80),
  settings: z
    .object({ mode: z.enum(["fresh", "copy", "sync"]), from: Id.optional() })
    .default({ mode: "copy" }),
});

function browserOnly(request: FastifyRequest): void {
  requireBrowserSession(request);
  if (request.authVia === "token" || request.authVia === "internal") {
    throw Object.assign(new Error("Spaces are managed from the Ensemble app."), { statusCode: 403 });
  }
}

export async function spacesRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app;

  /** The ids this account may open: its own and every space it owns. */
  const mine = async (request: FastifyRequest, id: string) => {
    const ids = await spaceIds(prisma, accountIdOf(request));
    if (!ids.includes(id)) throw Object.assign(new Error("That space is not yours."), { statusCode: 404 });
    return ids;
  };

  app.get("/api/spaces", async (request) => {
    browserOnly(request);
    const [listed, withMe] = await Promise.all([listSpaces(prisma, accountIdOf(request)), sharedWithMe(prisma, accountIdOf(request))]);
    return { activeId: request.userId, ...listed, shared: withMe.spaces };
  });

  app.post("/api/spaces", async (request, reply) => {
    browserOnly(request);
    const body = CreateBody.parse(request.body);
    const account = await prisma.user.findUniqueOrThrow({ where: { id: accountIdOf(request) }, select: { onboardingRole: true, spaceSettingsSync: true } });
    const template = templateById(body.templateId);
    if (!template) throw Object.assign(new Error("Pick a template."), { statusCode: 400 });
    // A space starts from a template for the role picked at signup.
    if (account.onboardingRole && template.role !== account.onboardingRole) {
      throw Object.assign(new Error("Pick a template for your role."), { statusCode: 400 });
    }
    // Whatever the mode, the source is checked: with sync on, even "fresh" copies from it.
    // In a space shared with you, "the open space" is not yours to copy: your own account is.
    const here = settingsUserOf(request);
    const from = body.settings.mode === "fresh" ? here : (body.settings.from ?? here);
    await mine(request, from);

    const spaceId = await createSpaceUser(prisma, accountIdOf(request), { name: body.name, icon: body.icon ?? null });
    try {
      // Settings first, so the template's assistant tone (applied next) is the one that stays.
      if (body.settings.mode !== "fresh" || account.spaceSettingsSync) await copySettings(prisma, from, spaceId);
      if (body.settings.mode === "sync" && !account.spaceSettingsSync) {
        await prisma.user.update({ where: { id: accountIdOf(request) }, data: { spaceSettingsSync: true } });
        for (const id of await spaceIds(prisma, accountIdOf(request))) if (id !== from && id !== spaceId) await copySettings(prisma, from, id);
      }
      await applyOnboarding(prisma, spaceId, template.id);
    } catch (error) {
      await deleteAccountData(prisma, spaceId).catch(() => undefined);
      throw error;
    }
    await prisma.user.update({ where: { id: accountIdOf(request) }, data: { lastSpaceId: spaceId } });
    await appendLedger({ userId: accountIdOf(request), actor: "me", action: "space.create", payload: { spaceId, templateId: template.id, settings: body.settings.mode } });
    setSpaceCookie(reply, request, spaceId);
    const listed = await listSpaces(prisma, accountIdOf(request));
    return reply.code(201).send({ space: listed.spaces.find((row) => row.id === spaceId), activeId: spaceId });
  });

  app.post("/api/spaces/:id/switch", async (request, reply) => {
    browserOnly(request);
    const id = Id.parse((request.params as { id: string }).id);
    // Yours, or shared with you as a member.
    if (id !== accountIdOf(request) && !(await openableSpace(prisma, accountIdOf(request), id))) {
      throw Object.assign(new Error("That space is not yours."), { statusCode: 404 });
    }
    await prisma.user.update({ where: { id: accountIdOf(request) }, data: { lastSpaceId: id === accountIdOf(request) ? null : id } });
    setSpaceCookie(reply, request, id === accountIdOf(request) ? null : id);
    return { activeId: id };
  });

  app.patch("/api/spaces/:id", async (request) => {
    browserOnly(request);
    const id = Id.parse((request.params as { id: string }).id);
    const body = z.object({ name: Name.optional(), icon: Icon }).parse(request.body);
    await mine(request, id);
    await prisma.user.update({
      where: { id },
      data: { ...(body.name !== undefined ? { spaceName: body.name } : {}), ...(body.icon !== undefined ? { spaceIcon: body.icon } : {}) },
    });
    const listed = await listSpaces(prisma, accountIdOf(request));
    return { space: listed.spaces.find((row) => row.id === id) };
  });

  app.delete("/api/spaces/:id", async (request, reply) => {
    browserOnly(request);
    const id = Id.parse((request.params as { id: string }).id);
    const body = z.object({ confirmation: z.string().max(80) }).parse(request.body ?? {});
    if (id === accountIdOf(request)) throw Object.assign(new Error("Your first space is your account. Delete the account from Settings instead."), { statusCode: 400 });
    await mine(request, id);
    const space = await prisma.user.findUniqueOrThrow({ where: { id }, select: { spaceName: true } });
    if (body.confirmation.trim() !== (space.spaceName ?? "").trim()) {
      throw Object.assign(new Error("Type the space's name to delete it."), { statusCode: 400 });
    }
    // Refuse before unpairing anything, so a refused delete changes nothing.
    const active = await prisma.workspaceJob.count({ where: { userId: id, status: { in: ["running", "claimed", "stopping", "waiting_approval"] } } });
    if (active) throw Object.assign(new Error("Stop the agent runs in this space before deleting it."), { statusCode: 409 });
    const devices = await prisma.device.findMany({ where: { userId: id, revokedAt: null } });
    for (const device of devices) await revokePairedDevice(prisma, id, device);
    // Everyone it was shared with loses it with the space; tell their open tabs.
    const told = [
      ...(await prisma.spaceMember.findMany({ where: { spaceId: id }, select: { accountId: true } })).map((row) => row.accountId),
      ...(await prisma.share.findMany({ where: { spaceId: id }, select: { recipientId: true } })).map((row) => row.recipientId),
    ];
    await deleteAccountData(prisma, id);
    for (const person of new Set(told)) sseHub.publish(person, { event: "sharing.changed", data: {} });
    sseHub.close(id);
    await prisma.user.updateMany({ where: { id: accountIdOf(request), lastSpaceId: id }, data: { lastSpaceId: null } });
    await appendLedger({ userId: accountIdOf(request), actor: "me", action: "space.delete", payload: { spaceId: id } });
    if (request.userId === id) setSpaceCookie(reply, request, null);
    return reply.code(204).send();
  });

  /** Brings another space's settings into the open one. */
  app.post("/api/spaces/settings/copy", async (request) => {
    browserOnly(request);
    const { from } = z.object({ from: Id }).parse(request.body);
    if (!ownsOpenSpace(request)) throw Object.assign(new Error("Only the space's owner can change its settings."), { statusCode: 403 });
    await mine(request, from);
    await copySettings(prisma, from, request.userId);
    await mirrorSettings(prisma, request.userId);
    await appendLedger({ userId: accountIdOf(request), actor: "me", action: "space.settings.copy", payload: { from, to: request.userId } });
    return { copied: true };
  });

  /** Keeps every space on the same settings. Turning it on copies `from` (default: the open space) to the rest. */
  app.put("/api/spaces/settings/sync", async (request) => {
    browserOnly(request);
    const body = z.object({ on: z.boolean(), from: Id.optional() }).parse(request.body);
    const from = body.from ?? settingsUserOf(request);
    const ids = await mine(request, from);
    await prisma.user.update({ where: { id: accountIdOf(request) }, data: { spaceSettingsSync: body.on } });
    if (body.on) for (const id of ids) if (id !== from) await copySettings(prisma, from, id);
    await appendLedger({ userId: accountIdOf(request), actor: "me", action: "space.settings.sync", payload: { on: body.on, from } });
    return { sync: body.on };
  });
}
