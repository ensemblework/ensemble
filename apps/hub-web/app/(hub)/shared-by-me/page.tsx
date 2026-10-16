"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, publicLinkUrl } from "@/lib/api";
import { friendlyDateTime } from "@/lib/format";
import { PageHeader, SectionCard, SkeletonRows } from "@/components/ui";

export default function SharedByMe() {
  const client = useQueryClient();
  const data = useQuery({ queryKey: ["sharing", "overview"], queryFn: api.sharingOverview });
  const links = useQuery({ queryKey: ["public-links"], queryFn: api.publicLinks });
  const [search, setSearch] = useState("");
  const refresh = async () => { await client.invalidateQueries({ queryKey: ["sharing"] }); await client.invalidateQueries({ queryKey: ["public-links"] }); await client.invalidateQueries({ queryKey: ["public-link"] }); };
  const remove = useMutation({ mutationFn: api.removeShare, onSuccess: refresh });
  const removeSpace = useMutation({ mutationFn: ({ spaceId, personId }: { spaceId: string; personId: string }) => api.removeMember(spaceId, personId), onSuccess: refresh });
  const turnOff = useMutation({ mutationFn: api.removePublicLink, onSuccess: refresh });
  if (data.isPending || links.isPending) return <SkeletonRows count={5} />;
  return <div className="mx-auto max-w-[1000px] px-4 pb-20 pt-8 sm:px-8"><PageHeader title="Shared by me" description="See who has access to your work, and turn off links you no longer need." />
    <input className="field mb-6 w-full max-w-sm" aria-label="Search what you shared" placeholder="Find a person or page…" value={search} onChange={event => setSearch(event.target.value)} />
    {data.error || links.error ? <p role="alert" className="mb-4 text-danger">Sharing could not load.<button type="button" className="btn ml-2" onClick={() => { void data.refetch(); void links.refetch(); }}>Retry</button></p> : null}
    {remove.error || turnOff.error || removeSpace.error ? <p role="alert" className="mb-4 text-danger">{remove.error?.message ?? turnOff.error?.message ?? removeSpace.error?.message}</p> : null}
    {data.data && !data.data.items.length && data.data.spaces.every(space => !space.members.length) ? <p className="mb-5 text-[13px] text-muted">You have not shared anything with people yet.</p> : null}
    <div className="space-y-5">{data.data?.contacts.map(person => {
      const rows = data.data.items.filter(item => item.person.id === person.id && `${person.name} ${item.title} ${item.excerpt ?? ""}`.toLowerCase().includes(search.toLowerCase()));
      const spaces = data.data.spaces.filter(space => space.members.some(member => member.id === person.id) && `${person.name} ${space.name}`.toLowerCase().includes(search.toLowerCase()));
      if (!rows.length && !spaces.length) return null;
      return <SectionCard key={person.id} title={person.name} description="Access granted to this person."><ul className="divide-y divide-line">{spaces.map(space => <li key={space.id} className="flex items-center justify-between gap-3 py-3"><span>{space.name}<small className="block text-muted">Whole space</small></span><button type="button" className="btn" disabled={removeSpace.isPending} onClick={() => removeSpace.mutate({ spaceId: space.id, personId: person.id })}>Remove access</button></li>)}{rows.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div className="min-w-0 flex-1"><p className="font-medium">{item.title}</p>{item.excerpt ? <p className="mt-1 line-clamp-2 text-[13px] text-muted">{item.excerpt}</p> : null}<p className="mt-1 text-[11px] text-faint">{item.kind} · Shared {friendlyDateTime(item.createdAt)}</p></div><button type="button" className="btn" disabled={remove.isPending} onClick={() => remove.mutate(item.id)}>Remove</button></li>)}</ul></SectionCard>;
    })}
    <SectionCard title="Public links" description="Anyone with one of these links can open it."><ul className="divide-y divide-line">{links.data?.links.filter(link => link.title.toLowerCase().includes(search.toLowerCase())).map(link => <li key={link.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><a href={publicLinkUrl(link.token)} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 font-medium hover:underline">{link.title}<small className="mt-1 block text-[11px] font-normal text-muted">{link.kind} · Created {friendlyDateTime(link.createdAt)}</small></a><button type="button" className="btn" disabled={turnOff.isPending} onClick={() => turnOff.mutate(link.id)}>Turn off</button></li>)}</ul>{!links.data?.links.length ? <p className="text-[13px] text-muted">No public links.</p> : null}</SectionCard></div>
  </div>;
}
