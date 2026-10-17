"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import type { GraphNode, GraphEdge } from "@/lib/api";
export function MobileGraph({ nodes, edges, onOpen }: { nodes: GraphNode[]; edges: GraphEdge[]; onOpen: (node: GraphNode) => void }) {
  const [query,setQuery]=useState(""); const [focus,setFocus]=useState<string|null>(null);
  const selected=nodes.find(row=>row.id===focus);
  const neighbors=new Set(edges.flatMap(edge=>edge.source===focus?[edge.target]:edge.target===focus?[edge.source]:[]));
  const shown=nodes.filter(row=>(!focus||neighbors.has(row.id))&&`${row.label} ${row.sub} ${row.kind}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="space-y-3 sm:hidden" aria-label="Connections list"><label className="flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2"><Search size={16} className="text-muted"/><input className="min-w-0 flex-1 bg-transparent text-[14px] outline-none" placeholder="Find people or work…" aria-label="Search graph" value={query} onChange={e=>setQuery(e.target.value)}/></label>{selected&&<div className="rounded-xl border border-accent bg-accent-soft p-4"><button className="mb-2 text-[12px] text-accent" onClick={()=>setFocus(null)}>All connections</button><h3 className="font-semibold">{selected.label}</h3><p className="mt-1 text-[12px] text-muted">{selected.sub}</p><button className="btn mt-3" onClick={()=>onOpen(selected)}>Open {selected.label}</button><p className="mt-3 text-[12px] text-muted">{neighbors.size} linked items</p></div>}<div className="divide-y divide-line rounded-xl border border-line bg-panel">{shown.slice(0,100).map(node=><button key={node.id} className="flex w-full items-center gap-3 px-4 py-3 text-left" onClick={()=>setFocus(node.id)}><span className="min-w-0 flex-1"><strong className="block break-words text-[14px]">{node.label}</strong><span className="mt-1 block text-[12px] text-muted">{node.sub||node.kind} · {edges.filter(e=>e.source===node.id||e.target===node.id).length} links</span></span><ChevronRight size={16} className="shrink-0 text-muted"/></button>)}{!shown.length&&<p className="p-5 text-[13px] text-muted">{focus?"No linked items yet. Add people or work to a project to connect them.":"Add people, projects or tasks to start exploring your connections."}</p>}</div>{shown.length>100&&<p className="text-[12px] text-muted">Showing 100 items. Search to narrow the list.</p>}</section>;
}
