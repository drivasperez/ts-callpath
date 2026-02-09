import type { GraphData, GraphNode, LayoutDirection, LayoutEdge, LayoutCluster } from "./types.js";

// ── Constants ──────────────────────────────────────────────────────────────

export const NODE_HEIGHT = 34;
export const NODE_PADDING_X = 14;
export const CHAR_WIDTH = 7; // monospace ~7px/char at 11px font
export const LAYER_GAP = 70;
export const NODE_GAP = 20;
export const CLUSTER_GAP = 30; // extra gap between file clusters in a layer
export const CLUSTER_PADDING = 16;
export const CLUSTER_LABEL_HEIGHT = 32; // room for filename label + team chips row
export const BARYCENTER_SWEEPS = 4;

// ── Phase 1: Backedge Detection ────────────────────────────────────────────

export const WHITE = 0;
export const GRAY = 1;
export const BLACK = 2;

export function detectBackedges(
  nodeIds: string[],
  edges: Array<{ from: string; to: string }>,
  sourceNodes: Set<string>,
): Set<number> {
  const backedges = new Set<number>();
  const color = new Map<string, number>();
  for (const id of nodeIds) color.set(id, WHITE);

  // Build adjacency: nodeId → [{ to, edgeIndex }]
  const adj = new Map<string, Array<{ to: string; edgeIdx: number }>>();
  for (const id of nodeIds) adj.set(id, []);
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const list = adj.get(e.from);
    if (list) list.push({ to: e.to, edgeIdx: i });
  }

  function dfs(u: string): void {
    color.set(u, GRAY);
    for (const { to, edgeIdx } of adj.get(u) ?? []) {
      const c = color.get(to);
      if (c === GRAY) {
        backedges.add(edgeIdx);
      } else if (c === WHITE) {
        dfs(to);
      }
    }
    color.set(u, BLACK);
  }

  // Start DFS from source nodes first for deterministic results
  for (const id of nodeIds) {
    if (sourceNodes.has(id) && color.get(id) === WHITE) {
      dfs(id);
    }
  }
  // Then any remaining unvisited nodes
  for (const id of nodeIds) {
    if (color.get(id) === WHITE) {
      dfs(id);
    }
  }

  return backedges;
}

// ── Phase 2: Layer Assignment ──────────────────────────────────────────────

export function assignLayers(
  nodeIds: string[],
  dagEdges: Array<{ from: string; to: string }>,
): Map<string, number> {
  // Compute in-degrees
  const inDegree = new Map<string, number>();
  const successors = new Map<string, string[]>();
  for (const id of nodeIds) {
    inDegree.set(id, 0);
    successors.set(id, []);
  }
  for (const e of dagEdges) {
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    successors.get(e.from)!.push(e.to);
  }

  // Kahn's topological sort
  const queue: string[] = [];
  for (const id of nodeIds) {
    if (inDegree.get(id) === 0) queue.push(id);
  }

  const layer = new Map<string, number>();
  // Initialize all to 0
  for (const id of nodeIds) layer.set(id, 0);

  while (queue.length > 0) {
    const u = queue.shift()!;
    for (const v of successors.get(u) ?? []) {
      // Longest-path layering
      layer.set(v, Math.max(layer.get(v)!, layer.get(u)! + 1));
      const d = inDegree.get(v)! - 1;
      inDegree.set(v, d);
      if (d === 0) queue.push(v);
    }
  }

  return layer;
}

// ── Phase 3: Dummy Nodes ───────────────────────────────────────────────────

export interface InternalNode {
  id: string;
  original: GraphNode | null;
  isDummy: boolean;
  layer: number;
  filePath: string; // for clustering; dummies inherit from source
  collapsedCount?: number; // number of original nodes in collapsed group
}

export interface InternalEdge {
  from: string;
  to: string;
  kind: string;
  isBackedge: boolean;
  originalEdgeIndex: number;
}

export function createDummyNodes(
  nodes: Map<string, InternalNode>,
  edges: InternalEdge[],
): { nodes: Map<string, InternalNode>; edges: InternalEdge[] } {
  const newNodes = new Map(nodes);
  const newEdges: InternalEdge[] = [];
  let dummyCounter = 0;

  for (const edge of edges) {
    if (edge.isBackedge) {
      newEdges.push(edge);
      continue;
    }

    const fromLayer = newNodes.get(edge.from)!.layer;
    const toLayer = newNodes.get(edge.to)!.layer;
    const span = toLayer - fromLayer;

    if (span <= 1) {
      newEdges.push(edge);
      continue;
    }

    // Insert dummy nodes for each intermediate layer
    let prevId = edge.from;
    const sourceFilePath = newNodes.get(edge.from)!.filePath;
    for (let l = fromLayer + 1; l < toLayer; l++) {
      const dummyId = `__dummy_${dummyCounter++}`;
      newNodes.set(dummyId, {
        id: dummyId,
        original: null,
        isDummy: true,
        layer: l,
        filePath: sourceFilePath,
      });
      newEdges.push({
        from: prevId,
        to: dummyId,
        kind: edge.kind,
        isBackedge: false,
        originalEdgeIndex: edge.originalEdgeIndex,
      });
      prevId = dummyId;
    }
    // Final segment to target
    newEdges.push({
      from: prevId,
      to: edge.to,
      kind: edge.kind,
      isBackedge: false,
      originalEdgeIndex: edge.originalEdgeIndex,
    });
  }

  return { nodes: newNodes, edges: newEdges };
}

// ── Phase 4: Node Ordering ─────────────────────────────────────────────────

export function orderNodes(
  nodes: Map<string, InternalNode>,
  edges: InternalEdge[],
  maxLayer: number,
  previousClusterOrder?: string[],
): Map<string, number> {
  // Build layers
  const layers: string[][] = [];
  for (let l = 0; l <= maxLayer; l++) layers.push([]);
  for (const [id, node] of nodes) {
    if (node.layer >= 0 && node.layer <= maxLayer) {
      layers[node.layer].push(id);
    }
  }

  // Sort initial order: use previous cluster order as hint if available,
  // otherwise fall back to alphabetical filePath for stability
  const prevOrderIndex = new Map<string, number>();
  if (previousClusterOrder) {
    for (let i = 0; i < previousClusterOrder.length; i++) {
      prevOrderIndex.set(previousClusterOrder[i], i);
    }
  }

  for (const layer of layers) {
    layer.sort((a, b) => {
      const na = nodes.get(a)!;
      const nb = nodes.get(b)!;
      const idxA = prevOrderIndex.get(na.filePath);
      const idxB = prevOrderIndex.get(nb.filePath);
      // Both in previous order: sort by previous position
      if (idxA !== undefined && idxB !== undefined) {
        if (idxA !== idxB) return idxA - idxB;
        return na.id.localeCompare(nb.id);
      }
      // One in previous order, other not: previous-order files come first
      if (idxA !== undefined) return -1;
      if (idxB !== undefined) return 1;
      // Neither in previous order: alphabetical fallback
      const cmp = na.filePath.localeCompare(nb.filePath);
      if (cmp !== 0) return cmp;
      return na.id.localeCompare(nb.id);
    });
  }

  // Build adjacency for barycenter
  const predecessors = new Map<string, string[]>();
  const successorsList = new Map<string, string[]>();
  for (const [id] of nodes) {
    predecessors.set(id, []);
    successorsList.set(id, []);
  }
  for (const e of edges) {
    if (e.isBackedge) continue;
    predecessors.get(e.to)?.push(e.from);
    successorsList.get(e.from)?.push(e.to);
  }

  function barycenter(nodeId: string, refLayer: string[]): number {
    const refPositions = new Map<string, number>();
    for (let i = 0; i < refLayer.length; i++) {
      refPositions.set(refLayer[i], i);
    }

    const neighbors = [...(predecessors.get(nodeId) ?? []), ...(successorsList.get(nodeId) ?? [])];
    const positions = neighbors
      .map((n) => refPositions.get(n))
      .filter((p): p is number => p !== undefined);

    if (positions.length === 0) return Infinity;
    return positions.reduce((a, b) => a + b, 0) / positions.length;
  }

  // Barycenter sweeps
  for (let sweep = 0; sweep < BARYCENTER_SWEEPS; sweep++) {
    // Down sweep
    for (let l = 1; l <= maxLayer; l++) {
      const refLayer = layers[l - 1];
      layers[l].sort((a, b) => {
        const na = nodes.get(a)!;
        const nb = nodes.get(b)!;
        // Cluster grouping: same file stays together
        const clusterBaryA = clusterBarycenter(
          na.filePath,
          layers[l],
          refLayer,
          predecessors,
          nodes,
        );
        const clusterBaryB = clusterBarycenter(
          nb.filePath,
          layers[l],
          refLayer,
          predecessors,
          nodes,
        );
        if (clusterBaryA !== clusterBaryB) return clusterBaryA - clusterBaryB;
        const fileCmp = na.filePath.localeCompare(nb.filePath);
        if (fileCmp !== 0) return fileCmp;
        return barycenter(a, refLayer) - barycenter(b, refLayer);
      });
    }
    // Up sweep
    for (let l = maxLayer - 1; l >= 0; l--) {
      const refLayer = layers[l + 1];
      layers[l].sort((a, b) => {
        const na = nodes.get(a)!;
        const nb = nodes.get(b)!;
        const clusterBaryA = clusterBarycenter(
          na.filePath,
          layers[l],
          refLayer,
          successorsList,
          nodes,
        );
        const clusterBaryB = clusterBarycenter(
          nb.filePath,
          layers[l],
          refLayer,
          successorsList,
          nodes,
        );
        if (clusterBaryA !== clusterBaryB) return clusterBaryA - clusterBaryB;
        const fileCmp = na.filePath.localeCompare(nb.filePath);
        if (fileCmp !== 0) return fileCmp;
        return barycenter(a, refLayer) - barycenter(b, refLayer);
      });
    }
  }

  // Assign order index
  const order = new Map<string, number>();
  for (const layer of layers) {
    for (let i = 0; i < layer.length; i++) {
      order.set(layer[i], i);
    }
  }
  return order;
}

export function clusterBarycenter(
  filePath: string,
  currentLayer: string[],
  refLayer: string[],
  neighbors: Map<string, string[]>,
  nodes: Map<string, InternalNode>,
): number {
  // Average barycenter of all nodes in the same file-cluster in this layer
  const refPositions = new Map<string, number>();
  for (let i = 0; i < refLayer.length; i++) {
    refPositions.set(refLayer[i], i);
  }

  const positions: number[] = [];
  for (const nodeId of currentLayer) {
    if (nodes.get(nodeId)!.filePath !== filePath) continue;
    for (const n of neighbors.get(nodeId) ?? []) {
      const pos = refPositions.get(n);
      if (pos !== undefined) positions.push(pos);
    }
  }

  if (positions.length === 0) return Infinity;
  return positions.reduce((a, b) => a + b, 0) / positions.length;
}

// ── Phase 5: Coordinate Assignment ─────────────────────────────────────────

export function estimateNodeWidth(node: InternalNode): number {
  if (node.isDummy) return 0;
  if (node.id.startsWith("__collapsed:")) {
    const fileName = node.filePath.split("/").pop() ?? node.filePath;
    const label = `${fileName} (${node.collapsedCount ?? 0})`;
    return label.length * CHAR_WIDTH + NODE_PADDING_X * 2;
  }
  const label = `${node.original!.qualifiedName}:${node.original!.line}`;
  return label.length * CHAR_WIDTH + NODE_PADDING_X * 2;
}

export interface PositionedNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  original: GraphNode | null;
  isDummy: boolean;
  layer: number;
  order: number;
}

export function assignCoordinates(
  nodes: Map<string, InternalNode>,
  order: Map<string, number>,
  maxLayer: number,
  previousClusterOrder?: string[],
  direction: LayoutDirection = "LR",
): { positioned: PositionedNode[]; clusterOrder: string[] } {
  const isLR = direction === "LR";

  // Axis mapping helpers:
  // "flow" = direction layers progress (TB → Y, LR → X)
  // "cross" = direction clusters/nodes spread (TB → X, LR → Y)
  //
  // layerFlowSize: extent used for per-layer spacing (TB uses uniform NODE_HEIGHT)
  // nodeFlowSize: individual node's extent for centering within the layer band
  const layerFlowSize = (n: InternalNode): number =>
    isLR ? Math.max(estimateNodeWidth(n), 4) : NODE_HEIGHT;
  const nodeFlowSize = (n: InternalNode): number =>
    isLR ? Math.max(estimateNodeWidth(n), 4) : n.isDummy ? 0 : NODE_HEIGHT;
  const nodeCrossSize = (n: InternalNode): number =>
    isLR ? (n.isDummy ? 0 : NODE_HEIGHT) : Math.max(estimateNodeWidth(n), 4);
  // Cross-axis label reservation (only needed when clusters stack along Y, i.e. LR)
  const crossLabelSpace = isLR ? CLUSTER_LABEL_HEIGHT : 0;

  // Step 1: Build ordered layers
  const layers: InternalNode[][] = [];
  for (let l = 0; l <= maxLayer; l++) layers.push([]);
  for (const [, node] of nodes) {
    if (node.layer >= 0 && node.layer <= maxLayer) {
      layers[node.layer].push(node);
    }
  }
  for (const layer of layers) {
    layer.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  // Step 2: Determine global cluster order
  const scanOrder: string[] = [];
  const scanOrderSet = new Set<string>();
  for (const layer of layers) {
    for (const node of layer) {
      if (!scanOrderSet.has(node.filePath)) {
        scanOrderSet.add(node.filePath);
        scanOrder.push(node.filePath);
      }
    }
  }

  let clusterOrder: string[];
  if (previousClusterOrder && previousClusterOrder.length > 0) {
    const existingFiles = scanOrderSet;
    const kept = previousClusterOrder.filter((fp) => existingFiles.has(fp));
    const keptSet = new Set(kept);
    const newClusters = scanOrder.filter((fp) => !keptSet.has(fp));
    clusterOrder = [...kept];
    for (const fp of newClusters) {
      const scanIdx = scanOrder.indexOf(fp);
      let insertAt = clusterOrder.length;
      for (let i = scanIdx - 1; i >= 0; i--) {
        const beforeFp = scanOrder[i];
        const keptIdx = clusterOrder.indexOf(beforeFp);
        if (keptIdx !== -1) {
          insertAt = keptIdx + 1;
          break;
        }
      }
      clusterOrder.splice(insertAt, 0, fp);
    }
  } else {
    clusterOrder = scanOrder;
  }

  // Step 3: Compute per-layer flow extent (max flow-size of any node in the layer)
  const layerFlowExtent = new Map<number, number>();
  for (let l = 0; l <= maxLayer; l++) {
    let maxF = 0;
    for (const node of layers[l]) {
      maxF = Math.max(maxF, layerFlowSize(node));
    }
    layerFlowExtent.set(l, maxF);
  }

  // Step 4: Compute layer flow positions (cumulative along flow axis)
  const layerFlowPos = new Map<number, number>();
  let accFlow = CLUSTER_PADDING;
  for (let l = 0; l <= maxLayer; l++) {
    layerFlowPos.set(l, accFlow);
    accFlow += (layerFlowExtent.get(l) ?? 0) + LAYER_GAP;
  }

  // Step 5: Compute max cluster cross extent per file across all layers
  const maxClusterCross = new Map<string, number>();
  for (const fp of clusterOrder) maxClusterCross.set(fp, 0);

  for (const layer of layers) {
    const fileGroups = new Map<string, InternalNode[]>();
    for (const node of layer) {
      let group = fileGroups.get(node.filePath);
      if (!group) {
        group = [];
        fileGroups.set(node.filePath, group);
      }
      group.push(node);
    }

    for (const [fp, group] of fileGroups) {
      let extent = 0;
      for (let i = 0; i < group.length; i++) {
        if (i > 0) extent += NODE_GAP;
        extent += nodeCrossSize(group[i]);
      }
      const current = maxClusterCross.get(fp) ?? 0;
      if (extent > current) maxClusterCross.set(fp, extent);
    }
  }

  // Step 6: Compute cluster cross positions (cumulative along cross axis)
  const clusterCrossPos = new Map<string, number>();
  let accCross = CLUSTER_PADDING + crossLabelSpace;
  for (const fp of clusterOrder) {
    clusterCrossPos.set(fp, accCross);
    accCross +=
      (maxClusterCross.get(fp) ?? 0) + CLUSTER_PADDING * 2 + crossLabelSpace + CLUSTER_GAP;
  }

  // Step 7: Position nodes
  const positioned: PositionedNode[] = [];

  for (let l = 0; l <= maxLayer; l++) {
    const layer = layers[l];
    const flowPos = layerFlowPos.get(l)!;
    const flowExtent = layerFlowExtent.get(l)!;

    const fileGroups = new Map<string, InternalNode[]>();
    for (const node of layer) {
      let group = fileGroups.get(node.filePath);
      if (!group) {
        group = [];
        fileGroups.set(node.filePath, group);
      }
      group.push(node);
    }

    for (const fp of clusterOrder) {
      const group = fileGroups.get(fp);
      if (!group || group.length === 0) continue;

      const crossPos = clusterCrossPos.get(fp)!;
      const crossExtent = maxClusterCross.get(fp)!;

      // Compute total cross size of this group
      let groupCross = 0;
      for (let i = 0; i < group.length; i++) {
        if (i > 0) groupCross += NODE_GAP;
        groupCross += nodeCrossSize(group[i]);
      }

      // Center the group within the allocated cross band
      let curCross = crossPos + (crossExtent - groupCross) / 2;

      for (const node of group) {
        const width = estimateNodeWidth(node);
        const height = node.isDummy ? 0 : NODE_HEIGHT;
        const nFlow = nodeFlowSize(node);
        const nCross = nodeCrossSize(node);

        // Center node's flow size within the layer's flow band
        const nodeFlow = flowPos + (flowExtent - nFlow) / 2;

        if (isLR) {
          positioned.push({
            id: node.id,
            x: nodeFlow,
            y: curCross,
            width,
            height,
            original: node.original,
            isDummy: node.isDummy,
            layer: node.layer,
            order: order.get(node.id) ?? 0,
          });
        } else {
          positioned.push({
            id: node.id,
            x: curCross,
            y: nodeFlow,
            width,
            height,
            original: node.original,
            isDummy: node.isDummy,
            layer: node.layer,
            order: order.get(node.id) ?? 0,
          });
        }

        curCross += nCross + NODE_GAP;
      }
    }
  }

  return { positioned, clusterOrder };
}

// ── Phase 5b: Edge Routing ─────────────────────────────────────────────────

export function routeEdges(
  edges: InternalEdge[],
  positionedNodes: Map<string, PositionedNode>,
  direction: LayoutDirection = "LR",
): LayoutEdge[] {
  const isLR = direction === "LR";

  // Direction-agnostic accessors for positioned nodes:
  // flow exit = where edges leave (TB: bottom, LR: right)
  // flow enter = where edges arrive (TB: top, LR: left)
  // cross center = perpendicular center (TB: x center, LR: y center)
  const flowEnd = (n: PositionedNode): number => (isLR ? n.x + n.width : n.y + n.height);
  const flowStart = (n: PositionedNode): number => (isLR ? n.x : n.y);
  const crossCenter = (n: PositionedNode): number =>
    isLR ? n.y + n.height / 2 : n.x + n.width / 2;
  const toXY = (flow: number, cross: number): { x: number; y: number } =>
    isLR ? { x: flow, y: cross } : { x: cross, y: flow };

  const layoutEdges: LayoutEdge[] = [];

  // Pre-compute layer flow boundaries for track placement
  const layerFlowEndMap = new Map<number, number>();
  const layerFlowStartMap = new Map<number, number>();
  for (const [, n] of positionedNodes) {
    const fEnd = flowEnd(n);
    const fStart = flowStart(n);
    const prevEnd = layerFlowEndMap.get(n.layer);
    if (prevEnd === undefined || fEnd > prevEnd) layerFlowEndMap.set(n.layer, fEnd);
    const prevStart = layerFlowStartMap.get(n.layer);
    if (prevStart === undefined || fStart < prevStart) layerFlowStartMap.set(n.layer, fStart);
  }

  // Group edges by originalEdgeIndex to reconstruct paths through dummies
  const edgeChains = new Map<number, InternalEdge[]>();
  for (const e of edges) {
    if (e.isBackedge) {
      const fromNode = positionedNodes.get(e.from);
      const toNode = positionedNodes.get(e.to);
      if (!fromNode || !toNode) continue;

      layoutEdges.push({
        from: e.from,
        to: e.to,
        kind: e.kind,
        isBackedge: true,
        waypoints: isLR
          ? _routeBackedgeLR(fromNode, toNode, positionedNodes)
          : _routeBackedgeTB(fromNode, toNode, positionedNodes),
      });
      continue;
    }

    let chain = edgeChains.get(e.originalEdgeIndex);
    if (!chain) {
      chain = [];
      edgeChains.set(e.originalEdgeIndex, chain);
    }
    chain.push(e);
  }

  for (const [, chain] of edgeChains) {
    if (chain.length === 0) continue;

    const originalFrom = chain[0].from;
    const originalTo = chain[chain.length - 1].to;
    const kind = chain[0].kind;

    const nodeChain: string[] = [originalFrom];
    for (const e of chain) {
      nodeChain.push(e.to);
    }

    const waypoints: Array<{ x: number; y: number }> = [];

    for (let i = 0; i < nodeChain.length - 1; i++) {
      const srcNode = positionedNodes.get(nodeChain[i]);
      const tgtNode = positionedNodes.get(nodeChain[i + 1]);
      if (!srcNode || !tgtNode) continue;

      const srcFlowExit = flowEnd(srcNode);
      const srcCross = crossCenter(srcNode);
      const tgtFlowEntry = flowStart(tgtNode);
      const tgtCross = crossCenter(tgtNode);

      // Start point for the first segment
      if (i === 0) {
        waypoints.push(toXY(srcFlowExit, srcCross));
      }

      if (Math.abs(srcCross - tgtCross) < 1) {
        // Straight along flow axis
        waypoints.push(toXY(tgtFlowEntry, tgtCross));
      } else {
        // 3-segment staircase: flow → cross → flow
        const srcLayerEnd = layerFlowEndMap.get(srcNode.layer) ?? srcFlowExit;
        const tgtLayerStart = layerFlowStartMap.get(tgtNode.layer) ?? tgtFlowEntry;
        const track = srcLayerEnd + (tgtLayerStart - srcLayerEnd) / 2;

        waypoints.push(toXY(track, srcCross)); // along flow to track
        waypoints.push(toXY(track, tgtCross)); // along cross to target
        waypoints.push(toXY(tgtFlowEntry, tgtCross)); // along flow to entry
      }
    }

    // Deduplicate consecutive identical waypoints
    const deduped: Array<{ x: number; y: number }> = [];
    for (const wp of waypoints) {
      const last = deduped[deduped.length - 1];
      if (last && Math.abs(last.x - wp.x) < 0.5 && Math.abs(last.y - wp.y) < 0.5) {
        continue;
      }
      deduped.push(wp);
    }

    if (deduped.length < 2) continue;

    layoutEdges.push({
      from: originalFrom,
      to: originalTo,
      kind,
      isBackedge: false,
      waypoints: deduped,
    });
  }

  return layoutEdges;
}

// Backedge helpers — kept separate because waypoint topology differs between directions

function _routeBackedgeTB(
  fromNode: PositionedNode,
  toNode: PositionedNode,
  allNodes: Map<string, PositionedNode>,
): Array<{ x: number; y: number }> {
  // Route backedge: right side of source → right → up → into target top
  let maxX = 0;
  for (const [, n] of allNodes) {
    maxX = Math.max(maxX, n.x + n.width);
  }

  const offset = maxX + 40;
  const fromBottom = fromNode.y + fromNode.height;
  const fromRight = fromNode.x + fromNode.width;
  const toRight = toNode.x + toNode.width;
  const toTop = toNode.y;

  return [
    { x: fromRight, y: fromBottom - NODE_HEIGHT / 2 },
    { x: offset, y: fromBottom - NODE_HEIGHT / 2 },
    { x: offset, y: toTop + NODE_HEIGHT / 2 },
    { x: Math.max(fromRight, toRight), y: toTop + NODE_HEIGHT / 2 },
    { x: toNode.x + toNode.width / 2, y: toTop },
  ];
}

function _routeBackedgeLR(
  fromNode: PositionedNode,
  toNode: PositionedNode,
  allNodes: Map<string, PositionedNode>,
): Array<{ x: number; y: number }> {
  // Route backedge: bottom of source → down → horizontal → up → into target bottom
  let maxY = 0;
  for (const [, n] of allNodes) {
    maxY = Math.max(maxY, n.y + n.height);
  }

  const offset = maxY + 40;
  const srcCenterX = fromNode.x + fromNode.width / 2;
  const srcBottom = fromNode.y + fromNode.height;
  const tgtCenterX = toNode.x + toNode.width / 2;
  const tgtBottom = toNode.y + toNode.height;

  return [
    { x: srcCenterX, y: srcBottom },
    { x: srcCenterX, y: offset },
    { x: tgtCenterX, y: offset },
    { x: tgtCenterX, y: tgtBottom },
  ];
}

// ── Phase 6: Assemble Output ───────────────────────────────────────────────

export function computeClusters(positioned: PositionedNode[]): LayoutCluster[] {
  const fileNodes = new Map<string, PositionedNode[]>();
  for (const node of positioned) {
    if (node.isDummy) continue;
    let list = fileNodes.get(node.original!.filePath);
    if (!list) {
      list = [];
      fileNodes.set(node.original!.filePath, list);
    }
    list.push(node);
  }

  const clusters: LayoutCluster[] = [];
  for (const [filePath, nodes] of fileNodes) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
    }
    clusters.push({
      filePath,
      x: minX - CLUSTER_PADDING,
      y: minY - CLUSTER_PADDING - CLUSTER_LABEL_HEIGHT,
      width: maxX - minX + CLUSTER_PADDING * 2,
      height: maxY - minY + CLUSTER_PADDING * 2 + CLUSTER_LABEL_HEIGHT,
    });
  }

  return clusters;
}

// ── Collapse Preprocessing ──────────────────────────────────────────────────

export function preprocessCollapsed(
  data: GraphData,
  collapsedFiles: Set<string>,
): { data: GraphData; collapsedCounts: Map<string, number> } {
  const collapsedCounts = new Map<string, number>();

  // Build synthetic nodes for each collapsed file
  const syntheticNodes: GraphNode[] = [];
  const removedNodeIds = new Set<string>();

  for (const filePath of collapsedFiles) {
    const fileNodes = data.nodes.filter((n) => n.filePath === filePath);
    if (fileNodes.length === 0) continue;

    collapsedCounts.set(filePath, fileNodes.length);
    for (const n of fileNodes) removedNodeIds.add(n.id);

    syntheticNodes.push({
      id: `__collapsed:${filePath}`,
      filePath,
      qualifiedName: filePath.split("/").pop() ?? filePath,
      line: 0,
      isInstrumented: fileNodes.some((n) => n.isInstrumented),
      isSource: fileNodes.some((n) => n.isSource),
      isTarget: fileNodes.some((n) => n.isTarget),
    });
  }

  const newNodes = [...data.nodes.filter((n) => !removedNodeIds.has(n.id)), ...syntheticNodes];

  // Remap edges
  const nodeToSynthetic = new Map<string, string>();
  for (const n of data.nodes) {
    if (removedNodeIds.has(n.id)) {
      nodeToSynthetic.set(n.id, `__collapsed:${n.filePath}`);
    }
  }

  const seenEdges = new Set<string>();
  const newEdges: typeof data.edges = [];
  for (const e of data.edges) {
    const from = nodeToSynthetic.get(e.from) ?? e.from;
    const to = nodeToSynthetic.get(e.to) ?? e.to;
    // Remove self-loops
    if (from === to) continue;
    const key = `${from}→${to}→${e.kind}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    newEdges.push({ ...e, from, to });
  }

  return {
    data: { nodes: newNodes, edges: newEdges },
    collapsedCounts,
  };
}
