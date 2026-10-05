let openClaimed: (() => void) | null = null;

export function claimEnsemble(open: () => void): void {
  openClaimed = open;
}

export function openClaimedEnsemble(): void {
  openClaimed?.();
}
