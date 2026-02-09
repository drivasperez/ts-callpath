import type { FunctionId, FunctionNode, CallGraph } from "./types.js";
import { createEmptyGraph, addNode, addEdge, makeFunctionId, parseFunctionId } from "./types.js";
import { Resolver } from "./resolver.js";

export interface BfsOptions {
  maxDepth: number;
  maxNodes: number;
  verbose: boolean;
}

/**
 * Forward BFS from sourceId, building the call graph lazily.
 * Parses files on-demand as new call targets are discovered.
 */
export function forwardBfs(
  sourceId: FunctionId,
  resolver: Resolver,
  options: BfsOptions,
): CallGraph {
  const graph = createEmptyGraph();
  const { filePath, qualifiedName } = parseFunctionId(sourceId);

  const file = resolver.getFile(filePath);
  if (!file) {
    if (options.verbose) {
      process.stderr.write(`Error: cannot parse source file ${filePath}\n`);
    }
    return graph;
  }

  const resolved = resolver.resolveQualifiedName(filePath, qualifiedName);
  if (!resolved) {
    if (options.verbose) {
      process.stderr.write(`Error: function "${qualifiedName}" not found in ${filePath}\n`);
      process.stderr.write(
        `  Available functions: ${file.functions.map((f) => f.qualifiedName).join(", ")}\n`,
      );
    }
    return graph;
  }

  const startFn = resolved.fn;
  const resolvedSourceId =
    resolved.qualifiedName !== qualifiedName
      ? makeFunctionId(filePath, resolved.qualifiedName)
      : sourceId;

  const startNode: FunctionNode = {
    id: resolvedSourceId,
    filePath,
    qualifiedName: resolved.qualifiedName,
    line: startFn.line,
    endLine: startFn.endLine,
    isInstrumented: startFn.isInstrumented,
    description: startFn.description,
    signature: startFn.signature,
  };
  addNode(graph, startNode);

  // BFS queue: [functionId, depth]
  const queue: Array<[FunctionId, number]> = [[resolvedSourceId, 0]];
  const visited = new Set<FunctionId>([resolvedSourceId]);
  // Track edges we've already added to avoid duplicates (same caller→callee)
  const edgeKeys = new Set<string>();

  while (queue.length > 0) {
    const [currentId, depth] = queue.shift()!;

    if (depth >= options.maxDepth) continue;
    if (graph.nodes.size >= options.maxNodes) {
      if (options.verbose) {
        process.stderr.write(`  Node limit reached (${options.maxNodes})\n`);
      }
      break;
    }

    const { filePath: curFilePath, qualifiedName: curQualName } = parseFunctionId(currentId);
    const curFile = resolver.getFile(curFilePath);
    if (!curFile) continue;

    const curFn = curFile.functions.find((f) => f.qualifiedName === curQualName);
    if (!curFn) continue;

    if (options.verbose && curFn.callSites.length > 0) {
      process.stderr.write(
        `  [depth=${depth}] ${curQualName}: ${curFn.callSites.length} call sites\n`,
      );
    }

    for (const callSite of curFn.callSites) {
      const resolved = resolver.resolveCallSite(callSite, curFile, curFn);
      if (!resolved) continue;

      const { targetId, targetNode, kind } = resolved;

      // Avoid self-loops
      if (targetId === currentId) continue;

      addNode(graph, targetNode);

      // Deduplicate edges (keep first occurrence per caller→callee pair)
      const edgeKey = `${currentId}→${targetId}`;
      if (!edgeKeys.has(edgeKey)) {
        edgeKeys.add(edgeKey);
        addEdge(graph, {
          callerId: currentId,
          calleeId: targetId,
          kind,
          callLine: callSite.line,
        });
      }

      if (!visited.has(targetId)) {
        visited.add(targetId);
        queue.push([targetId, depth + 1]);
      }
    }
  }

  return graph;
}

/**
 * Merge multiple CallGraphs into one, deduplicating edges.
 */
export function mergeGraphs(graphs: CallGraph[]): CallGraph {
  const merged = createEmptyGraph();
  const edgeKeys = new Set<string>();
  for (const g of graphs) {
    for (const [, node] of g.nodes) addNode(merged, node);
    for (const edge of g.edges) {
      const key = `${edge.callerId}→${edge.calleeId}`;
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        addEdge(merged, edge);
      }
    }
  }
  return merged;
}

/**
 * Backward BFS from targetIds on the reverse edges of the graph.
 * Returns the set of nodes reachable by walking backward from any target.
 */
function backwardReachable(graph: CallGraph, targetIds: FunctionId[]): Set<FunctionId> {
  const reachable = new Set<FunctionId>();
  const queue: FunctionId[] = [];

  for (const targetId of targetIds) {
    if (graph.nodes.has(targetId)) {
      reachable.add(targetId);
      queue.push(targetId);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const revEdges = graph.reverseEdges.get(current);
    if (!revEdges) continue;

    for (const edge of revEdges) {
      if (!reachable.has(edge.callerId)) {
        reachable.add(edge.callerId);
        queue.push(edge.callerId);
      }
    }
  }

  return reachable;
}

/**
 * Slice the graph to keep only nodes on paths from any sourceId to any targetId.
 * Forward reachable from sources ∩ backward reachable from targets.
 */
export function sliceGraph(
  graph: CallGraph,
  sourceIds: FunctionId[],
  targetIds: FunctionId[],
): CallGraph {
  // Compute backward-reachable from all targets.
  const backReachable = backwardReachable(graph, targetIds);

  // Compute forward-reachable from all sources.
  const fwdReachable = new Set<FunctionId>();
  const fwdQueue: FunctionId[] = [];
  for (const sourceId of sourceIds) {
    if (graph.nodes.has(sourceId)) {
      fwdReachable.add(sourceId);
      fwdQueue.push(sourceId);
    }
  }
  while (fwdQueue.length > 0) {
    const current = fwdQueue.shift()!;
    const fwdEdges = graph.forwardEdges.get(current);
    if (!fwdEdges) continue;
    for (const edge of fwdEdges) {
      if (!fwdReachable.has(edge.calleeId)) {
        fwdReachable.add(edge.calleeId);
        fwdQueue.push(edge.calleeId);
      }
    }
  }

  // Intersection: nodes on any source→target path
  const keepNodes = new Set<FunctionId>();
  for (const id of fwdReachable) {
    if (backReachable.has(id)) keepNodes.add(id);
  }

  // Build induced subgraph
  const sliced = createEmptyGraph();
  for (const id of keepNodes) {
    const node = graph.nodes.get(id)!;
    addNode(sliced, node);
  }
  for (const edge of graph.edges) {
    if (keepNodes.has(edge.callerId) && keepNodes.has(edge.calleeId)) {
      addEdge(sliced, edge);
    }
  }

  return sliced;
}
