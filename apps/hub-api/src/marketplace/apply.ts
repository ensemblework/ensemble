import type { Prisma, PrismaClient } from "@prisma/client";
import { FULL_MODULE_SET } from "@ensemble/shared-types/modules";
import { templateByMarketId, type MarketTemplate } from "@ensemble/shared-types/marketplace";
import { readOrder, ORDER_KEY } from "../context/order.js";
import { loadSettings, saveSettings } from "../lib/settings.js";
import { seedMarketplace } from "./seed.js";

type Db = Prisma.TransactionClient;

const HISTORY_CAP = 20;
const SNAPSHOT_BYTES = 64 * 1024;

type Layouts = { today: unknown; context: unknown; board: unknown };

type Snapshot = {
  templateId: string | null;
  version: number;
  modules: string;
  layouts: Layouts;
  lens: unknown;
  labels: unknown;
  actAs: string;
  accent: string;
  accentCustom: string | null;
  expiresAt: string | null;
};

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

async function capture(tx: Db, userId: string): Promise<Snapshot> {
  const [user, layouts, pref, settings] = await Promise.all([
    tx.user.findUnique({ where: { id: userId } }),
    tx.widgetLayout.findMany({ where: { userId } }),
    tx.preference.findFirst({ where: { userId, key: ORDER_KEY, deletedAt: null } }),
    loadSettings(tx as unknown as PrismaClient, userId),
  ]);
  if (!user) fail(401, "Sign in.");
  const doc = (surface: string) => layouts.find((row) => row.surface === surface)?.document ?? null;
  const snapshot: Snapshot = {
    templateId: user.activeTemplateId,
    version: user.appliedVersion,
    modules: user.moduleSet,
    layouts: { today: doc("today"), context: doc("context"), board: doc("board") },
    lens: pref?.value ?? null,
    labels: user.chromeLabels,
    actAs: settings.assistant.actAs,
    accent: settings.appearance.accent,
    accentCustom: settings.appearance.accentCustom,
    expiresAt: user.templateExpiresAt ? user.templateExpiresAt.toISOString() : null,
  };
  if (JSON.stringify(snapshot).length > SNAPSHOT_BYTES) fail(400, "That snapshot is too large.");
  return snapshot;
}

async function writeLayout(tx: Db, userId: string, surface: string, document: unknown, templateId: string | null) {
  if (!document) {
    await tx.widgetLayout.deleteMany({ where: { userId, surface } });
    return;
  }
  await tx.widgetLayout.upsert({
    where: { userId_surface: { userId, surface } },
    create: { userId, surface, templateId, document: document as object },
    update: { templateId, document: document as object },
  });
}

async function writeLayouts(tx: Db, userId: string, layouts: Layouts, templateId: string | null) {
  await writeLayout(tx, userId, "today", layouts.today, templateId);
  await writeLayout(tx, userId, "context", layouts.context, templateId);
  await writeLayout(tx, userId, "board", layouts.board, templateId);
}

async function remember(tx: Db, userId: string, snapshot: Snapshot) {
  await tx.templateApplication.create({
    data: {
      userId,
      templateId: snapshot.templateId ?? "default",
      version: snapshot.version,
      snapshot: snapshot as object,
    },
  });
  const count = await tx.templateApplication.count({ where: { userId } });
  if (count <= HISTORY_CAP) return;
  const oldest = await tx.templateApplication.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    take: count - HISTORY_CAP,
    select: { id: true },
  });
  if (oldest.length) await tx.templateApplication.deleteMany({ where: { id: { in: oldest.map((row) => row.id) } } });
}

async function restore(tx: Db, userId: string, snapshot: Snapshot) {
  await writeLayouts(tx, userId, snapshot.layouts, snapshot.templateId);
  await tx.user.update({
    where: { id: userId },
    data: {
      moduleSet: snapshot.modules,
      activeTemplateId: snapshot.templateId,
      appliedVersion: snapshot.version,
      chromeLabels: (snapshot.labels ?? {}) as object,
      templateExpiresAt: snapshot.expiresAt ? new Date(snapshot.expiresAt) : null,
    },
  });
  await tx.session.updateMany({ where: { userId }, data: { modules: snapshot.modules } });
  await saveSettings(tx as unknown as PrismaClient, userId, {
    assistant: { actAs: snapshot.actAs },
    appearance: { accent: snapshot.accent, accentCustom: snapshot.accentCustom },
  });
  await writeLens(tx, userId, snapshot.lens);
}

async function writeLens(tx: Db, userId: string, lens: unknown) {
  if (lens && typeof lens === "object") {
    await tx.preference.upsert({
      where: { userId_key: { userId, key: ORDER_KEY } },
      create: { userId, key: ORDER_KEY, value: lens as object, source: "me" },
      update: { value: lens as object, source: "me", deletedAt: null },
    });
    return;
  }
  await tx.preference.deleteMany({ where: { userId, key: ORDER_KEY } });
}

type StoredBaseline = {
  layouts: Layouts;
  lens: unknown;
  accent: string;
  accentCustom: string | null;
};

function readBaseline(value: unknown): { layouts: Layouts | null; chrome: StoredBaseline | null } {
  if (!value || typeof value !== "object") return { layouts: null, chrome: null };
  const row = value as Record<string, unknown>;
  if (row.layouts && typeof row.layouts === "object") {
    return {
      layouts: row.layouts as Layouts,
      chrome: {
        layouts: row.layouts as Layouts,
        lens: row.lens ?? null,
        accent: typeof row.accent === "string" ? row.accent : "indigo",
        accentCustom: typeof row.accentCustom === "string" ? row.accentCustom : null,
      },
    };
  }
  return { layouts: value as Layouts, chrome: null };
}

async function applyBody(tx: Db, userId: string, template: MarketTemplate, timeZone: string) {
  const before = await capture(tx, userId);
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user) fail(401, "Sign in.");
  if (!user.layoutBaseline) {
    const baseline: StoredBaseline = {
      layouts: before.layouts,
      lens: before.lens,
      accent: before.accent,
      accentCustom: before.accentCustom,
    };
    await tx.user.update({ where: { id: userId }, data: { layoutBaseline: baseline as object } });
  }
  await remember(tx, userId, before);
  const modules = [...template.modules].sort().join(",");
  await writeLayouts(
    tx,
    userId,
    { today: template.layouts.today, context: template.layouts.context, board: template.layouts.board ?? null },
    template.id,
  );
  const settings = await loadSettings(tx as unknown as PrismaClient, userId);
  const expires = template.expiresInDays ? new Date(Date.now() + template.expiresInDays * 86_400_000) : null;
  await tx.user.update({
    where: { id: userId },
    data: {
      moduleSet: modules,
      activeTemplateId: template.id,
      appliedVersion: template.version,
      chromeLabels: (template.labels ?? {}) as object,
      templateExpiresAt: expires,
    },
  });
  await tx.session.updateMany({ where: { userId }, data: { modules } });
  const patch: Record<string, unknown> = { assistant: { actAs: template.actAs } };
  if (template.accent && !settings.appearance.accentCustom) patch.appearance = { accent: template.accent };
  await saveSettings(tx as unknown as PrismaClient, userId, patch);
  if (template.lens) {
    const pref = await tx.preference.findFirst({ where: { userId, key: ORDER_KEY, deletedAt: null } });
    const current = readOrder(pref?.value);
    const next = { ...current, group: template.lens.groupBy, kinds: template.lens.kinds };
    await tx.preference.upsert({
      where: { userId_key: { userId, key: ORDER_KEY } },
      create: { userId, key: ORDER_KEY, value: next, source: "me" },
      update: { value: next, source: "me", deletedAt: null },
    });
  }
  await seedMarketplace(tx, userId, template, timeZone);
  return modules;
}

async function applyDefault(tx: Db, userId: string) {
  const before = await capture(tx, userId);
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user) fail(401, "Sign in.");
  await remember(tx, userId, before);
  const baseline = readBaseline(user.layoutBaseline);
  if (baseline.layouts) await writeLayouts(tx, userId, baseline.layouts, null);
  if (baseline.chrome) {
    await writeLens(tx, userId, baseline.chrome.lens);
    await saveSettings(tx as unknown as PrismaClient, userId, {
      appearance: { accent: baseline.chrome.accent, accentCustom: baseline.chrome.accentCustom },
    });
  } else {
    const oldest = await tx.templateApplication.findFirst({ where: { userId }, orderBy: { createdAt: "asc" } });
    const snap = oldest?.snapshot as Snapshot | undefined;
    if (snap && typeof snap.accent === "string") {
      await writeLens(tx, userId, snap.lens ?? null);
      await saveSettings(tx as unknown as PrismaClient, userId, {
        appearance: { accent: snap.accent, accentCustom: snap.accentCustom ?? null },
      });
    }
  }
  await tx.user.update({
    where: { id: userId },
    data: {
      moduleSet: FULL_MODULE_SET,
      activeTemplateId: "default",
      appliedVersion: 1,
      chromeLabels: {},
      templateExpiresAt: null,
    },
  });
  await tx.session.updateMany({ where: { userId }, data: { modules: FULL_MODULE_SET } });
  return FULL_MODULE_SET;
}

export async function applyMarketplace(prisma: PrismaClient, userId: string, id: string): Promise<{ id: string; modules: string }> {
  const settings = await loadSettings(prisma, userId);
  const modules = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) fail(401, "Sign in.");
    if (id === "default") {
      if (user.activeTemplateId === "default") return user.moduleSet || FULL_MODULE_SET;
      return applyDefault(tx, userId);
    }
    const template = templateByMarketId(id);
    if (!template) fail(400, "Unknown template.");
    if (user.activeTemplateId === template.id && user.appliedVersion === template.version) return user.moduleSet;
    return applyBody(tx, userId, template, settings.timezone);
  });
  return { id, modules };
}

export async function revertMarketplace(prisma: PrismaClient, userId: string): Promise<{ id: string; modules: string }> {
  const result = await prisma.$transaction(async (tx) => {
    const latest = await tx.templateApplication.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } });
    if (!latest) fail(400, "Nothing to revert.");
    const snapshot = latest.snapshot as Snapshot;
    await tx.templateApplication.delete({ where: { id: latest.id } });
    await restore(tx, userId, snapshot);
    return { id: snapshot.templateId ?? "default", modules: snapshot.modules };
  });
  return result;
}
