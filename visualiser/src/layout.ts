import type { GraphData, LayoutDirection, LayoutNode, LayoutResult } from "./types.js";
import {
  detectBackedges,
  assignLayers,
  createDummyNodes,
  orderNodes,
  assignCoordinates,
  routeEdges,
  computeClusters,
  preprocessCollapsed,
  type InternalNode,
  type InternalEdge,
} from "./layout-utils.js";

// ── Main Export ─────────────────────────────────────────────────────────────

export function layoutGraph(
  data: GraphData,
  collapsedFiles?: Set<string>,
  previousClusterOrder?: string[],
  direction: LayoutDirection = "LR",
): LayoutResult {
  if (data.nodes.length === 0) {
    return { nodes: [], edges: [], clusters: [], clusterOrder: [] };
  }

  // Collapse preprocessing
  let collapsedCounts = new Map<string, number>();
  let effectiveData = data;
  if (collapsedFiles && collapsedFiles.size > 0) {
    const result = preprocessCollapsed(data, collapsedFiles);
    effectiveData = result.data;
    collapsedCounts = result.collapsedCounts;
  }

  const nodeIds = effectiveData.nodes.map((n) => n.id);
  const sourceNodes = new Set(effectiveData.nodes.filter((n) => n.isSource).map((n) => n.id));

  // Phase 1: Detect backedges
  const backedgeSet = detectBackedges(nodeIds, effectiveData.edges, sourceNodes);

  // DAG edges (backedges removed)
  const dagEdges = effectiveData.edges
    .map((e, i) => ({ ...e, index: i }))
    .filter((e) => !backedgeSet.has(e.index));

  // Phase 2: Layer assignment
  const layers = assignLayers(
    nodeIds,
    dagEdges.map((e) => ({ from: e.from, to: e.to })),
  );

  const maxLayer = Math.max(0, ...layers.values());

  // Build internal nodes
  const internalNodes = new Map<string, InternalNode>();
  for (const node of effectiveData.nodes) {
    internalNodes.set(node.id, {
      id: node.id,
      original: node,
      isDummy: false,
      layer: layers.get(node.id) ?? 0,
      filePath: node.filePath,
      collapsedCount: collapsedCounts.get(node.filePath),
    });
  }

  // Build internal edges
  const internalEdges: InternalEdge[] = effectiveData.edges.map((e, i) => ({
    from: e.from,
    to: e.to,
    kind: e.kind,
    isBackedge: backedgeSet.has(i),
    originalEdgeIndex: i,
  }));

  // Phase 3: Dummy nodes
  const withDummies = createDummyNodes(internalNodes, internalEdges);

  // Recompute max layer with dummies
  let actualMaxLayer = maxLayer;
  for (const [, node] of withDummies.nodes) {
    actualMaxLayer = Math.max(actualMaxLayer, node.layer);
  }

  // Phase 4: Node ordering
  const order = orderNodes(
    withDummies.nodes,
    withDummies.edges,
    actualMaxLayer,
    previousClusterOrder,
  );

  // Phase 5: Coordinate assignment
  const { positioned, clusterOrder } = assignCoordinates(
    withDummies.nodes,
    order,
    actualMaxLayer,
    previousClusterOrder,
    direction,
  );
  const positionedMap = new Map(positioned.map((p) => [p.id, p]));

  // Phase 5b: Edge routing
  const layoutEdges = routeEdges(withDummies.edges, positionedMap, direction);

  // Phase 6: Assemble
  const layoutNodes: LayoutNode[] = positioned
    .filter((p) => !p.isDummy)
    .map((p) => {
      const isCollapsed = p.id.startsWith("__collapsed:");
      const node: LayoutNode = {
        id: p.id,
        x: p.x,
        y: p.y,
        width: p.width,
        height: p.height,
        original: p.original,
        isDummy: false,
        layer: p.layer,
        order: p.order,
      };
      if (isCollapsed) {
        const filePath = p.id.slice("__collapsed:".length);
        node.isCollapsedGroup = true;
        node.nodeCount = collapsedCounts.get(filePath) ?? 0;
      }
      return node;
    });

  const clusters = computeClusters(positioned);

  return { nodes: layoutNodes, edges: layoutEdges, clusters, clusterOrder };
}
