"use client";

import {
  ARROW_HEAD,
  FONT_LIMITS,
  LABEL_SIZE,
  LINE_WIDTH,
  SWATCHES,
  paintFor,
  textStyle,
  type AlignMode,
  type Curve,
  type DiagramModel,
  type TextStyle,
} from "@ensemble/block-diagrams";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  Bold,
  Italic,
  Minus,
  PenLine,
  Plus,
  Underline,
} from "lucide-react";
import type { ReactNode } from "react";
import { useDiagramTheme } from "./glyph";
import { ToolButton, ToolDivider, shortcutLabel } from "./toolbar";

export type FormatAction =
  | { kind: "text"; patch: Partial<TextStyle> }
  | { kind: "color"; color: string | null }
  | { kind: "line"; patch: { width?: number | null; head?: number | null; line?: "solid" | "dashed"; curve?: Curve; bend?: number } }
  | { kind: "label" }
  | { kind: "align"; mode: AlignMode }
  | { kind: "distribute"; axis: "horizontal" | "vertical" };

function Button({ label, shortcut, active, disabled, onClick, children }: { label: string; shortcut?: string | null; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <ToolButton label={label} shortcut={shortcut} aria-pressed={active} active={active} disabled={disabled} onClick={onClick}>
      {children}
    </ToolButton>
  );
}

function Stepper({ label, value, unit, onStep, min, max }: { label: string; value: number; unit?: string; onStep: (delta: number) => void; min: number; max: number }) {
  return (
    <span className="dg-stepper" role="group" aria-label={label}>
      <ToolButton label={`Smaller ${label.toLowerCase()}`} className="is-step" disabled={value <= min} onClick={() => onStep(-1)}>
        <Minus size={13} aria-hidden />
      </ToolButton>
      <span className="dg-stepper-value" title={label}>
        {Number.isInteger(value) ? value : value.toFixed(1)}
        {unit}
      </span>
      <ToolButton label={`Bigger ${label.toLowerCase()}`} className="is-step" disabled={value >= max} onClick={() => onStep(1)}>
        <Plus size={13} aria-hidden />
      </ToolButton>
    </span>
  );
}

const FONT_STEPS = [8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 40, 48];
const nextStep = (steps: number[], value: number, delta: number) =>
  delta > 0 ? (steps.find((step) => step > value + 0.01) ?? steps[steps.length - 1]!) : ([...steps].reverse().find((step) => step < value - 0.01) ?? steps[0]!);

/**
 * The bar that floats over the top of the canvas while something is selected: text size, bold,
 * italic and underline for any text; a colour for blocks; width, arrowhead, dash and curve for
 * lines; align and distribute for several blocks. Every change goes through the diagram text,
 * like any other canvas edit.
 */
export function FormatBar({ model, nodes, edges, onAction }: { model: DiagramModel; nodes: string[]; edges: string[]; onAction: (action: FormatAction) => void }) {
  const theme = useDiagramTheme();
  const blocks = nodes.filter((id) => model.nodes[id]);
  const texts = nodes.filter((id) => model.texts[id]);
  const lines = edges.filter((id) => model.edges[id]);
  if (!blocks.length && !texts.length && !lines.length) return null;
  const first = blocks[0] ? model.nodes[blocks[0]] : texts[0] ? model.texts[texts[0]] : model.edges[lines[0]!];
  const style = textStyle(first?.font);
  const base = blocks.length ? LABEL_SIZE.block : texts.length ? LABEL_SIZE.text : LABEL_SIZE.edge;
  const size = style.size ?? base;
  const all = [...blocks.map((id) => model.nodes[id]!.font), ...texts.map((id) => model.texts[id]!.font), ...lines.map((id) => model.edges[id]!.font)].map(textStyle);
  const every = (key: "bold" | "italic" | "underline") => all.every((item) => item[key]);
  const line = lines.length ? model.edges[lines[0]!]! : null;
  const width = line?.width ?? LINE_WIDTH.default;
  const head = line?.head ?? ARROW_HEAD.default;
  const color = blocks.length ? model.nodes[blocks[0]!]!.color : null;
  const boxes = [...blocks, ...texts].filter((id) => model.layout[id]);
  return (
    <div className="dg-float dg-format" role="toolbar" aria-label="Format selection" onPointerDown={(event) => event.stopPropagation()}>
      <span className="dg-group" role="group" aria-label="Text">
        <Stepper label="Text size" value={size} unit="px" min={FONT_LIMITS.min} max={FONT_LIMITS.max} onStep={(delta) => onAction({ kind: "text", patch: { size: nextStep(FONT_STEPS, size, delta) } })} />
        <Button label="Bold" shortcut={shortcutLabel("diagram-bold")} active={every("bold")} onClick={() => onAction({ kind: "text", patch: { bold: !every("bold") } })}>
          <Bold size={15} aria-hidden />
        </Button>
        <Button label="Italic" shortcut={shortcutLabel("diagram-italic")} active={every("italic")} onClick={() => onAction({ kind: "text", patch: { italic: !every("italic") } })}>
          <Italic size={15} aria-hidden />
        </Button>
        <Button label="Underline" shortcut={shortcutLabel("diagram-underline")} active={every("underline")} onClick={() => onAction({ kind: "text", patch: { underline: !every("underline") } })}>
          <Underline size={15} aria-hidden />
        </Button>
      </span>
      {blocks.length ? (
        <>
          <ToolDivider />
          <span className="dg-group dg-swatches" role="group" aria-label="Colour">
            <button
              type="button"
              className="dg-swatch is-auto"
              aria-label="Shape's own colour"
              title="Shape's own colour"
              aria-pressed={!color}
              data-active={!color || undefined}
              onClick={() => onAction({ kind: "color", color: null })}
            >
              A
            </button>
            {SWATCHES.map((name) => {
              const paint = paintFor("rectangle", name, theme);
              return (
                <button
                  key={name}
                  type="button"
                  className="dg-swatch"
                  aria-label={name}
                  title={name[0]!.toUpperCase() + name.slice(1)}
                  aria-pressed={color === name}
                  data-active={color === name || undefined}
                  style={{ background: paint.fill, borderColor: paint.stroke }}
                  onClick={() => onAction({ kind: "color", color: name })}
                />
              );
            })}
          </span>
        </>
      ) : null}
      {line ? (
        <>
          <ToolDivider />
          <span className="dg-group" role="group" aria-label="Line">
            <Stepper label="Line width" value={width} min={LINE_WIDTH.min} max={LINE_WIDTH.max} onStep={(delta) => onAction({ kind: "line", patch: { width: Math.min(LINE_WIDTH.max, Math.max(LINE_WIDTH.min, width + delta * 0.5)) } })} />
            <Stepper label="Arrowhead" value={head} min={ARROW_HEAD.min} max={ARROW_HEAD.max} onStep={(delta) => onAction({ kind: "line", patch: { head: Math.min(ARROW_HEAD.max, Math.max(ARROW_HEAD.min, head + delta * 2)) } })} />
            <select
              className="dg-select"
              aria-label="Line shape"
              value={line.curve}
              onChange={(event) => onAction({ kind: "line", patch: { curve: event.target.value as Curve } })}
            >
              <option value="straight">Straight</option>
              <option value="curved">Curved</option>
              <option value="elbow">Elbow</option>
            </select>
            <Button label="Dashed line" active={line.line === "dashed"} onClick={() => onAction({ kind: "line", patch: { line: line.line === "dashed" ? "solid" : "dashed" } })}>
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                <path d="M2 8 H14" stroke="currentColor" strokeWidth="1.6" strokeDasharray="3 2.2" />
              </svg>
            </Button>
            {line.bend ? (
              <ToolButton label="Straighten" text tip={false} onClick={() => onAction({ kind: "line", patch: { bend: 0 } })}>
                Straighten
              </ToolButton>
            ) : null}
            {lines.length === 1 ? (
              <Button label={line.label ? "Edit the label" : "Add a label"} onClick={() => onAction({ kind: "label" })}>
                <PenLine size={15} aria-hidden />
              </Button>
            ) : null}
          </span>
        </>
      ) : null}
      {boxes.length >= 2 ? (
        <>
          <ToolDivider />
          <span className="dg-group" role="group" aria-label="Align">
            <Button label="Align left" onClick={() => onAction({ kind: "align", mode: "left" })}>
              <AlignStartVertical size={15} aria-hidden />
            </Button>
            <Button label="Align centres" onClick={() => onAction({ kind: "align", mode: "center" })}>
              <AlignCenterVertical size={15} aria-hidden />
            </Button>
            <Button label="Align right" onClick={() => onAction({ kind: "align", mode: "right" })}>
              <AlignEndVertical size={15} aria-hidden />
            </Button>
            <Button label="Align top" onClick={() => onAction({ kind: "align", mode: "top" })}>
              <AlignStartHorizontal size={15} aria-hidden />
            </Button>
            <Button label="Align middles" onClick={() => onAction({ kind: "align", mode: "middle" })}>
              <AlignCenterHorizontal size={15} aria-hidden />
            </Button>
            <Button label="Align bottom" onClick={() => onAction({ kind: "align", mode: "bottom" })}>
              <AlignEndHorizontal size={15} aria-hidden />
            </Button>
            {boxes.length >= 3 ? (
              <>
                <Button label="Space evenly across" onClick={() => onAction({ kind: "distribute", axis: "horizontal" })}>
                  <AlignHorizontalDistributeCenter size={15} aria-hidden />
                </Button>
                <Button label="Space evenly down" onClick={() => onAction({ kind: "distribute", axis: "vertical" })}>
                  <AlignVerticalDistributeCenter size={15} aria-hidden />
                </Button>
              </>
            ) : null}
          </span>
        </>
      ) : null}
    </div>
  );
}
