import { createRoot } from "react-dom/client";
import "./styles.css";
import { deskById, DESKS } from "./desks/registry";
import { TodayPage, TodayMobile } from "./desks/today";
import { NewUserToday } from "./pages/newuser";
import { StatesSheet } from "./pages/states";
import { KitSheet } from "./pages/kit";
import { ContextChambers, ContextLiterature } from "./pages/context";
import { Gallery, GalleryMobile, Detail, Apply } from "./pages/market";
import { Compare } from "./pages/compare";
import { PlotsGallery, PlotsTileSettings } from "./pages/plots";

const q = new URLSearchParams(location.search);
const p = q.get("p") ?? "index";
const d = q.get("d") ?? "chambers";
const m = q.get("m") === "1";

function Index() {
  const links = [
    ["Kit sheet", "p=kit"], ["States sheet", "p=states"],
    ...DESKS.map((x) => [`Today · ${x.name}`, `p=today&d=${x.id}`]),
    ["New user · Chambers", "p=new&d=chambers"], ["New user · Semester", "p=new&d=semester"],
    ["Context · Chambers", "p=context&d=chambers"], ["Context · Literature", "p=context&d=literature"],
    ["Gallery", "p=gallery"], ["Detail · Chambers", "p=detail"], ["Apply · rearranging", "p=apply&phase=1"], ["Apply · toast", "p=apply&phase=2"],
    ["Plots · widget gallery", "p=plots-gallery"], ["Plots · tile settings", "p=plots-settings"],
  ];
  return (
    <div className="sheet">
      <h1 className="display">Ensemble desk mockups</h1>
      <div className="col gap8" style={{ marginTop: 20 }}>{links.map(([l, h]) => <a key={h} href={`?${h}`} style={{ color: "var(--ink)" }}>{l}</a>)}</div>
    </div>
  );
}

function App() {
  const desk = deskById(d);
  switch (p) {
    case "today": return m ? <TodayMobile desk={desk} /> : <TodayPage desk={desk} />;
    case "new": return <NewUserToday desk={desk} />;
    case "states": return <StatesSheet />;
    case "kit": return <KitSheet />;
    case "context": return d === "literature" ? <ContextLiterature desk={desk} /> : <ContextChambers desk={desk} />;
    case "gallery": return m ? <GalleryMobile /> : <Gallery />;
    case "detail": return <Detail />;
    case "compare": return <Compare />;
    case "plots-gallery": return <PlotsGallery />;
    case "plots-settings": return <PlotsTileSettings />;
    case "apply": return <Apply phase={q.get("phase") === "2" ? 2 : 1} />;
    default: return <Index />;
  }
}
createRoot(document.getElementById("root")!).render(<App />);
