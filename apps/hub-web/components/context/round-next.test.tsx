import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React,{act} from "react";
import {createRoot} from "react-dom/client";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {AssignmentsPanel} from "../desk/context-customize";
import {MobileGraph} from "./mobile-graph";
import {AskLauncher} from "../assistant/ask-launcher";
import {Dialog} from "../ui";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { GraphTab } from "./graph";
(globalThis as { React?: typeof React }).React = React;
test("the phone graph expands one item into readable linked items",async()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host);let opened="";
 const nodes=[{id:"p",kind:"project",label:"Release",sub:"Project"},{id:"m",kind:"people",label:"Mira Chen",sub:"Designer"},{id:"other",kind:"people",label:"Sam Rivera",sub:"Unlinked"}];
 await act(async()=>root.render(<MobileGraph nodes={nodes} edges={[{source:"p",target:"m",kind:"member"}]} onOpen={node=>{opened=node.id;}}/>));
 const release=[...host.querySelectorAll("button")].find(button=>button.textContent?.includes("Release"))!;await act(async()=>release.click());
 assert.match(host.textContent??"",/Mira Chen/);assert.doesNotMatch(host.textContent??"",/Sam Rivera/);assert.match(host.textContent??"",/1 linked item(?!s)/);assert.doesNotMatch(host.textContent??"",/1 links/);
 const open=[...host.querySelectorAll("button")].find(button=>button.textContent==="Open Release")!;await act(async()=>open.click());assert.equal(opened,"p");await act(async()=>root.unmount());host.remove();
});

test("wheel scrolling in graph details is native while scrolling the canvas still zooms", async () => {
 const oldFetch = globalThis.fetch;
 const oldObserver = globalThis.ResizeObserver;
 const getContext = Object.getOwnPropertyDescriptor(window.HTMLCanvasElement.prototype, "getContext")!;
 Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => null });
 globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
 globalThis.fetch = async () => Response.json({ error: "No linked records" }, { status: 404 });
 const nodes = [{ id: "project-one", kind: "project", label: "Launch", sub: "Project" }];
 const extras: typeof nodes = [];
 const services: [] = [];
 const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
 client.setQueryData(["graph", false], { nodes, edges: [] });
 client.setQueryData(["shell"], { modules: "all" });
 const router = { push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {} };
 const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
 try {
  await act(async () => root.render(<AppRouterContext.Provider value={router}><QueryClientProvider client={client}><GraphTab contextNodes={extras} mockServices={services} /></QueryClientProvider></AppRouterContext.Provider>));
  const find = host.querySelector<HTMLInputElement>('[aria-label="Find in graph"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(find, "Launch"); find.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => find.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  const panel = host.querySelector('[data-graph-panel] [aria-label="Linked records"]');
  assert.ok(panel);
  const scroll = new window.WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
  await act(async () => panel.dispatchEvent(scroll));
  assert.equal(scroll.defaultPrevented, false, "details keep native scrolling instead of graph zoom");
  const zoom = new window.WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
  await act(async () => host.querySelector("canvas")!.dispatchEvent(zoom));
  assert.equal(zoom.defaultPrevented, true, "the canvas still owns its zoom gesture");
 } finally {
  await act(async () => root.unmount()); host.remove(); client.clear();
  globalThis.fetch = oldFetch; globalThis.ResizeObserver = oldObserver;
  Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", getContext);
 }
});
test("the assistant launcher stays interactive while another dialog makes the background inert",async()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host);let opened=0;
 await act(async()=>root.render(<><button data-background>Background</button><AskLauncher title="Ask Ensemble" onOpen={()=>{opened++;}}/><Dialog open title="Run details" onClose={()=>{}}><button>Close run</button></Dialog></>));
 const launcher=document.querySelector<HTMLButtonElement>('[aria-label="Ask Ensemble"]')!;assert.ok(launcher);assert.equal(launcher.closest('[inert]'),null);assert.equal(host.inert,true);
 await act(async()=>launcher.click());assert.equal(opened,1);await act(async()=>root.unmount());host.remove();
});

test("an assignment added from Context is saved as coursework on the board",async()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host);const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity},mutations:{gcTime:Infinity}}});const original=globalThis.fetch;let saved:Record<string,unknown>|null=null;
 globalThis.fetch=async(_input,init)=>{saved=JSON.parse(String(init?.body));return Response.json({task:{id:"assignment-1"}});};
 try {
  await act(async()=>root.render(<QueryClientProvider client={client}><AssignmentsPanel rows={[]}/></QueryClientProvider>));
  await act(async()=>host.querySelector("button")!.click());const dialog=document.querySelector<HTMLElement>('[role="dialog"]')!;
  const title=dialog.querySelector("input")!;
  await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value")!.set!.call(title,"Draft the methods chapter");title.dispatchEvent(new Event("input",{bubbles:true}));});
  await act(async()=>dialog.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!.click());
  const date=document.querySelector<HTMLInputElement>('.dp-type input') ?? document.querySelector<HTMLInputElement>('input[placeholder="Type: tomorrow, fri, 14 nov…"]');
  assert.ok(date);
  await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value")!.set!.call(date,"2026-11-01");date.dispatchEvent(new Event("input",{bubbles:true}));});
  await act(async()=>date.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true})));
  await act(async()=>{dialog.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));await new Promise(resolve=>setTimeout(resolve,30));});
  assert.equal((saved as Record<string,unknown>|null)?.taskType,"assignment");assert.equal((saved as Record<string,unknown>|null)?.title,"Draft the methods chapter");assert.equal(new Date(String((saved as Record<string,unknown>|null)?.due)).getHours(),17);
 }finally{await act(async()=>root.unmount());host.remove();client.clear();globalThis.fetch=original;}
});
