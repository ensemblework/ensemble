import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React,{act} from "react";
import {createRoot} from "react-dom/client";
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
