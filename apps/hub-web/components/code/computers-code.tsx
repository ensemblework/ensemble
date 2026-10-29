"use client";

import { useQuery } from "@tanstack/react-query";
import { TerminalSquare } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ComputerName, Fold, InlineError, RepoList, ReviewItem } from "@/components/code/code-lists";
import { Terminal } from "@/components/code/terminal";
import { SkeletonRows, Tag, cx } from "@/components/ui";
import { api } from "@/lib/api";
import { placeOfDevice, repoHref, reposKey, reviewHref, reviewsKey, type Computer } from "@/lib/code-home";
import { repoName, repoViews, viewFor, type RepoView } from "@/lib/code-repos";
import { deviceCodeApi } from "@/lib/code-target";

/** Rows whose name, note or branch holds the filter text. */
export function matchRepos(repos: RepoView[], filter: string): RepoView[] {
  const text = filter.trim().toLowerCase();
  if (!text) return repos;
  return repos.filter((repo) => [repo.name, repo.note, repo.branch, repo.remote].some((value) => value?.toLowerCase().includes(text)));
}

/**
 * Code's Explorer on Ensemble on the web (protocol 4, docs/16): one section per paired computer with
 * its agent changes to review and its repositories, read from that computer and opened in the same
 * editor the Code tab has on the computer itself, and its terminal (unlocked with a passkey here).
 */
export function ComputersCode({ selected, filter = "", onTerminal }: { selected?: string | null; filter?: string; onTerminal?: (deviceId: string) => void }) {
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices, staleTime: 30_000 });
  const [own, setOwn] = useState<string | null>(null);
  if (devices.isLoading) return <SkeletonRows count={3} rowClassName="h-6" className="space-y-1.5 px-3 py-1" />;
  if (devices.error) return <InlineError error={devices.error} retry={() => void devices.refetch()} />;
  const paired = devices.data?.devices ?? [];
  if (!paired.length) {
    return (
      <div className="px-3 py-1 text-[12.5px] text-muted">
        No paired computer yet. <Link href="/settings#devices" className="text-accent hover:underline">Pair a computer</Link>
      </div>
    );
  }
  return (
    <div data-testid="computers-code">
      {paired.map((device) => (
        <ComputerCode
          key={device.id}
          device={device}
          selected={selected === device.id}
          filter={filter}
          terminalOpen={!onTerminal && own === device.id}
          onTerminal={onTerminal ?? ((id) => setOwn(own === id ? null : id))}
        />
      ))}
    </div>
  );
}

function ComputerCode({ device, selected, filter, terminalOpen, onTerminal }: { device: Computer; selected: boolean; filter: string; terminalOpen: boolean; onTerminal: (deviceId: string) => void }) {
  const place = placeOfDevice(device);
  const code = useMemo(() => deviceCodeApi(device.id), [device.id]);
  const reviews = useQuery({ queryKey: reviewsKey(place), queryFn: () => code.reviews("all", false), enabled: place.usable, retry: false, staleTime: 15_000 });
  const repos = useQuery({ queryKey: reposKey(place), queryFn: () => code.codeRepos(), enabled: place.usable, retry: false, staleTime: 60_000 });
  const views = repoViews(repos.data);
  const text = filter.trim().toLowerCase();
  const toReview = (reviews.data?.reviews ?? []).filter((review) => !text || review.title.toLowerCase().includes(text));
  return (
    <section className={cx("border-b border-line/70 last:border-b-0", selected && "bg-[rgb(var(--accent-rgb)/0.04)]")} data-testid={`computer-code-${device.id}`}>
      <Fold
        title={<ComputerName name={device.name} online={device.online} />}
        actions={
          <>
            {place.viewOnly ? <Tag tone="gray">view only</Tag> : null}
            {place.terminal ? (
              <button type="button" className="icon-btn h-6 w-6" onClick={() => onTerminal(device.id)} title="The terminal on this computer, unlocked with your passkey" aria-label={`Terminal on ${device.name}`}>
                <TerminalSquare size={13} />
              </button>
            ) : null}
          </>
        }
      >
        {place.why ? (
          <div className="px-3 pb-1 text-[12px] text-muted [overflow-wrap:anywhere]">{place.why}</div>
        ) : (
          <div className="space-y-2">
            <div>
              <div className="px-3 pb-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-faint">Changes to review</div>
              {reviews.isLoading ? (
                <SkeletonRows count={2} rowClassName="h-6" className="space-y-1 px-3" />
              ) : reviews.error ? (
                <InlineError error={reviews.error} retry={() => void reviews.refetch()} />
              ) : toReview.length === 0 ? (
                <div className="px-3 text-[12px] text-muted">{text ? "None match." : "No agent changes kept on this computer."}</div>
              ) : (
                <div className="space-y-0.5 px-1">
                  {toReview.slice(0, 12).map((review) => (
                    <ReviewItem key={review.id} review={review} repo={repoName(viewFor(review.repoPath, views))} href={reviewHref(place, review.id)} compact />
                  ))}
                </div>
              )}
            </div>
            <div>
              <div className="px-3 pb-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-faint">Repositories</div>
              {repos.isLoading ? (
                <SkeletonRows count={2} rowClassName="h-6" className="space-y-1 px-3" />
              ) : repos.error ? (
                <InlineError error={repos.error} retry={() => void repos.refetch()} />
              ) : (
                <RepoList repos={matchRepos(views, filter)} hrefOf={(path) => repoHref(place, path)} empty={text ? "None match." : "No git checkouts in the folders Code may use there."} />
              )}
            </div>
          </div>
        )}
      </Fold>
      {terminalOpen ? (
        <div className="h-72">
          <Terminal target={place.target} onClose={() => onTerminal(device.id)} />
        </div>
      ) : null}
    </section>
  );
}
