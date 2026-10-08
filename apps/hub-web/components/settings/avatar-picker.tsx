"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import {
  AVATAR_GENDER_LABEL,
  AVATAR_GENDERS,
  AVATAR_ROLE_LABEL,
  AVATAR_ROLES,
  avatarGenderFor,
  avatarIds,
  avatarRoleFor,
  parseAvatar,
  type AvatarGender,
  type AvatarRole,
} from "@ensemble/shared-types";
import { api } from "@/lib/api";
import { personInitials } from "@/lib/initials";
import { PersonaAvatar } from "@/components/avatars/persona";
import { useToast } from "../toast";
import { SectionCard, cx } from "../ui";

/** Settings → Account: pick a picture avatar for your profession, or keep your initials. */
export function AvatarPicker() {
  const client = useQueryClient();
  const toast = useToast();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const user = me.data?.user;
  const current = user?.avatar ?? null;
  const spaces = useQuery({ queryKey: ["spaces"], queryFn: api.spaces, staleTime: 60_000 });
  const fromProfile = avatarRoleFor(spaces.data?.account.role, user?.profile.profession);
  const [role, setRole] = useState<AvatarRole>(fromProfile);
  const firstGender = avatarGenderFor(user?.profile.gender);
  useEffect(() => {
    const picked = parseAvatar(current);
    setRole(picked?.role ?? fromProfile);
    // Only when what is saved changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, fromProfile]);
  const save = useMutation({
    mutationFn: (avatar: string | null) => api.updateMe({ avatar }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["me"] });
      void client.invalidateQueries({ queryKey: ["shell"] });
      toast("Avatar saved. Everyone you share with sees it.", { tone: "ok" });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  const genders: AvatarGender[] = [firstGender, ...AVATAR_GENDERS.filter((value) => value !== firstGender)];
  const initials = personInitials(user?.name, user?.email);

  return (
    <SectionCard title="Avatar" description="How you show up in shared spaces, on pages people are looking at together, and in the top bar.">
      <div className="flex flex-wrap items-center gap-4">
        <span className="inline-flex size-16 items-center justify-center overflow-hidden rounded-full border border-line-strong bg-raised text-[20px] font-semibold">
          {current ? <PersonaAvatar id={current} size={64} /> : initials}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">{current ? `${AVATAR_ROLE_LABEL[parseAvatar(current)!.role]} avatar` : "Your initials"}</div>
          <div className="mt-0.5 text-2xs text-muted">Pick a set below. Your initials are the fallback.</div>
        </div>
        <button type="button" className="btn h-7 px-2.5 text-[12.5px]" disabled={!current || save.isPending} onClick={() => save.mutate(null)}>
          Use initials
        </button>
      </div>
      <div className="mt-4 flex flex-wrap gap-1" role="group" aria-label="Avatar set">
        {AVATAR_ROLES.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={role === value}
            onClick={() => setRole(value)}
            className={cx("rounded-md px-2.5 py-1 text-[12.5px]", role === value ? "bg-hover font-medium text-ink" : "text-muted hover:bg-hover hover:text-ink")}
          >
            {AVATAR_ROLE_LABEL[value]}
            {value === fromProfile ? <span className="ml-1 text-faint">· you</span> : null}
          </button>
        ))}
      </div>
      <div className="mt-3 space-y-3">
        {genders.map((gender) => (
          <div key={gender}>
            <div className="mb-1.5 text-2xs uppercase tracking-wide text-faint">{AVATAR_GENDER_LABEL[gender]}</div>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={`${AVATAR_ROLE_LABEL[role]} avatars, ${AVATAR_GENDER_LABEL[gender]}`}>
              {avatarIds(role, gender).map((id) => {
                const selected = id === current;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={`${AVATAR_ROLE_LABEL[role]} avatar ${id.split(".")[2]}`}
                    disabled={save.isPending}
                    onClick={() => save.mutate(id)}
                    className={cx(
                      "relative rounded-full p-0.5 transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                      selected ? "ring-2 ring-accent" : "ring-1 ring-line",
                    )}
                  >
                    <PersonaAvatar id={id} size={48} />
                    {selected ? (
                      <span className="absolute -bottom-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-accent text-white">
                        <Check size={10} strokeWidth={3} />
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
