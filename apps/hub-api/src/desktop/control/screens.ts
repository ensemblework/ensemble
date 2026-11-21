/**
 * The two screens desktop control works on (docs/25 §11): the owner's real screen and the agent screen,
 * a private headless desktop of the agent's own that nobody sees unless they watch it. Each has its own
 * service and helper. A call names its screen, or works where its capture id was taken (or where its
 * recording is), or where its controller last worked, else on the agent screen; it never moves to the
 * other screen by itself. Asking about the agent screen never starts it, nor the owner's screen's helper
 * where that screen cannot work (no desktop session, missing libraries).
 */
import type { AgentScreenReadiness, DesktopReadiness } from "./readiness.js";
import type { AppsResult, DesktopService, DesktopStatus, ScreenName } from "./service.js";

export type BothStatus = { owner: DesktopStatus; agent: DesktopStatus | null; agentReadiness: AgentScreenReadiness };

export class Desktops {
  private agentService: DesktopService | null = null;
  private readonly last = new Map<string, ScreenName>();

  constructor(
    readonly owner: DesktopService,
    private readonly makeAgent: () => DesktopService,
  ) {}

  /** The agent screen's service, made on first use (its helper starts the screen on its first call). */
  agent(): DesktopService {
    this.agentService ??= this.makeAgent();
    return this.agentService;
  }

  /** The agent screen's service while its screen is up, else null. */
  runningAgent(): DesktopService | null {
    return this.agentService?.helperReady ? this.agentService : null;
  }

  service(screen: ScreenName): DesktopService {
    return screen === "owner" ? this.owner : this.agent();
  }

  /** Where a call works: the screen it names, its capture id's, its recording's, the one its controller last used, else the agent screen. */
  pick(key: string, hints: { screen?: ScreenName; captureId?: string; recording?: boolean } = {}): ScreenName {
    if (hints.screen) return hints.screen;
    if (hints.captureId) {
      if (this.owner.ledger.get(hints.captureId)) return "owner";
      if (this.agentService?.ledger.get(hints.captureId)) return "agent";
    }
    if (hints.recording) {
      if (this.owner.hasRecording(key)) return "owner";
      if (this.agentService?.hasRecording(key)) return "agent";
    }
    return this.last.get(key) ?? "agent";
  }

  remember(key: string, screen: ScreenName): void {
    this.last.set(key, screen);
  }

  /** Both screens' state; the agent screen's facts only while it runs, else whether it can start. */
  async status(budgetMs: number, readiness: () => Promise<DesktopReadiness>): Promise<BothStatus> {
    const facts = await readiness();
    const running = this.runningAgent();
    const ownerWorks = facts.ready || this.owner.helperReady;
    const [owner, agent] = await Promise.all([
      ownerWorks ? this.owner.status(budgetMs) : Promise.resolve(this.owner.offline(facts.reason ?? "Desktop control cannot start here.")),
      running ? running.status(budgetMs) : Promise.resolve(null),
    ]);
    return { owner, agent, agentReadiness: facts.agentScreen };
  }

  /** The apps: installed, and running on the named screen, or on the owner's and the agent screen's while it runs. */
  async apps(input: { query?: string; running?: boolean; screen?: ScreenName }, budgetMs: number): Promise<AppsResult[]> {
    if (input.screen) return [await this.service(input.screen).apps(input, budgetMs)];
    const running = this.runningAgent();
    const [owner, agent] = await Promise.all([this.owner.apps(input, budgetMs), running ? running.apps({ ...input, running: true }, budgetMs) : Promise.resolve(null)]);
    return agent ? [owner, agent] : [owner];
  }

  async release(key: string): Promise<void> {
    this.last.delete(key);
    await this.owner.release(key);
    await this.agentService?.release(key);
  }

  async stop(): Promise<void> {
    await Promise.all([this.owner.stop(), this.agentService?.stop()]);
    this.agentService = null;
  }
}
