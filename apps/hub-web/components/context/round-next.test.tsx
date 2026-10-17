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
test("the phone graph expands one item into readable linked items",async()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host);let opened="";
 const nodes=[{id:"p",kind:"project",label:"Release",sub:"Project"},{id:"m",kind:"people",label:"Mira Chen",sub:"Designer"},{id:"other",kind:"people",label:"Sam Rivera",sub:"Unlinked"}];
 await act(async()=>root.render(<MobileGraph nodes={nodes} edges={[{source:"p",target:"m",kind:"member"}]} onOpen={node=>{opened=node.id;}}/>));
 const release=[...host.querySelectorAll("button")].find(button=>button.textContent?.includes("Release"))!;await act(async()=>release.click());
 assert.match(host.textContent??"",/Mira Chen/);assert.doesNotMatch(host.textContent??"",/Sam Rivera/);assert.match(host.textContent??"",/1 linked items/);
 const open=[...host.querySelectorAll("button")].find(button=>button.textContent==="Open Release")!;await act(async()=>open.click());assert.equal(opened,"p");await act(async()=>root.unmount());host.remove();
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
  const inputs=dialog.querySelectorAll("input");await act(async()=>{for(const [field,value] of [[inputs[0],"Draft the methods chapter"],[inputs[1],"2026-11-01"]] as const){Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value")!.set!.call(field,value);field.dispatchEvent(new Event("input",{bubbles:true}));}});
  await act(async()=>{dialog.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));await new Promise(resolve=>setTimeout(resolve,30));});
  assert.equal((saved as Record<string,unknown>|null)?.taskType,"assignment");assert.equal((saved as Record<string,unknown>|null)?.title,"Draft the methods chapter");assert.equal(new Date(String((saved as Record<string,unknown>|null)?.due)).getHours(),17);
 }finally{await act(async()=>root.unmount());host.remove();client.clear();globalThis.fetch=original;}
});
