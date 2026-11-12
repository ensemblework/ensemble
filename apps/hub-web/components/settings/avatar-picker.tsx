"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, type KeyboardEvent } from "react";
import { AVATAR_CHARACTERS, AVATAR_PALETTES, AVATAR_SCENERIES, DEFAULT_AVATAR, avatarId, parseAvatar, type AvatarParts } from "@ensemble/shared-types";
import { api, type Me } from "@/lib/api";
import { personInitials } from "@/lib/initials";
import { radioKeyTarget } from "@/lib/radio-keys";
import { PersonaAvatar } from "@/components/avatars/persona";
import { LoadError } from "../load-error";
import { SectionCard, SettingRow, SkeletonRows, cx } from "../ui";

/** Every account has the same characters, colors and scenery. Changes save with its profile. */
export function AvatarPicker() {
  const client = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const characters = useRef<HTMLDivElement>(null);
  const colors = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const save = useMutation({
    mutationFn: (avatar: string | null) => api.updateMe({ avatar }),
    onSettled: () => { inFlight.current = false; },
    onSuccess: ({ user }) => {
      client.setQueryData<Me>(["me"], previous => previous ? { ...previous, user: { ...previous.user, ...user } } : previous);
      void client.invalidateQueries({ queryKey: ["me"] });
      void client.invalidateQueries({ queryKey: ["shell"] });
    },
  });
  const user = me.data?.user;
  const current = save.isPending ? save.variables : user?.avatar ?? null;
  const parts = parseAvatar(current);
  const selected = parts ?? DEFAULT_AVATAR;
  const character = AVATAR_CHARACTERS.find(row => row.id === selected.character)!;
  const palette = AVATAR_PALETTES.find(row => row.id === selected.palette)!;
  const commit = (next: string | null) => {
    if (inFlight.current || next === current) return;
    inFlight.current = true;
    save.mutate(next);
  };
  const choose = (next: AvatarParts) => commit(avatarId(next));
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, index: number, group: "character" | "palette") => {
    const count = group === "character" ? AVATAR_CHARACTERS.length : AVATAR_PALETTES.length;
    const next = radioKeyTarget(event.key, index, count);
    if (next === null || save.isPending) return;
    event.preventDefault();
    choose(group === "character" ? { ...selected, character: AVATAR_CHARACTERS[next]!.id } : { ...selected, palette: AVATAR_PALETTES[next]!.id });
    (group === "character" ? characters : colors).current?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
  };

  return <SectionCard title="Avatar" description="Pick a character, color and scenery." info="The same collection is available to every profile. Changes save automatically and appear wherever your account is shown. You can also use your initials.">
    {!user ? me.error ? <LoadError error={me.error} what="your avatar" retrying={me.isFetching} onRetry={() => void me.refetch()} /> : <SkeletonRows count={2} /> : <>
      <div className="flex flex-wrap items-center gap-4">
        <span className="inline-flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line-strong bg-raised text-[20px] font-semibold">
          {parts ? <PersonaAvatar id={avatarId(parts)} size={64} /> : personInitials(user.name, user.email)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">{parts ? character.label : "Your initials"}</div>
          {parts ? <div className="mt-0.5 text-2xs text-muted">{palette.label}</div> : null}
          {save.isPending ? <span role="status" className="text-2xs text-muted">Saving…</span> : null}
        </div>
        <button type="button" className="btn h-8 px-2.5 text-[12.5px]" disabled={!current || save.isPending} onClick={() => commit(null)}>Use initials</button>
      </div>
      {save.error ? <p role="alert" className="mt-3 text-[13px] text-danger">{(save.error as Error).message}</p> : null}
      <div className="mt-5">
        <div id="avatar-character-label" className="mb-2 text-[12.5px] text-muted">Character</div>
        <div ref={characters} role="radiogroup" aria-labelledby="avatar-character-label" className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {AVATAR_CHARACTERS.map((row, index) => {
            const on = parts?.character === row.id;
            return <button key={row.id} type="button" role="radio" aria-checked={on} aria-label={row.label} tabIndex={on || (!parts && index === 0) ? 0 : -1} aria-disabled={save.isPending} onClick={() => choose({ ...selected, character: row.id })} onKeyDown={event => keyboard(event, index, "character")} className={cx("flex min-w-0 flex-col items-center gap-1.5 rounded-lg border px-1 py-2 text-[11px] leading-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-disabled:cursor-wait", on ? "border-accent bg-accent/10" : "border-transparent hover:bg-hover")}>
              <PersonaAvatar id={avatarId({ ...selected, character: row.id })} size={48} />
              <span className="max-w-full text-center">{row.label}</span>
            </button>;
          })}
        </div>
      </div>
      <div className="mt-5">
        <div id="avatar-color-label" className="mb-2 text-[12.5px] text-muted">Color</div>
        <div ref={colors} role="radiogroup" aria-labelledby="avatar-color-label" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {AVATAR_PALETTES.map((row, index) => {
            const on = selected.palette === row.id;
            return <button key={row.id} type="button" role="radio" aria-checked={on} aria-label={row.label} tabIndex={on ? 0 : -1} aria-disabled={save.isPending} onClick={() => choose({ ...selected, palette: row.id })} onKeyDown={event => keyboard(event, index, "palette")} className={cx("flex min-w-0 items-center gap-2 rounded-md border px-2 py-2 text-left text-[11.5px] leading-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-disabled:cursor-wait", on ? "border-accent bg-accent/10" : "border-line hover:bg-hover")}>
              <span className="flex shrink-0 items-center -space-x-0.5" aria-hidden><span className="size-3 rounded-full" style={{ background: row.ink }} /><span className="size-2.5 rounded-full" style={{ background: row.related }} /><span className="size-2 rounded-full" style={{ background: row.accent }} /></span>
              <span>{row.label}</span>
            </button>;
          })}
        </div>
      </div>
      <div className="mt-3 border-t border-line">
        <SettingRow title="Scenery" info="A quiet pixel landscape behind your character. Plain keeps just the character. The background stays clear of the character’s silhouette gaps.">
          <select className="field w-32" aria-label="Avatar scenery" value={selected.scenery} disabled={save.isPending} onChange={event => choose({ ...selected, scenery: event.target.value as AvatarParts["scenery"] })}>
            {AVATAR_SCENERIES.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
          </select>
        </SettingRow>
      </div>
    </>}
  </SectionCard>;
}
