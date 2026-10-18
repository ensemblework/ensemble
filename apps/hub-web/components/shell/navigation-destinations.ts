import { CONNECTOR_CATALOG, CONNECTOR_CATEGORIES } from "@ensemble/shared-types";
import { hasModule, moduleFitsProfile, moduleForPath } from "@ensemble/shared-types/modules";
import { contextTabs, tabKey } from "../desk/context-tabs";
import { deskIdFromTemplate } from "../desk/desks";
import { SETTINGS_TABS } from "../settings/url-state";
import { SETTINGS_DESTINATIONS, settingsDestinationHref } from "../settings/navigation";

export type NavigationDestination = { href:string; label:string; hint:string; keywords?:string; ownerOnly?:boolean };
const VIEWS: NavigationDestination[] = [
  {href:"/today",label:"Today",hint:"Your day",keywords:"focus daily dashboard tiles" ,ownerOnly:true},
  {href:"/board",label:"Board",hint:"Tasks › Kanban",keywords:"todo tasks status workflow columns"},
  {href:"/needs-me",label:"Needs me",hint:"Approvals & questions",keywords:"blocked waiting review permissions agent requests"},
  {href:"/meetings",label:"Meeting notes",hint:"Conversations & recaps",keywords:"meetings notes meeting library"},
  {href:"/recap",label:"Weekly recap",hint:"Done, decided, slipped",keywords:"week summary progress"},
  {href:"/runs",label:"Runs",hint:"Agent history",keywords:"what the agent did execution jobs"},
  {href:"/context",label:"Context",hint:"People, projects & graph",keywords:"knowledge connected data"},
  {href:"/skills",label:"Skills",hint:"Saved instructions",keywords:"agent conventions how to work"},
  {href:"/workspace",label:"Workspace",hint:"Agent queue",keywords:"jobs agent tasks queue"},
  {href:"/code",label:"Code",hint:"Reviews & repositories",keywords:"git review diffs uncommitted changes"},
  {href:"/code#local-repositories",label:"Local repositories",hint:"Code › Local repositories",keywords:"local repos git checkouts folders"},
  {href:"/code#reviews",label:"Code reviews",hint:"Code › Agent changes",keywords:"diff review accept reject agent changes"},
  {href:"/diagrams",label:"Diagrams",hint:"Block diagrams & flows",keywords:"diagram flowchart systems graph drawing"},
  {href:"/plots",label:"Plots",hint:"Charts & data",keywords:"plot chart visualization table datasets figures"},
  {href:"/files",label:"Files",hint:"Uploads & previews",keywords:"documents pdf word excel spreadsheet csv powerpoint slides pictures images uploads attachments"},
  {href:"/files?view=apps",label:"From your apps",hint:"Files › From your apps",keywords:"artifacts synced mail email calendar events messages chats docs pull requests issues transcripts connected apps"},
  {href:"/metrics",label:"Metrics",hint:"Calls & cost",keywords:"usage credits spending tokens audit ledger",ownerOnly:true},
  {href:"/connect",label:"Editors",hint:"Connect an editor or AI app",keywords:"vscode cursor claude codex mcp",ownerOnly:true},
  {href:"/settings",label:"Settings",hint:"Account & preferences",keywords:"configuration options settings"},
  {href:"/shared",label:"Shared with you",hint:"Shared pages & workspaces",keywords:"shared invitations collaboration"},
];

const normalize = (text:string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/colour/g,"color").replace(/[^\p{L}\p{N}]+/gu," ").trim();
export function navigationScore(query:string, label:string, hint:string, keywords=""): number {
  const needle=normalize(query); if (!needle) return 1;
  const name=normalize(label), trail=normalize(hint), words=needle.split(" ");
  const tokens=`${name} ${trail} ${normalize(keywords)}`.split(" ");
  if (!words.every(word=>tokens.some(token=>token.startsWith(word)))) return 0;
  return name===needle ? 100 : name.startsWith(needle) ? 80 : name.includes(needle) ? 60 : words.every(word=>name.includes(word)) ? 50 : 20;
}

export function navigationDestinations(query:string, options:{modules?:string|null; guest?:boolean; template?:string|null; boardLabel?:string; profile?:string|null}): NavigationDestination[] {
  const desk=deskIdFromTemplate(options.template) ?? "default";
  const contextual=contextTabs(desk).map(label=>({href:`/context?tab=${tabKey(label)}`,label,hint:`Context › ${label}`,keywords:label==="People"?"contacts team directory":label==="Graph"?"relationships knowledge graph network":""}));
  const sections=SETTINGS_TABS.map(tab=>({href:`/settings?tab=${tab.id}`,label:tab.label,hint:`Settings › ${tab.label}`,keywords:tab.hint,ownerOnly:tab.id==="connections"||tab.id==="data"}));
  const settings=SETTINGS_DESTINATIONS.map(row=>({href:settingsDestinationHref(row),label:row.label,hint:`Settings › ${SETTINGS_TABS.find(tab=>tab.id===row.tab)!.label}${row.heading === SETTINGS_TABS.find(tab=>tab.id===row.tab)!.label ? "" : ` › ${row.heading ?? row.section.replace(/-/g," ")}`}`,keywords:row.keywords,ownerOnly:row.ownerOnly}));
  const connectors: NavigationDestination[] = CONNECTOR_CATALOG.flatMap(entry=>[
    {href:`/settings?tab=connections&connector=${entry.id}`,label:entry.name,hint:`Settings › Connections › ${entry.name}`,keywords:`${entry.vendor} ${entry.tagline} ${entry.reads.join(" ")} ${entry.writes.join(" ")}`,ownerOnly:true},
    ...(entry.products??[]).map(product=>({href:`/settings?tab=connections&connector=${entry.id}`,label:product.name,hint:`Settings › Connections › ${entry.name}`,keywords:`${entry.name} ${product.access} integration products`,ownerOnly:true})),
  ]);
  const categories: NavigationDestination[] = CONNECTOR_CATEGORIES.map(category=>({href:`/settings?tab=connections&store=${category.id}`,label:category.label,hint:"Settings › Connections › Browse connectors",keywords:`apps integrations ${category.label}`,ownerOnly:true}));
  const all: NavigationDestination[]=[...VIEWS,...(query.trim()?contextual:[]),...(query.trim()?sections:[]),...(query.trim()?settings:[]),...(query.trim()?connectors:[]),...(query.trim()?categories:[])];
  const seen=new Set<string>();
  return all.filter(row=>{
    if (options.guest&&row.ownerOnly) return false;
    const gate=moduleForPath(row.href); if (gate&&(!hasModule(options.modules,gate)||!moduleFitsProfile(gate,options.profile))) return false;
    const key=`${row.href}:${row.label}`; if (seen.has(key)) return false; seen.add(key); return true;
  }).map(row=>row.href==="/board"&&options.boardLabel?{...row,label:options.boardLabel,keywords:`board ${row.keywords}`}:row).map(row=>({row,score:navigationScore(query,row.label,row.hint,row.keywords)})).filter(hit=>hit.score>0).sort((a,b)=>b.score-a.score).map(hit=>hit.row).filter((row,i,list)=>list.findIndex(other=>other.href===row.href)===i);
}
