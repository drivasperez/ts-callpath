export type LayoutDirection = "TB" | "LR";

// Input format (matches renderJson() output from dotRenderer.ts)
export interface GraphNode {
  id: string;
  filePath: string;
  qualifiedName: string;
  line: number;
  endLine?: number;
  isInstrumented: boolean;
  isSource: boolean;
  isTarget: boolean;
  description?: string;
  signature?: string;
  sourceSnippet?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: "direct" | "static-method" | "di-default" | "instrument-wrapper" | "re-export";
  callLine: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  codeowners?: Record<string, string[]>;
  editor?: string;
  repoRoot?: string;
}

// Layout output
export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  original: GraphNode | null; // null for dummy nodes
  isDummy: boolean;
  layer: number;
  order: number;
  isCollapsedGroup?: boolean;
  nodeCount?: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
  kind: string;
  isBackedge: boolean;
  waypoints: Array<{ x: number; y: number }>;
}

export interface LayoutCluster {
  filePath: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  clusters: LayoutCluster[];
  clusterOrder: string[]; // left-to-right file-path order for layout stability
}
