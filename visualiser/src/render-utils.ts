import type { LayoutNode, LayoutResult, GraphData } from "./types.js";

// ── Colors ─────────────────────────────────────────────────────────────────

export const COLORS = {
  source: "var(--node-source)",
  target: "var(--node-target)",
  instrumented: "var(--node-instrumented)",
  external: "var(--node-external)",
  regularFill: "var(--node-fill)",
  regularBorder: "var(--node-border)",
  text: "var(--node-text)",
  edgeDirect: "var(--edge-direct)",
  edgeStaticMethod: "var(--edge-static-method)",
  edgeDiDefault: "var(--edge-di-default)",
  edgeInstrumentWrapper: "var(--edge-instrument-wrapper)",
  edgeReExport: "var(--edge-re-export)",
  edgeExternal: "var(--edge-external)",
  backedge: "var(--edge-backedge)",
  clusterBorder: "var(--cluster-border)",
  clusterLabel: "var(--cluster-label)",
  clusterFill: "var(--cluster-fill)",
} as const;

export const TEAM_COLORS = [
  "#4a7c6f",
  "#6b5b8a",
  "#7a6340",
  "#4a6a8a",
  "#8a5a5a",
  "#5a7a5a",
  "#7a5a7a",
  "#5a6a7a",
  "#6a7a5a",
  "#7a6a5a",
];

export const CORNER_RADIUS = 5;
export const TRANSITION_MS = 300;

export function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function teamColor(teamName: string): string {
  return TEAM_COLORS[simpleHash(teamName) % TEAM_COLORS.length];
}

export function edgeColor(kind: string): string {
  switch (kind) {
    case "static-method":
      return COLORS.edgeStaticMethod;
    case "di-default":
      return COLORS.edgeDiDefault;
    case "instrument-wrapper":
      return COLORS.edgeInstrumentWrapper;
    case "re-export":
      return COLORS.edgeReExport;
    case "external":
      return COLORS.edgeExternal;
    default:
      return COLORS.edgeDirect;
  }
}

export function edgeDasharray(kind: string): string {
  switch (kind) {
    case "di-default":
      return "6,3";
    case "external":
      return "6,3";
    case "instrument-wrapper":
    case "re-export":
      return "3,3";
    default:
      return "";
  }
}

export function edgeLabel(kind: string): string | null {
  switch (kind) {
    default:
      return null;
  }
}

export function nodeColor(node: LayoutNode): { fill: string; stroke: string; textFill: string } {
  if (!node.original)
    return { fill: COLORS.regularFill, stroke: COLORS.regularBorder, textFill: COLORS.text };
  if (node.original.isSource)
    return { fill: COLORS.source, stroke: COLORS.source, textFill: "#ffffff" };
  if (node.original.isTarget)
    return { fill: COLORS.target, stroke: COLORS.target, textFill: "#ffffff" };
  if (node.original.isExternal)
    return { fill: COLORS.external, stroke: COLORS.external, textFill: "#ffffff" };
  if (node.original.isInstrumented)
    return { fill: COLORS.instrumented, stroke: COLORS.instrumented, textFill: "#ffffff" };
  return { fill: COLORS.regularFill, stroke: COLORS.regularBorder, textFill: COLORS.text };
}

// ── Edge Path Construction ─────────────────────────────────────────────────

export function buildOrthogonalPath(waypoints: Array<{ x: number; y: number }>): string {
  if (waypoints.length < 2) return "";
  const parts: string[] = [`M ${waypoints[0].x} ${waypoints[0].y}`];

  for (let i = 1; i < waypoints.length; i++) {
    const prev = waypoints[i - 1];
    const curr = waypoints[i];

    if (i < waypoints.length - 1) {
      const next = waypoints[i + 1];
      // Calculate corner arc at this waypoint
      const dx1 = curr.x - prev.x;
      const dy1 = curr.y - prev.y;
      const dx2 = next.x - curr.x;
      const dy2 = next.y - curr.y;

      const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
      const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);

      if (len1 > 0 && len2 > 0) {
        const r = Math.min(CORNER_RADIUS, len1 / 2, len2 / 2);
        const beforeX = curr.x - (dx1 / len1) * r;
        const beforeY = curr.y - (dy1 / len1) * r;
        const afterX = curr.x + (dx2 / len2) * r;
        const afterY = curr.y + (dy2 / len2) * r;

        parts.push(`L ${beforeX} ${beforeY}`);
        parts.push(`Q ${curr.x} ${curr.y} ${afterX} ${afterY}`);
      } else {
        parts.push(`L ${curr.x} ${curr.y}`);
      }
    } else {
      parts.push(`L ${curr.x} ${curr.y}`);
    }
  }

  return parts.join(" ");
}

// ── Bounds Computation ─────────────────────────────────────────────────────

export function computeBounds(layout: LayoutResult): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of layout.nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  for (const c of layout.clusters) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + c.width);
    maxY = Math.max(maxY, c.y + c.height);
  }
  for (const e of layout.edges) {
    for (const wp of e.waypoints) {
      minX = Math.min(minX, wp.x);
      minY = Math.min(minY, wp.y);
      maxX = Math.max(maxX, wp.x);
      maxY = Math.max(maxY, wp.y);
    }
  }

  const padding = 40;
  return {
    x: (isFinite(minX) ? minX : 0) - padding,
    y: (isFinite(minY) ? minY : 0) - padding,
    w: (isFinite(maxX) ? maxX - minX : 800) + padding * 2,
    h: (isFinite(maxY) ? maxY - minY : 600) + padding * 2,
  };
}

// ── Path Helpers ───────────────────────────────────────────────────────────

export function fileName(filePath: string): string {
  if (filePath.startsWith("<external>::")) {
    return filePath.slice("<external>::".length);
  }
  return filePath.split("/").pop() ?? filePath;
}

// ── Node label ─────────────────────────────────────────────────────────────

export function nodeLabel(node: LayoutNode): string {
  if (node.isCollapsedGroup && node.original) {
    const fn = fileName(node.original.filePath);
    return `${fn} (${node.nodeCount})`;
  }
  if (node.original) {
    if (node.original.isExternal) {
      return node.original.qualifiedName;
    }
    return `${node.original.qualifiedName}:${node.original.line}`;
  }
  return node.id;
}

// ── Filter Helpers ─────────────────────────────────────────────────────────

export function filterByFocus(graphData: GraphData, focusIds: Set<string>): GraphData {
  const nodes = graphData.nodes.filter((n) => focusIds.has(n.id));
  const nodeIdSet = new Set(nodes.map((n) => n.id));
  const edges = graphData.edges.filter((e) => nodeIdSet.has(e.from) && nodeIdSet.has(e.to));
  return { nodes, edges, codeowners: graphData.codeowners };
}

export function filterByHidden(graphData: GraphData, hiddenIds: Set<string>): GraphData {
  if (hiddenIds.size === 0) return graphData;
  const nodes = graphData.nodes.filter((n) => !hiddenIds.has(n.id));
  const nodeIdSet = new Set(nodes.map((n) => n.id));
  const edges = graphData.edges.filter((e) => nodeIdSet.has(e.from) && nodeIdSet.has(e.to));
  return { nodes, edges, codeowners: graphData.codeowners };
}
