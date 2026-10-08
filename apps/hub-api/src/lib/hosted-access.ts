export type AccessUser = { email: string; emailVerifiedAt: Date | null };
export type UserResolver = (userId: string) => Promise<AccessUser | null>;

export class HostedAccessError extends Error {
  readonly statusCode = 403;
  readonly expose = true;
  constructor(message: string, readonly code: "EMAIL_UNVERIFIED" | "HOST_ACCESS_DENIED") {
    super(message);
    this.name = "HostedAccessError";
  }
}

export function isHosted(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production" && env.ENSEMBLE_DESKTOP !== "1";
}

export function operatorEmail(email: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.ENSEMBLE_OPERATOR_EMAILS ?? "").split(",").map((value) => value.trim()).filter(Boolean).includes(email);
}

export function createHostedAccessPolicy(resolveUser: UserResolver, env: NodeJS.ProcessEnv = process.env) {
  async function user(userId: string | null | undefined): Promise<AccessUser> {
    const found = userId ? await resolveUser(userId) : null;
    if (!found) throw new HostedAccessError("A signed-in account is required to use hosted resources.", "HOST_ACCESS_DENIED");
    return found;
  }
  return {
    async isOperatorUser(userId: string): Promise<boolean> {
      const found = await user(userId);
      return operatorEmail(found.email, env) && (!isHosted(env) || Boolean(found.emailVerifiedAt));
    },
    async requireVerifiedUser(userId: string | null | undefined): Promise<void> {
      if (!isHosted(env)) return;
      if (!(await user(userId)).emailVerifiedAt) {
        throw new HostedAccessError("Verify your email before using hosted resources.", "EMAIL_UNVERIFIED");
      }
    },
    async requireHostAccess(userId: string | null | undefined, feature: string): Promise<void> {
      if (!isHosted(env)) return;
      const found = await user(userId);
      if (!found.emailVerifiedAt) throw new HostedAccessError("Verify your email before using hosted resources.", "EMAIL_UNVERIFIED");
      if (!operatorEmail(found.email, env)) {
        throw new HostedAccessError(`${feature} is available only to the hosted Ensemble operator. Use a paired computer for local execution.`, "HOST_ACCESS_DENIED");
      }
    },
    async canUseHostCredentials(userId: string | null | undefined): Promise<boolean> {
      if (!isHosted(env)) return true;
      if (!userId) return false;
      const found = await user(userId);
      return Boolean(found.emailVerifiedAt) && operatorEmail(found.email, env);
    },
  };
}

/** A space answers with its owner: verification and operator status belong to the account. */
const defaultResolver: UserResolver = async (userId) => {
  const { prisma } = await import("./prisma.js");
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerifiedAt: true, owner: { select: { email: true, emailVerifiedAt: true } } } });
  if (!row) return null;
  return row.owner ?? { email: row.email, emailVerifiedAt: row.emailVerifiedAt };
};
let resolver = defaultResolver;

export function setHostedUserResolverForTests(value: UserResolver | null): void {
  resolver = value ?? defaultResolver;
}

const policy = createHostedAccessPolicy((userId) => resolver(userId));
export const isOperatorUser = policy.isOperatorUser;
export const requireVerifiedUser = policy.requireVerifiedUser;
export const requireHostAccess = policy.requireHostAccess;
export const canUseHostCredentials = policy.canUseHostCredentials;

export async function enforceHostedRequest(request: { userId?: string; method: string }, path: string): Promise<void> {
  if (request.method === "POST" && path === "/api/assistant/turn") await requireVerifiedUser(request.userId);
}

export async function requireHostTerminal(userId: string): Promise<void> {
  if (process.env.ENSEMBLE_TERMINAL === "off" || (isHosted() && process.env.ENSEMBLE_TERMINAL !== "on")) {
    throw new HostedAccessError("The host terminal is disabled by the instance operator.", "HOST_ACCESS_DENIED");
  }
  await requireHostAccess(userId, "Host terminal");
}
