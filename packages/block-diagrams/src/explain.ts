import type { DiagramModel } from "./model.js";

const SHAPE_WORD: Record<string, string> = {
  rectangle: "a step",
  rounded: "a screen",
  diamond: "a decision",
  circle: "a start or end",
  ellipse: "an item",
  cylinder: "a store",
  server: "a service",
  triangle: "a marker",
  parallelogram: "an input or output",
  document: "a document",
  cloud: "an outside service",
  actor: "a person",
  hexagon: "a step",
  note: "a note",
  trapezoid: "a step",
};

function sentence(direction: string): string {
  if (direction === "right") return "It reads from left to right.";
  if (direction === "left") return "It reads from right to left.";
  if (direction === "up") return "It reads from bottom to top.";
  return "It reads from top to bottom.";
}

/** Plain language for someone who does not write software. */
export function explainDiagram(model: DiagramModel): string {
  const title = model.meta.title.trim() || "This diagram";
  const lines = [`${title}. ${sentence(model.meta.direction)}`];
  const groups = Object.entries(model.groups);
  if (groups.length) {
    for (const [id, group] of groups) {
      const members = Object.values(model.nodes)
        .filter((node) => node.group === id)
        .map((node) => node.label);
      lines.push(members.length ? `${group.label} contains ${members.join(", ")}.` : `${group.label} is empty.`);
    }
  }
  const loose = Object.values(model.nodes).filter((node) => !node.group);
  if (loose.length) {
    lines.push(
      loose.map((node) => `${node.label} is ${SHAPE_WORD[node.shape] ?? "a block"}`).join(". ") + ".",
    );
  }
  const arrows = Object.values(model.edges);
  if (arrows.length) {
    lines.push(
      arrows
        .map((edge) => {
          const from = model.nodes[edge.from.node]?.label ?? edge.from.node;
          const to = model.nodes[edge.to.node]?.label ?? edge.to.node;
          return edge.label ? `${from} goes to ${to} (${edge.label}).` : `${from} goes to ${to}.`;
        })
        .join(" "),
    );
  } else if (!Object.keys(model.nodes).length) {
    lines.push("It has no blocks yet.");
  }
  return lines.join(" ");
}
