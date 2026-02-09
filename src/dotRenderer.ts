import * as fs from "fs";
import * as path from "path";
import type { CallGraph, FunctionId, EdgeKind } from "./types.js";
import { parseFunctionId } from "./types.js";
import type { CodeownersRule } from "./codeowners.js";
import { buildCodeownersMap } from "./codeowners.js";

export interface DotOptions {
  repoRoot: string;
  sourceIds: Set<FunctionId>;
  targetIds: Set<FunctionId>;
  codeownersRules?: CodeownersRule[];
  includeSource?: boolean;
  editor?: string;
}

function escapeLabel(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function nodeIdToDot(id: FunctionId): string {
  // DOT identifiers: use quoted strings
  return `"${escapeLabel(id)}"`;
}

function shortFilePath(filePath: string, repoRoot: string): string {
  return path.relative(repoRoot, filePath);
}

function edgeStyle(kind: EdgeKind): string {
  switch (kind) {
    case "direct":
      return "";
    case "static-method":
      return ' [color="#6fa8dc"]';
    case "di-default":
      return ' [style="dashed" color="#b48ead" label="DI"]';
    case "instrument-wrapper":
      return ' [style="dotted" color="#888888"]';
    case "re-export":
      return ' [style="dotted" color="#ebcb8b" label="re-export"]';
  }
}

export function renderDot(graph: CallGraph, options: DotOptions): string {
  const lines: string[] = [];
  lines.push("digraph callpath {");
  lines.push("  rankdir=TB;");
  lines.push(
    '  node [shape=box fontname="Helvetica" fontsize=10 color="#cccccc" fontcolor="white"];',
  );
  lines.push('  edge [fontname="Helvetica" fontsize=8 color="#cccccc"];');
  lines.push("");

  // Group nodes by file
  const fileGroups = new Map<string, FunctionId[]>();
  for (const [id, node] of graph.nodes) {
    let group = fileGroups.get(node.filePath);
    if (!group) {
      group = [];
      fileGroups.set(node.filePath, group);
    }
    group.push(id);
  }

  let clusterIdx = 0;
  for (const [filePath, nodeIds] of fileGroups) {
    const relPath = shortFilePath(filePath, options.repoRoot);
    lines.push(`  subgraph cluster_${clusterIdx++} {`);
    lines.push(`    label="${escapeLabel(relPath)}";`);
    lines.push("    style=dashed;");
    lines.push('    color="#666666";');
    lines.push('    fontcolor="#999999";');
    lines.push("");

    for (const id of nodeIds) {
      const node = graph.nodes.get(id)!;
      const { qualifiedName } = parseFunctionId(id);
      const label = `${escapeLabel(qualifiedName)}\\n:${node.line}`;
      let attrs = `label="${label}"`;

      if (options.sourceIds.has(id)) {
        attrs += ' style="filled" fillcolor="#2d6a4f" fontcolor="white"';
      } else if (options.targetIds.has(id)) {
        attrs += ' style="filled" fillcolor="#a4243b" fontcolor="white"';
      } else if (node.isInstrumented) {
        attrs += ' style="filled" fillcolor="#5c4d1a" fontcolor="white"';
      }

      lines.push(`    ${nodeIdToDot(id)} [${attrs}];`);
    }
    lines.push("  }");
    lines.push("");
  }

  // Edges
  for (const edge of graph.edges) {
    const style = edgeStyle(edge.kind);
    lines.push(`  ${nodeIdToDot(edge.callerId)} -> ${nodeIdToDot(edge.calleeId)}${style};`);
  }

  lines.push("}");
  return lines.join("\n");
}

/**
 * Render the graph as a JSON-serializable object.
 */
export function renderJson(graph: CallGraph, options: DotOptions): object {
  // Build source snippet cache if requested
  const fileCache = new Map<string, string[]>();
  if (options.includeSource) {
    for (const node of graph.nodes.values()) {
      if (!fileCache.has(node.filePath)) {
        try {
          const content = fs.readFileSync(node.filePath, "utf-8");
          fileCache.set(node.filePath, content.split("\n"));
        } catch {
          // File may not exist (e.g. in tests)
        }
      }
    }
  }

  const nodes = Array.from(graph.nodes.values()).map((node) => {
    let sourceSnippet: string | undefined;
    if (options.includeSource) {
      const lines = fileCache.get(node.filePath);
      if (lines) {
        const startLine = Math.max(0, node.line - 1);
        const endLine = Math.min(lines.length, node.endLine ?? startLine + 30);
        sourceSnippet = lines.slice(startLine, endLine).join("\n");
      }
    }
    return {
      id: node.id,
      filePath: shortFilePath(node.filePath, options.repoRoot),
      qualifiedName: node.qualifiedName,
      line: node.line,
      isInstrumented: node.isInstrumented,
      isSource: options.sourceIds.has(node.id),
      isTarget: options.targetIds.has(node.id),
      ...(node.description ? { description: node.description } : {}),
      ...(node.signature ? { signature: node.signature } : {}),
      ...(sourceSnippet ? { sourceSnippet } : {}),
    };
  });

  const edges = graph.edges.map((edge) => ({
    from: edge.callerId,
    to: edge.calleeId,
    kind: edge.kind,
    callLine: edge.callLine,
  }));

  const result: Record<string, unknown> = { nodes, edges };

  if (options.includeSource) {
    result.repoRoot = options.repoRoot;
    if (options.editor) {
      result.editor = options.editor;
    }
  }

  if (options.codeownersRules && options.codeownersRules.length > 0) {
    const filePaths = [...new Set(nodes.map((n: { filePath: string }) => n.filePath))];
    const codeowners = buildCodeownersMap(filePaths, options.codeownersRules);
    if (Object.keys(codeowners).length > 0) {
      result.codeowners = codeowners;
    }
  }

  return result;
}
