import { describe, it, expect } from "vitest";
import { createEmptyGraph, addNode, addEdge } from "../types.js";
import { sliceGraph, mergeGraphs } from "../graph.js";
import type { FunctionNode, CallEdge } from "../types.js";

function makeNode(id: string, line = 1): FunctionNode {
  const [filePath, qualifiedName] = id.split("::");
  return { id, filePath, qualifiedName, line, isInstrumented: false };
}

function makeEdge(callerId: string, calleeId: string, line = 1): CallEdge {
  return { callerId, calleeId, kind: "direct", callLine: line };
}

describe("sliceGraph", () => {
  it("keeps only nodes on paths from source to target (diamond)", () => {
    // A → B → D
    // A → C → D
    // B → E (dead end, not on path to D)
    const graph = createEmptyGraph();
    const A = "f.ts::A";
    const B = "f.ts::B";
    const C = "f.ts::C";
    const D = "f.ts::D";
    const E = "f.ts::E";

    addNode(graph, makeNode(A));
    addNode(graph, makeNode(B));
    addNode(graph, makeNode(C));
    addNode(graph, makeNode(D));
    addNode(graph, makeNode(E));

    addEdge(graph, makeEdge(A, B));
    addEdge(graph, makeEdge(A, C));
    addEdge(graph, makeEdge(B, D));
    addEdge(graph, makeEdge(C, D));
    addEdge(graph, makeEdge(B, E));

    const sliced = sliceGraph(graph, [A], [D]);

    expect(sliced.nodes.has(A)).toBe(true);
    expect(sliced.nodes.has(B)).toBe(true);
    expect(sliced.nodes.has(C)).toBe(true);
    expect(sliced.nodes.has(D)).toBe(true);
    expect(sliced.nodes.has(E)).toBe(false);

    // 4 edges on paths A→D: A→B, A→C, B→D, C→D (not B→E)
    expect(sliced.edges).toHaveLength(4);
  });

  it("returns empty graph when target is unreachable", () => {
    const graph = createEmptyGraph();
    const A = "f.ts::A";
    const B = "f.ts::B";
    const C = "f.ts::C";

    addNode(graph, makeNode(A));
    addNode(graph, makeNode(B));
    addNode(graph, makeNode(C)); // C exists but no path from A

    addEdge(graph, makeEdge(A, B));

    const sliced = sliceGraph(graph, [A], [C]);

    // C is not reachable from A via forward edges, so no intersection
    expect(sliced.nodes.size).toBe(0);
    expect(sliced.edges).toHaveLength(0);
  });

  it("keeps all nodes on a linear chain", () => {
    const graph = createEmptyGraph();
    const A = "f.ts::A";
    const B = "f.ts::B";
    const C = "f.ts::C";

    addNode(graph, makeNode(A));
    addNode(graph, makeNode(B));
    addNode(graph, makeNode(C));

    addEdge(graph, makeEdge(A, B));
    addEdge(graph, makeEdge(B, C));

    const sliced = sliceGraph(graph, [A], [C]);

    expect(sliced.nodes.size).toBe(3);
    expect(sliced.nodes.has(A)).toBe(true);
    expect(sliced.nodes.has(B)).toBe(true);
    expect(sliced.nodes.has(C)).toBe(true);
    expect(sliced.edges).toHaveLength(2);
  });

  it("handles source == target (single node)", () => {
    const graph = createEmptyGraph();
    const A = "f.ts::A";
    addNode(graph, makeNode(A));

    const sliced = sliceGraph(graph, [A], [A]);

    expect(sliced.nodes.size).toBe(1);
    expect(sliced.nodes.has(A)).toBe(true);
    expect(sliced.edges).toHaveLength(0);
  });

  it("multi-source: union of paths from two sources to one target", () => {
    // S1 → M → T
    // S2 → T
    // S1 → X (dead end)
    const graph = createEmptyGraph();
    const S1 = "f.ts::S1";
    const S2 = "f.ts::S2";
    const M = "f.ts::M";
    const T = "f.ts::T";
    const X = "f.ts::X";

    addNode(graph, makeNode(S1));
    addNode(graph, makeNode(S2));
    addNode(graph, makeNode(M));
    addNode(graph, makeNode(T));
    addNode(graph, makeNode(X));

    addEdge(graph, makeEdge(S1, M));
    addEdge(graph, makeEdge(M, T));
    addEdge(graph, makeEdge(S2, T));
    addEdge(graph, makeEdge(S1, X));

    const sliced = sliceGraph(graph, [S1, S2], [T]);

    expect(sliced.nodes.has(S1)).toBe(true);
    expect(sliced.nodes.has(S2)).toBe(true);
    expect(sliced.nodes.has(M)).toBe(true);
    expect(sliced.nodes.has(T)).toBe(true);
    expect(sliced.nodes.has(X)).toBe(false);
    expect(sliced.edges).toHaveLength(3); // S1→M, M→T, S2→T
  });

  it("multi-target: union of paths from one source to two targets", () => {
    // A → B → T1
    // A → C → T2
    // A → D (dead end)
    const graph = createEmptyGraph();
    const A = "f.ts::A";
    const B = "f.ts::B";
    const C = "f.ts::C";
    const T1 = "f.ts::T1";
    const T2 = "f.ts::T2";
    const D = "f.ts::D";

    addNode(graph, makeNode(A));
    addNode(graph, makeNode(B));
    addNode(graph, makeNode(C));
    addNode(graph, makeNode(T1));
    addNode(graph, makeNode(T2));
    addNode(graph, makeNode(D));

    addEdge(graph, makeEdge(A, B));
    addEdge(graph, makeEdge(B, T1));
    addEdge(graph, makeEdge(A, C));
    addEdge(graph, makeEdge(C, T2));
    addEdge(graph, makeEdge(A, D));

    const sliced = sliceGraph(graph, [A], [T1, T2]);

    expect(sliced.nodes.has(A)).toBe(true);
    expect(sliced.nodes.has(B)).toBe(true);
    expect(sliced.nodes.has(C)).toBe(true);
    expect(sliced.nodes.has(T1)).toBe(true);
    expect(sliced.nodes.has(T2)).toBe(true);
    expect(sliced.nodes.has(D)).toBe(false);
    expect(sliced.edges).toHaveLength(4); // A→B, B→T1, A→C, C→T2
  });
});

describe("mergeGraphs", () => {
  it("merges two disjoint graphs", () => {
    const g1 = createEmptyGraph();
    addNode(g1, makeNode("a.ts::A"));
    addNode(g1, makeNode("a.ts::B"));
    addEdge(g1, makeEdge("a.ts::A", "a.ts::B"));

    const g2 = createEmptyGraph();
    addNode(g2, makeNode("b.ts::C"));
    addNode(g2, makeNode("b.ts::D"));
    addEdge(g2, makeEdge("b.ts::C", "b.ts::D"));

    const merged = mergeGraphs([g1, g2]);

    expect(merged.nodes.size).toBe(4);
    expect(merged.edges).toHaveLength(2);
  });

  it("deduplicates edges from overlapping graphs", () => {
    const g1 = createEmptyGraph();
    addNode(g1, makeNode("a.ts::A"));
    addNode(g1, makeNode("a.ts::B"));
    addEdge(g1, makeEdge("a.ts::A", "a.ts::B"));

    const g2 = createEmptyGraph();
    addNode(g2, makeNode("a.ts::A"));
    addNode(g2, makeNode("a.ts::B"));
    addNode(g2, makeNode("a.ts::C"));
    addEdge(g2, makeEdge("a.ts::A", "a.ts::B")); // duplicate
    addEdge(g2, makeEdge("a.ts::B", "a.ts::C"));

    const merged = mergeGraphs([g1, g2]);

    expect(merged.nodes.size).toBe(3);
    expect(merged.edges).toHaveLength(2); // A→B (once), B→C
  });
});
