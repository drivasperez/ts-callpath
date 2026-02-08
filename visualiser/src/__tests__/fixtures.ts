import type { GraphNode, GraphEdge, GraphData, LayoutNode } from '../types.js';

export function makeGraphNode(
  overrides: Partial<GraphNode> & { id: string }
): GraphNode {
  return {
    filePath: 'src/file.ts',
    qualifiedName: overrides.id,
    line: 1,
    isInstrumented: false,
    isSource: false,
    isTarget: false,
    ...overrides,
  };
}

export function makeGraphEdge(
  from: string,
  to: string,
  kind: GraphEdge['kind'] = 'direct'
): GraphEdge {
  return { from, to, kind, callLine: 1 };
}

export function makeLayoutNode(
  overrides: Partial<LayoutNode> & { id: string }
): LayoutNode {
  return {
    x: 0,
    y: 0,
    width: 100,
    height: 28,
    original: makeGraphNode({ id: overrides.id }),
    isDummy: false,
    layer: 0,
    order: 0,
    ...overrides,
  };
}

/**
 * Build a GraphData from shorthand edge specs like 'a.ts::A->b.ts::B'.
 * Each spec creates nodes (if not yet seen) and an edge between them.
 */
export function buildGraphData(
  edgeSpecs: string[],
  nodeOverrides?: Record<string, Partial<GraphNode>>
): GraphData {
  const nodeMap = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  for (const spec of edgeSpecs) {
    const [fromSpec, toSpec] = spec.split('->');
    const [fromFile, fromName] = fromSpec.split('::');
    const [toFile, toName] = toSpec.split('::');

    const fromId = `${fromFile}::${fromName}`;
    const toId = `${toFile}::${toName}`;

    if (!nodeMap.has(fromId)) {
      nodeMap.set(
        fromId,
        makeGraphNode({
          id: fromId,
          filePath: fromFile,
          qualifiedName: fromName,
          ...nodeOverrides?.[fromId],
        })
      );
    }
    if (!nodeMap.has(toId)) {
      nodeMap.set(
        toId,
        makeGraphNode({
          id: toId,
          filePath: toFile,
          qualifiedName: toName,
          ...nodeOverrides?.[toId],
        })
      );
    }

    edges.push(makeGraphEdge(fromId, toId));
  }

  return { nodes: [...nodeMap.values()], edges };
}
