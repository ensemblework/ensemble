import "../../components/ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { parsePptx, type PptxShape } from "./pptx.js";

Object.defineProperty(globalThis, "DOMParser", { configurable: true, value: window.DOMParser });

const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (items: Array<[string, string, string]>) =>
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`)
    .join("")}</Relationships>`;

const xfrm = (x: number, y: number, cx: number, cy: number) => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
const ph = (type: string, idx?: number) => `<p:nvSpPr><p:cNvPr id="2" name="${type}"/><p:cNvSpPr/><p:nvPr><p:ph type="${type}"${idx === undefined ? "" : ` idx="${idx}"`}/></p:nvPr></p:nvSpPr>`;
const plain = (name: string) => `<p:nvSpPr><p:cNvPr id="3" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`;

const THEME = `<?xml version="1.0"?><a:theme ${P} name="Office"><a:themeElements><a:clrScheme name="Office">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
</a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;

const MASTER = `<?xml version="1.0"?><p:sldMaster ${P}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>
<p:sp>${ph("title")}<p:spPr>${xfrm(1, 1, 100, 100)}</p:spPr><p:txBody><a:bodyPr anchor="b"/><a:p><a:r><a:t>Click to edit title</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp>${plain("Accent bar")}<p:spPr>${xfrm(0, 6400000, 12192000, 458000)}<a:prstGeom prst="rect"/><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr></p:sp>
</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2"/>
<p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>
<p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600"><a:buFont typeface="Arial"/><a:buChar char="•"/><a:defRPr sz="2800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:bodyStyle>
<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;

const LAYOUT = `<?xml version="1.0"?><p:sldLayout ${P}><p:cSld><p:spTree>
<p:sp>${ph("title")}<p:spPr>${xfrm(838200, 365125, 10515600, 1325563)}</p:spPr></p:sp>
<p:sp>${ph("body", 1)}<p:spPr>${xfrm(838200, 1825625, 10515600, 4351338)}</p:spPr></p:sp>
</p:spTree></p:cSld></p:sldLayout>`;

const SLIDE_TEXT = `<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree>
<p:sp>${ph("title")}<p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US"/><a:t>Quarterly review</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp>${ph("body", 1)}<p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>First point</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp>${plain("Note")}<p:spPr>${xfrm(952500, 952500, 3000000, 600000)}</p:spPr><p:txBody><a:bodyPr/><a:p><a:pPr algn="ctr"/>
<a:r><a:rPr sz="2400" b="1"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr><a:t>Red bold</a:t></a:r>
<a:r><a:rPr i="1" u="sng"><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="75000"/></a:schemeClr></a:solidFill></a:rPr><a:t> and darker blue</a:t></a:r></a:p></p:txBody></p:sp>
<p:pic><p:nvPicPr><p:cNvPr id="5" name="Logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr>${xfrm(9525 * 10, 9525 * 20, 9525 * 30, 9525 * 40)}</p:spPr></p:pic>
<p:pic><p:nvPicPr><p:cNvPr id="6" name="Remote"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:link="rId3"/></p:blipFill><p:spPr>${xfrm(0, 0, 9525, 9525)}</p:spPr></p:pic>
</p:spTree></p:cSld></p:sld>`;

const SLIDE_GROUP = `<?xml version="1.0"?><p:sld ${P} showMasterSp="0"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:bgPr></p:bg><p:spTree>
<p:grpSp><p:nvGrpSpPr><p:cNvPr id="7" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="2000000"/><a:chOff x="0" y="0"/><a:chExt cx="1000000" cy="1000000"/></a:xfrm></p:grpSpPr>
<p:sp>${plain("Inner")}<p:spPr>${xfrm(100000, 100000, 100000, 100000)}<a:prstGeom prst="ellipse"/><a:solidFill><a:schemeClr val="accent2"/></a:solidFill></p:spPr></p:sp>
</p:grpSp>
<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="8" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId2"/></a:graphicData></a:graphic></p:graphicFrame>
<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid><a:gridCol w="476250"/><a:gridCol w="476250"/></a:tblGrid>
<a:tr h="370840"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Name</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Score</a:t></a:r></a:p></a:txBody><a:tcPr><a:solidFill><a:srgbClr val="EEEEEE"/></a:solidFill></a:tcPr></a:tc></a:tr>
</a:tbl></a:graphicData></a:graphic></p:graphicFrame>
</p:spTree></p:cSld></p:sld>`;

const CHART = `<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ${P}><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Sales by region</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:layout/><c:barChart/></c:plotArea></c:chart></c:chartSpace>`;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function deck(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    "_rels/.rels": strToU8(rels([["rId1", "officeDocument", "ppt/presentation.xml"]])),
    "ppt/presentation.xml": strToU8(
      `<?xml version="1.0"?><p:presentation ${P}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:defaultTextStyle><a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:defaultTextStyle></p:presentation>`,
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      rels([
        ["rId1", "slideMaster", "slideMasters/slideMaster1.xml"],
        ["rId2", "slide", "slides/slide1.xml"],
        ["rId3", "slide", "slides/slide2.xml"],
        ["rId4", "theme", "theme/theme1.xml"],
      ]),
    ),
    "ppt/theme/theme1.xml": strToU8(THEME),
    "ppt/slideMasters/slideMaster1.xml": strToU8(MASTER),
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": strToU8(rels([["rId1", "theme", "../theme/theme1.xml"]])),
    "ppt/slideLayouts/slideLayout1.xml": strToU8(LAYOUT),
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": strToU8(rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]])),
    "ppt/slides/slide1.xml": strToU8(SLIDE_TEXT),
    "ppt/slides/_rels/slide1.xml.rels": strToU8(
      rels([
        ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
        ["rId2", "image", "../media/image1.png"],
      ]).replace("</Relationships>", `<Relationship Id="rId3" Type="${REL}/image" Target="https://example.com/tracker.png" TargetMode="External"/></Relationships>`),
    ),
    "ppt/slides/slide2.xml": strToU8(SLIDE_GROUP),
    "ppt/slides/_rels/slide2.xml.rels": strToU8(
      rels([
        ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
        ["rId2", "chart", "../charts/chart1.xml"],
      ]),
    ),
    "ppt/charts/chart1.xml": strToU8(CHART),
    "ppt/media/image1.png": PNG,
  });
}

const byName = (shapes: PptxShape[], name: string) => shapes.find((shape) => shape.name === name);

test("reads the slide size and keeps the presentation's slide order", () => {
  const parsed = parsePptx(deck());
  assert.equal(parsed.width, 1280);
  assert.equal(parsed.height, 720);
  assert.equal(parsed.slides.length, 2);
  assert.ok(byName(parsed.slides[0]!.shapes, "Inner"), "slide2.xml comes first because the slide list says so");
  assert.deepEqual(parsed.slides.map((slide) => slide.number), [1, 2]);
});

test("text runs keep size, weight, colour (theme colours included) and alignment", () => {
  const slide = parsePptx(deck()).slides[1]!;
  const note = byName(slide.shapes, "Note");
  assert.equal(note?.kind, "shape");
  if (note?.kind !== "shape") return;
  const paragraph = note.text!.paragraphs[0]!;
  assert.equal(paragraph.align, "center");
  const [red, blue] = paragraph.runs;
  assert.equal(red!.text, "Red bold");
  assert.equal(red!.color, "#ff0000");
  assert.equal(red!.bold, true);
  assert.equal(Math.round(red!.size), 32, "24pt is 32px");
  assert.equal(blue!.italic, true);
  assert.equal(blue!.underline, true);
  assert.match(blue!.color!, /^#2f55/, "accent1 with lumMod 75% is the darker theme blue");
  assert.equal(blue!.font, "Calibri", "runs without a font use the theme's body font");
});

test("a placeholder without a position takes the layout's, and its text the master's style", () => {
  const slide = parsePptx(deck()).slides[1]!;
  const title = slide.shapes.find((shape) => shape.kind === "shape" && shape.text?.paragraphs[0]?.runs[0]?.text === "Quarterly review");
  assert.ok(title && title.kind === "shape");
  assert.equal(Math.round(title.box.x), 88);
  assert.equal(Math.round(title.box.y), 38);
  assert.equal(Math.round(title.box.w), 1104);
  const run = title.text!.paragraphs[0]!.runs[0]!;
  assert.equal(Math.round(run.size), 59, "44pt from the master's title style");
  assert.equal(run.color, "#44546a", "tx2 maps to dk2");
  assert.equal(run.font, "Calibri Light");
  assert.equal(title.text!.anchor, "bottom", "the master's title anchors to the bottom");
  const body = slide.shapes.find((shape) => shape.kind === "shape" && shape.text?.paragraphs[0]?.runs[0]?.text === "First point");
  assert.ok(body && body.kind === "shape");
  assert.equal(body.text!.paragraphs[0]!.bullet?.text, "•");
  assert.equal(Math.round(body.box.y), 192);
});

test("pictures come from the slide's relationships; linked pictures are never fetched", () => {
  const parsed = parsePptx(deck());
  const logo = byName(parsed.slides[1]!.shapes, "Logo");
  assert.deepEqual(logo, { kind: "image", name: "Logo", box: { x: 10, y: 20, w: 30, h: 40 }, media: "ppt/media/image1.png" });
  assert.equal(parsed.media["ppt/media/image1.png"]?.mime, "image/png");
  assert.deepEqual([...parsed.media["ppt/media/image1.png"]!.bytes], [...PNG]);
  const remote = byName(parsed.slides[1]!.shapes, "Remote");
  assert.equal(remote?.kind, "placeholder");
  assert.equal(Object.keys(parsed.media).length, 1);
});

test("master shapes sit behind the slide, master placeholders are left out, and backgrounds resolve", () => {
  const parsed = parsePptx(deck());
  const withMaster = parsed.slides[1]!;
  assert.equal(withMaster.shapes[0]?.name, "Accent bar");
  assert.equal(withMaster.shapes[0]?.kind === "shape" ? withMaster.shapes[0].fill?.color : null, "#4472c4");
  assert.ok(!withMaster.shapes.some((shape) => shape.kind === "shape" && shape.text?.paragraphs[0]?.runs[0]?.text === "Click to edit title"));
  assert.deepEqual(withMaster.background, { color: "#ffffff" });
  const own = parsed.slides[0]!;
  assert.ok(!byName(own.shapes, "Accent bar"), "showMasterSp=0 hides master shapes");
  assert.deepEqual(own.background, { color: "#112233" });
});

test("group children are placed through the group's transform; charts and tables are readable", () => {
  const slide = parsePptx(deck()).slides[0]!;
  const inner = byName(slide.shapes, "Inner");
  assert.ok(inner && inner.kind === "shape");
  assert.equal(inner.geometry, "ellipse");
  assert.equal(inner.box.x.toFixed(2), (200000 / 9525).toFixed(2));
  assert.equal(inner.box.w.toFixed(2), (200000 / 9525).toFixed(2));
  assert.equal(inner.fill?.color, "#ed7d31");
  const chart = byName(slide.shapes, "Chart");
  assert.deepEqual(chart && chart.kind === "placeholder" ? chart.label : null, "Bar chart: Sales by region");
  const table = byName(slide.shapes, "Table");
  assert.ok(table && table.kind === "table");
  assert.equal(table.headerRow, true);
  assert.deepEqual(table.columns, [50, 50]);
  assert.equal(table.rows[0]!.cells[1]!.fill, "#eeeeee");
  assert.equal(table.rows[0]!.cells[0]!.text.paragraphs[0]!.runs[0]!.text, "Name");
});

test("a file that is not a presentation gets a plain error", () => {
  assert.throws(() => parsePptx(new Uint8Array([1, 2, 3])), /not a PowerPoint presentation/);
  assert.throws(() => parsePptx(zipSync({ "hello.txt": strToU8("hi") })), /not a PowerPoint presentation/);
});
