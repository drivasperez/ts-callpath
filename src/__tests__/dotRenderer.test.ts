import { describe, it, expect } from 'vitest';
import { renderDot, renderJson } from '../dotRenderer.js';
import type { DotOptions } from '../dotRenderer.js';
import { createEmptyGraph, addNode, addEdge } from '../types.js';
import type { FunctionNode } from '../types.js';

function makeNode(
  id: string,
  line = 1,
  isInstrumented = false,
  extra?: { description?: string; signature?: string }
): FunctionNode {
  const [filePath, qualifiedName] = id.split('::');
  return { id, filePath, qualifiedName, line, isInstrumented, ...extra };
}

describe('renderDot', () => {
  const sourceId = '/repo/src/a.ts::main';
  const targetId = '/repo/src/b.ts::Worker.process';
  const options: DotOptions = {
    repoRoot: '/repo',
    sourceIds: new Set([sourceId]),
    targetIds: new Set([targetId]),
  };

  function buildSmallGraph() {
    const graph = createEmptyGraph();
    addNode(graph, makeNode(sourceId, 10));
    addNode(graph, makeNode(targetId, 20));
    addEdge(graph, {
      callerId: sourceId,
      calleeId: targetId,
      kind: 'direct',
      callLine: 15,
    });
    return graph;
  }

  it('produces valid DOT output', () => {
    const graph = buildSmallGraph();
    const dot = renderDot(graph, options);

    expect(dot).toContain('digraph callpath {');
    expect(dot).toContain('}');
    expect(dot).toContain('rankdir=TB');
  });

  it('contains subgraph clusters for files', () => {
    const graph = buildSmallGraph();
    const dot = renderDot(graph, options);

    expect(dot).toContain('subgraph cluster_');
    // Relative paths used as labels
    expect(dot).toContain('src/a.ts');
    expect(dot).toContain('src/b.ts');
  });

  it('colors source node green', () => {
    const graph = buildSmallGraph();
    const dot = renderDot(graph, options);

    expect(dot).toContain('fillcolor="#2d6a4f"');
  });

  it('colors target node pink', () => {
    const graph = buildSmallGraph();
    const dot = renderDot(graph, options);

    expect(dot).toContain('fillcolor="#a4243b"');
  });

  it('colors instrumented nodes yellow', () => {
    const graph = createEmptyGraph();
    const instrId = '/repo/src/c.ts::instrFn';
    addNode(graph, makeNode(sourceId, 10));
    addNode(graph, makeNode(targetId, 20));
    addNode(graph, makeNode(instrId, 30, true));
    addEdge(graph, {
      callerId: sourceId,
      calleeId: instrId,
      kind: 'direct',
      callLine: 15,
    });
    addEdge(graph, {
      callerId: instrId,
      calleeId: targetId,
      kind: 'direct',
      callLine: 35,
    });

    const dot = renderDot(graph, options);
    expect(dot).toContain('fillcolor="#5c4d1a"');
  });

  it('renders DI edges as dashed purple', () => {
    const graph = createEmptyGraph();
    addNode(graph, makeNode(sourceId, 10));
    addNode(graph, makeNode(targetId, 20));
    addEdge(graph, {
      callerId: sourceId,
      calleeId: targetId,
      kind: 'di-default',
      callLine: 15,
    });

    const dot = renderDot(graph, options);
    expect(dot).toContain('style="dashed"');
    expect(dot).toContain('color="#b48ead"');
    expect(dot).toContain('label="DI"');
  });

  it('renders re-export edges as dotted orange', () => {
    const graph = createEmptyGraph();
    addNode(graph, makeNode(sourceId, 10));
    addNode(graph, makeNode(targetId, 20));
    addEdge(graph, {
      callerId: sourceId,
      calleeId: targetId,
      kind: 're-export',
      callLine: 15,
    });

    const dot = renderDot(graph, options);
    expect(dot).toContain('style="dotted"');
    expect(dot).toContain('color="#ebcb8b"');
    expect(dot).toContain('label="re-export"');
  });
});

describe('renderJson', () => {
  it('outputs expected structure with isSource/isTarget flags', () => {
    const sourceId = '/repo/src/a.ts::main';
    const targetId = '/repo/src/b.ts::target';
    const options: DotOptions = {
      repoRoot: '/repo',
      sourceIds: new Set([sourceId]),
      targetIds: new Set([targetId]),
    };

    const graph = createEmptyGraph();
    addNode(graph, makeNode(sourceId, 10));
    addNode(graph, makeNode(targetId, 20));
    addEdge(graph, {
      callerId: sourceId,
      calleeId: targetId,
      kind: 'direct',
      callLine: 15,
    });

    const json = renderJson(graph, options) as {
      nodes: Array<{
        id: string;
        filePath: string;
        qualifiedName: string;
        line: number;
        isInstrumented: boolean;
        isSource: boolean;
        isTarget: boolean;
      }>;
      edges: Array<{
        from: string;
        to: string;
        kind: string;
        callLine: number;
      }>;
    };

    expect(json.nodes).toHaveLength(2);
    expect(json.edges).toHaveLength(1);

    const sourceNode = json.nodes.find((n) => n.id === sourceId)!;
    expect(sourceNode.isSource).toBe(true);
    expect(sourceNode.isTarget).toBe(false);
    // filePath should be relative
    expect(sourceNode.filePath).toBe('src/a.ts');

    const targetNode = json.nodes.find((n) => n.id === targetId)!;
    expect(targetNode.isSource).toBe(false);
    expect(targetNode.isTarget).toBe(true);

    expect(json.edges[0]).toMatchObject({
      from: sourceId,
      to: targetId,
      kind: 'direct',
      callLine: 15,
    });
  });

  it('includes signature in JSON output when present', () => {
    const sourceId = '/repo/src/a.ts::main';
    const targetId = '/repo/src/b.ts::target';
    const options: DotOptions = {
      repoRoot: '/repo',
      sourceIds: new Set([sourceId]),
      targetIds: new Set([targetId]),
    };

    const graph = createEmptyGraph();
    addNode(
      graph,
      makeNode(sourceId, 10, false, { signature: '(x: number): string' })
    );
    addNode(graph, makeNode(targetId, 20));
    addEdge(graph, {
      callerId: sourceId,
      calleeId: targetId,
      kind: 'direct',
      callLine: 15,
    });

    const json = renderJson(graph, options) as {
      nodes: Array<{ id: string; signature?: string }>;
    };

    const sourceNode = json.nodes.find((n) => n.id === sourceId)!;
    expect(sourceNode.signature).toBe('(x: number): string');

    const targetNode = json.nodes.find((n) => n.id === targetId)!;
    expect(targetNode.signature).toBeUndefined();
  });

  it('omits sourceSnippet when includeSource is not set', () => {
    const sourceId = '/repo/src/a.ts::main';
    const options: DotOptions = {
      repoRoot: '/repo',
      sourceIds: new Set([sourceId]),
      targetIds: new Set(),
    };

    const graph = createEmptyGraph();
    addNode(graph, makeNode(sourceId, 10));

    const json = renderJson(graph, options) as {
      nodes: Array<{ id: string; sourceSnippet?: string }>;
    };

    expect(json.nodes[0].sourceSnippet).toBeUndefined();
  });
});
