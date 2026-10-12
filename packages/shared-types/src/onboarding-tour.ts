/** Personal UI preference, scoped to the owner's Ensemble space. */
export const ONBOARDING_TOUR_KEY = "ui.onboarding-tour";

export type OnboardingTourProgress = {
  v: 1;
  status: "ready" | "active" | "completed" | "skipped";
  step: string;
  updatedAt: number;
};

export const READY_ONBOARDING_TOUR: OnboardingTourProgress = {
  v: 1, status: "ready", step: "welcome", updatedAt: 0,
};

export function readTourProgress(value: unknown): OnboardingTourProgress | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<OnboardingTourProgress>;
  if (row.v !== 1 || !["ready", "active", "completed", "skipped"].includes(row.status ?? "") ||
      typeof row.step !== "string" || typeof row.updatedAt !== "number" || !Number.isFinite(row.updatedAt)) return null;
  return row as OnboardingTourProgress;
}
