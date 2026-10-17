import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createHttpHarness } from "./http.js";
const h=await createHttpHarness(); after(()=>h.close());
const { upsertPerson }=await import("../connectors/ingest.js");
const { saveSettings,loadSettings }=await import("../lib/settings.js");
const originalFetch=globalThis.fetch; after(()=>{globalThis.fetch=originalFetch;});

test("manual contact sync reads headers only, filters non-people, persists no artifacts, and never calls a model",async()=>{
 const user=await h.asUser(); await saveSettings(h.prisma,user.id,{connections:{gmail:{enabled:true}}});
 const { saveAccount }=await import("../connectors/accounts.js");
 await saveAccount(user.id,"google",{accessToken:"fixture-token",account:"me@example.test",scopes:["https://www.googleapis.com/auth/gmail.readonly"]});
 const addresses=["Mira Chen <mira@fieldnote.example>","News <news@insideapple.com>","Store <orders@amazon.in>","Mira C <mira@fieldnote.example>"];
 const calls:string[]=[];
 globalThis.fetch=async(input,init)=>{const url=String(input);calls.push(url);assert.ok(url.startsWith("https://gmail.googleapis.com/"),url);const path=new URL(url);if(path.pathname.endsWith("/messages"))return Response.json({messages:addresses.map((_,i)=>({id:String(i)}))});assert.equal(path.searchParams.get("format"),"metadata");return Response.json({internalDate:String(Date.now()),payload:{headers:[{name:"From",value:addresses[Number(path.pathname.split('/').at(-1))]}]}});};
 const sync=await user.inject({method:"POST",url:"/api/connections/gmail/sync"}); assert.equal(sync.statusCode,200,sync.body);
 assert.equal(await h.prisma.artifact.count({where:{userId:user.id}}),0);
 const people=await h.prisma.person.findMany({where:{userId:user.id,deletedAt:null}});assert.equal(people.length,1);assert.equal(people[0].email,"mira@fieldnote.example");
 await h.prisma.person.update({where:{id:people[0].id},data:{deletedAt:new Date()}});
 await user.inject({method:"POST",url:"/api/connections/gmail/sync"});assert.equal(await h.prisma.person.count({where:{userId:user.id,deletedAt:null}}),0);
 globalThis.fetch=originalFetch;
});

test("people match exact addresses and keep ambiguous names separate",async()=>{
 const user=await h.asUser();const one=await upsertPerson(user.id,{email:"mira@fieldnote.example",name:"Mira Chen",at:new Date(),evidence:"gmail:contact"},[]);
 assert.equal(await upsertPerson(user.id,{email:"MIRA@fieldnote.example",name:"Mira",at:new Date(),evidence:"outlook:contact"},[]),one);
 const other=await upsertPerson(user.id,{email:"other@fieldnote.example",name:"Mira Chen",at:new Date(),evidence:"gmail:contact"},[]);assert.notEqual(other,one);
});

test("old settings detect the time zone automatically while an explicit manual choice is kept",async()=>{
 const user=await h.asUser();await h.prisma.preference.create({data:{userId:user.id,key:"hub.settings",value:{timezone:"UTC"}}});
 assert.equal((await loadSettings(h.prisma,user.id)).timezoneMode,"auto");await saveSettings(h.prisma,user.id,{timezone:"Asia/Kolkata",timezoneMode:"manual"});assert.equal((await loadSettings(h.prisma,user.id)).timezoneMode,"manual");
});

test("finished runs accept feedback tags without starting work; running and other users' runs refuse it",async()=>{
 const user=await h.asUser(),other=await h.asUser();const task=await h.prisma.task.create({data:{userId:user.id,title:"Prepare a project outline",description:"Outline the milestones",owner:"me",status:"todo"}});
 const run=await h.prisma.run.create({data:{userId:user.id,taskId:task.id,worker:"research",endedAt:new Date(),outcome:"success",result:"Outline"}});
 const input={id:randomUUID(),text:"Add dates to each milestone",start:false};
 assert.equal((await user.inject({method:"POST",url:`/api/runs/${run.id}/feedback`,payload:{text:"",start:false}})).statusCode,400);
 assert.equal((await user.inject({method:"POST",url:`/api/runs/${randomUUID()}/feedback`,payload:input})).statusCode,404);
 const tagged=await user.inject({method:"POST",url:`/api/runs/${run.id}/feedback`,payload:input});assert.equal(tagged.statusCode,200,tagged.body);assert.equal(tagged.json().jobId,null);assert.equal(await h.prisma.workspaceJob.count({where:{userId:user.id}}),0);
 assert.equal((await h.prisma.run.findUniqueOrThrow({where:{id:run.id}})).feedback instanceof Array,true);
 assert.equal((await other.inject({method:"POST",url:`/api/runs/${run.id}/feedback`,payload:{...input,id:randomUUID()}})).statusCode,404);
 await h.prisma.run.update({where:{id:run.id},data:{endedAt:null,outcome:null}});
 assert.equal((await user.inject({method:"POST",url:`/api/runs/${run.id}/feedback`,payload:{...input,id:randomUUID()}})).statusCode,409);
});

test("feedback starts an independent job with original instructions and the same computer and limits",async()=>{
 const user=await h.asUser();const pair=await user.inject({method:"POST",url:"/api/devices/pair"});assert.equal(pair.statusCode,201,pair.body);
 const registered=await h.app.inject({method:"POST",url:"/api/devices/register",payload:{code:pair.json().code,name:"Test computer",platform:"macos",capabilities:{}}});assert.equal(registered.statusCode,201,registered.body);
 const deviceId=registered.json().device.id;
 const task=await h.prisma.task.create({data:{userId:user.id,title:"Project outline",description:"Include milestones",owner:"agent",status:"done"}});
 const run=await h.prisma.run.create({data:{userId:user.id,taskId:task.id,worker:"workspace",endedAt:new Date(),outcome:"success"}});
 await h.prisma.workspaceJob.create({data:{userId:user.id,taskId:task.id,runId:run.id,deviceId,kind:"research",status:"succeeded",executionMode:"sandbox",model:"gemini-3.5-flash",provider:"google",instructions:"Use short paragraphs",maxTurns:12,maxMinutes:7,maxToolCalls:15}});
 const payload={id:randomUUID(),text:"Add dates to each milestone",start:true};
 const response=await user.inject({method:"POST",url:`/api/runs/${run.id}/feedback`,payload});assert.equal(response.statusCode,200,response.body);
 const follow=await h.prisma.workspaceJob.findUniqueOrThrow({where:{id:response.json().jobId}});assert.equal(follow.deviceId,deviceId);assert.match(follow.instructions,/Use short paragraphs/);assert.match(follow.instructions,/Add dates to each milestone/);assert.equal(follow.maxTurns,12);assert.equal(follow.maxMinutes,7);assert.equal(follow.maxToolCalls,15);assert.deepEqual((follow.context as Record<string,unknown>).feedbackOnRun,run.id);
 const repeated=await user.inject({method:"POST",url:`/api/runs/${run.id}/feedback`,payload});assert.equal(repeated.json().jobId,follow.id);assert.equal(await h.prisma.workspaceJob.count({where:{userId:user.id}}),2);
 const next=await h.prisma.run.create({data:{userId:user.id,taskId:task.id,worker:"workspace"}});await h.prisma.workspaceJob.update({where:{id:follow.id},data:{runId:next.id}});
 const listed=(await user.inject({method:"GET",url:"/api/runs"})).json().runs;assert.equal(listed.length,2);assert.equal(listed.find((row:{id:string})=>row.id===next.id).sourceRunId,run.id);
});

test("release metadata is public without exposing account data",async()=>{
 const response=await h.app.inject({method:"GET",url:"/api/version"});assert.equal(response.statusCode,200,response.body);assert.match(response.json().version,/^\d+\.\d+\.\d+$/);assert.equal(response.json().releases,null);assert.equal((await h.app.inject({method:"GET",url:"/api/version?updates=invalid"})).statusCode,400);
});

test("upgrade switches saved accounts to automatic time zones once",async()=>{
 const user=await h.asUser();await saveSettings(h.prisma,user.id,{timezone:"UTC",timezoneMode:"manual"});
 const sql=await readFile(new URL("../../prisma/migrations/20261017133500_existing_timezone_auto/migration.sql",import.meta.url),"utf8");await h.prisma.$executeRawUnsafe(sql);
 assert.equal((await loadSettings(h.prisma,user.id)).timezoneMode,"auto");
 await saveSettings(h.prisma,user.id,{timezoneMode:"manual",timezone:"Asia/Kolkata"});assert.equal((await loadSettings(h.prisma,user.id)).timezoneMode,"manual");
});

test("native updater serves only the signed platform package from the desktop release",async()=>{
 globalThis.fetch=async(input)=>{
  const url=String(input);
  if(url.startsWith("https://api.github.com/repos/ensemblework/ensemble/releases"))return Response.json([{tag_name:"cli-v0.5.0"},{tag_name:"desktop-v0.4.0",assets:[{name:"latest.json",browser_download_url:"https://github.com/ensemblework/ensemble/releases/download/desktop-v0.4.0/latest.json"}]}]);
  assert.equal(url,"https://github.com/ensemblework/ensemble/releases/download/desktop-v0.4.0/latest.json");
  return Response.json({version:"0.4.0",platforms:{"darwin-aarch64":{url:"https://github.com/ensemblework/ensemble/releases/download/desktop-v0.4.0/Ensemble_arm64.app.tar.gz",signature:"fixture-signature"}}});
 };
 try {
  const response=await h.app.inject({method:"GET",url:"/api/desktop/update/darwin/aarch64/0.3.8"});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().version,"0.4.0");assert.equal(response.json().signature,"fixture-signature");assert.equal(response.json().platforms,undefined);
  assert.equal((await h.app.inject({method:"GET",url:"/api/desktop/update/darwin/aarch64/0.4.0"})).statusCode,204);
 }finally{globalThis.fetch=originalFetch;}
});

test("a provider-confirmed stable user identity joins multiple addresses without merging names alone",async()=>{
 const user=await h.asUser();const first=await upsertPerson(user.id,{email:"mira@work.example",handle:"slack:UMIRA",name:"Mira Chen",at:new Date(),evidence:"slack:contact"},[]);
 const second=await upsertPerson(user.id,{email:"mira@personal.example",name:"Mira C",at:new Date(),evidence:"gmail:contact"},[]);assert.notEqual(first,second);
 const matched=await upsertPerson(user.id,{email:"mira@personal.example",handle:"slack:UMIRA",name:"Mira Chen",at:new Date(),evidence:"slack:contact"},[]);
 assert.equal(matched,second);assert.equal(await h.prisma.person.count({where:{userId:user.id,deletedAt:null}}),1);
 assert.equal(await upsertPerson(user.id,{email:"mira@work.example",name:"Mira",at:new Date(),evidence:"gmail:contact"},[]),second);
});

test("Context coursework saves a board assignment and appears in the live Context data",async()=>{
 const user=await h.asUser();const response=await user.inject({method:"POST",url:"/api/tasks",payload:{title:"Draft the methods chapter",taskType:"assignment",due:"2026-11-01T11:30:00.000Z",owner:"me",status:"todo",sourceKind:"manual"}});assert.equal(response.statusCode,201,response.body);
 const task=response.json().task;assert.equal(task.taskType,"assignment");
 const live=(await user.inject({method:"GET",url:"/api/desk/live"})).json();assert.ok(live.tasks.some((row:{id:string;taskType:string})=>row.id===task.id&&row.taskType==="assignment"));
});
