import { z } from "zod";
import { OPTIONAL_MODULES } from "@ensemble/shared-types/modules";
import { MARKETPLACE, textSafe, type MarketTemplate } from "@ensemble/shared-types/marketplace";
import { validateLayout } from "@ensemble/shared-types/widgets";

const plain = (max: number) => z.string().max(max).refine((value) => textSafe(value), "plain text only");

export const Measure = z.number().int().min(0).max(100000);

const Task = z
  .object({
    slug: z.string().regex(/^[a-z0-9-]{1,40}$/),
    title: plain(120),
    taskType: z.string().max(24).optional(),
    dueInDays: z.number().int().min(0).max(3650).optional(),
    page: plain(8000).optional(),
    measure: Measure.optional(),
    deliverable: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
  })
  .strict();

const Project = z
  .object({
    slug: z.string().regex(/^[a-z0-9-]{1,40}$/),
    name: plain(80),
    summary: plain(240).optional(),
    people: z
      .array(z.object({ slug: z.string().regex(/^[a-z0-9-]{1,40}$/), name: plain(80), role: plain(80).optional() }).strict())
      .max(4)
      .optional(),
    tasks: z.array(Task).max(12).optional(),
    deliverables: z
      .array(z.object({ slug: z.string(), title: plain(120), dueInDays: z.number().int().min(0).max(3650).nullable().optional() }).strict())
      .max(4)
      .optional(),
    artifacts: z
      .array(
        z
          .object({
            slug: z.string(),
            title: plain(120),
            kind: z.enum(["file", "pr"]).optional(),
            task: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
          })
          .strict(),
      )
      .max(4)
      .optional(),
    reminders: z.array(z.object({ slug: z.string(), title: plain(120), dueInDays: z.number().int().min(0).max(3650) }).strict()).max(4).optional(),
    notes: z
      .array(
        z
          .object({
            slug: z.string().regex(/^[a-z0-9-]{1,40}$/),
            title: plain(120),
            body: plain(2000),
            people: z.array(z.string().regex(/^[a-z0-9-]{1,40}$/)).max(4).optional(),
          })
          .strict(),
      )
      .max(2)
      .optional(),
    repo: z.object({ slug: z.string().regex(/^[a-z0-9-]{1,40}$/), fullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) }).strict().optional(),
  })
  .strict();

export const MarketplaceTemplate = z
  .object({
    id: z.string().regex(/^mkt\.[a-z0-9-]{1,40}$/),
    version: z.number().int().min(1).max(1000),
    persona: z.enum(["student", "teacher", "lawyer", "researcher", "manager", "aspirant", "maker", "engineer"]),
    name: plain(40),
    blurb: plain(140),
    accent: z.enum(["indigo", "tide", "ember", "rose", "brass", "orchid", "moss", "sky"]).optional(),
    actAs: z.enum(["general", "student", "engineer", "teacher", "lawyer", "researcher", "manager", "aspirant", "maker"]),
    highlights: z.array(plain(80)).max(4),
    modules: z.array(z.enum(OPTIONAL_MODULES)).max(OPTIONAL_MODULES.length),
    labels: z
      .object({
        project: plain(24).optional(),
        projects: plain(24).optional(),
        task: plain(24).optional(),
        tasks: plain(24).optional(),
        deliverable: plain(24).optional(),
        deliverables: plain(24).optional(),
        board: plain(24).optional(),
        people: plain(24).optional(),
      })
      .strict()
      .optional(),
    lens: z
      .object({
        groupBy: z.enum(["kind", "project"]),
        kinds: z.array(z.enum(["people", "projects", "repos", "meetings", "artifacts"])).max(5),
      })
      .strict()
      .optional(),
    expiresInDays: z.number().int().min(1).max(366).optional(),
    layouts: z.object({
      today: z.unknown(),
      context: z.unknown(),
      board: z.unknown().optional(),
    }),
    starters: z.array(Project).max(2),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.modules.includes("metrics") && !value.modules.includes("runs") && !value.modules.includes("workspace")) {
      ctx.addIssue({ code: "custom", message: "metrics needs runs or workspace" });
    }
    const people = value.starters.reduce((sum, row) => sum + (row.people?.length ?? 0), 0);
    const tasks = value.starters.reduce((sum, row) => sum + (row.tasks?.length ?? 0), 0);
    const deliverables = value.starters.reduce((sum, row) => sum + (row.deliverables?.length ?? 0), 0);
    const pages = value.starters.reduce((sum, row) => sum + (row.tasks?.filter((task) => task.page).length ?? 0), 0);
    if (people > 4) ctx.addIssue({ code: "custom", message: "at most 4 people" });
    if (tasks > 12) ctx.addIssue({ code: "custom", message: "at most 12 tasks" });
    if (deliverables > 4) ctx.addIssue({ code: "custom", message: "at most 4 deliverables" });
    if (pages > 2) ctx.addIssue({ code: "custom", message: "at most 2 task pages" });
    for (const [surface, document] of [
      ["today", value.layouts.today],
      ["context", value.layouts.context],
      ["board", value.layouts.board],
    ] as const) {
      if (!document) continue;
      const checked = validateLayout(surface, document);
      if (!checked.ok) ctx.addIssue({ code: "custom", message: `${value.id} ${surface}: ${checked.error}` });
    }
    if (JSON.stringify(value).length > 32 * 1024) ctx.addIssue({ code: "custom", message: "template larger than 32 KB" });
  });

export function loadCatalog(input: readonly MarketTemplate[] = MARKETPLACE): MarketTemplate[] {
  if (input.length > 32) throw new Error("catalog: at most 32 templates");
  return input.map((row) => MarketplaceTemplate.parse(row) as MarketTemplate);
}

/** Parsed once. A bad template refuses to boot apply. */
export const CATALOG = loadCatalog();
