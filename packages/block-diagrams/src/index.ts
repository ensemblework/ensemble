export {
  COLORS,
  CURVES,
  DIAGRAM_VERSION,
  DIRECTIONS,
  MIN_VIEWPORT,
  PORTS,
  SHAPE_IDS,
  STARTER_SOURCE,
  allIds,
  diagramModelSchema,
  emptyModel,
  lookupId,
  nextEdgeId,
  slugId,
  uniqueId,
} from "./model.js";
export type {
  Curve,
  DiagramEdge,
  DiagramEndpoint,
  DiagramGroup,
  DiagramModel,
  DiagramNode,
  DiagramText,
  Diagnostic,
  DiagnosticFix,
  Direction,
  LayoutBox,
  PaletteColor,
  ParseResult,
  PortName,
  ShapeId,
} from "./model.js";

export {
  DEFAULT_SIZE,
  SHAPE_ALIASES,
  closestPorts,
  labelPadding,
  nodeSize,
  outlineSize,
  resolveColor,
  suggestColor,
  resolvePort,
  resolveShape,
  shapeGeometry,
  shapePath,
  shapePorts,
  textFrame,
  textSize,
  wrapLabel,
} from "./shapes.js";
export type { PlacedShape, Point, Ports, ShapeGeometry, TextFrame } from "./shapes.js";

export { errorCount, parseDiagram } from "./parse.js";
export { scanDiagram, scanLine } from "./highlight.js";
export type { DiagramToken, DiagramTokenKind } from "./highlight.js";
export { printDiagram } from "./print.js";
export { importMermaid, looksLikeMermaid, toMermaid } from "./mermaid.js";
export { explainDiagram } from "./explain.js";
export { DIAGRAM_TEMPLATES } from "./templates.js";
export type { DiagramTemplate } from "./templates.js";
export { applyDiagramEdits, diagramChanges } from "./refine.js";
export type { DiagramOp } from "./refine.js";
export { layoutDiagram, refitGroups } from "./layout.js";
export type { LayoutFit } from "./layout.js";
export { DIAGRAM_DOT, DIAGRAM_LINE, DIAGRAM_PAPER, PALETTE, SHAPE_COLOR, paintFor } from "./palette.js";
export type { DiagramTheme, Paint } from "./palette.js";
export { renderDiagramSvg } from "./svg.js";
export type { SvgOptions } from "./svg.js";
export { addBlock, addTextBox, connectBlocks, moveItem, removeItems, renameItem, setTitle, toggleLock } from "./edit.js";
