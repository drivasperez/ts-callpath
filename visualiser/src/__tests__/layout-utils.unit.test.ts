import { describe, it, expect } from "vitest";
import {
  detectBackedges,
  assignLayers,
  createDummyNodes,
  orderNodes,
  assignCoordinates,
  estimateNodeWidth,
  preprocessCollapsed,
  CHAR_WIDTH,
  NODE_PADDING_X,
  type InternalNode,
  type InternalEdge,
} from "../layout-utils.js";
import { makeGraphNode, makeGraphEdge } from "./fixtures.js";
import type { GraphData } from "../types.js";

// ── Helpers ──

function makeInternalNode(
  id: string,
  layer: number,
  filePath = "src/file.ts",
  opts: Partial<InternalNode> = {},
): InternalNode {
  return {
    id,
    original: makeGraphNode({ id, filePath, qualifiedName: id }),
    isDummy: false,
    layer,
    filePath,
    ...opts,
  };
}

function makeInternalEdge(
  from: string,
  to: string,
  index: number,
  opts: Partial<InternalEdge> = {},
): InternalEdge {
  return {
    from,
    to,
    kind: "direct",
    isBackedge: false,
    originalEdgeIndex: index,
    ...opts,
  };
}

// ── Tests ──

describe("detectBackedges", () => {
  it("finds no backedges in A→B→C", () => {
    const nodeIds = ["A", "B", "C"];
    const edges = [
      { from: "A", to: "B" },
      { from: "B", to: "C" },
    ];
    const result = detectBackedges(nodeIds, edges, new Set(["A"]));
    expect(result.size).toBe(0);
  });

  it("detects A→B→A cycle", () => {
    const nodeIds = ["A", "B"];
    const edges = [
      { from: "A", to: "B" },
      { from: "B", to: "A" },
    ];
    const result = detectBackedges(nodeIds, edges, new Set(["A"]));
    expect(result.size).toBe(1);
    expect(result.has(1)).toBe(true); // edge index 1 is B→A
  });

  it("detects longer cycle A→B→C→A", () => {
    const nodeIds = ["A", "B", "C"];
    const edges = [
      { from: "A", to: "B" },
      { from: "B", to: "C" },
      { from: "C", to: "A" },
    ];
    const result = detectBackedges(nodeIds, edges, new Set(["A"]));
    expect(result.size).toBe(1);
    expect(result.has(2)).toBe(true); // C→A
  });

  it("diamond DAG has no backedges", () => {
    const nodeIds = ["A", "B", "C", "D"];
    const edges = [
      { from: "A", to: "B" },
      { from: "A", to: "C" },
      { from: "B", to: "D" },
      { from: "C", to: "D" },
    ];
    const result = detectBackedges(nodeIds, edges, new Set(["A"]));
    expect(result.size).toBe(0);
  });

  it("starts DFS from source nodes first", () => {
    // Without source priority, the backedge detection might differ
    const nodeIds = ["X", "A", "B"];
    const edges = [
      { from: "A", to: "B" },
      { from: "B", to: "X" },
      { from: "X", to: "A" },
    ];
    // With A as source, the DFS starts from A
    const result = detectBackedges(nodeIds, edges, new Set(["A"]));
    expect(result.size).toBe(1);
    // X→A is the backedge when starting DFS from A
    expect(result.has(2)).toBe(true);
  });
});

describe("assignLayers", () => {
  it("assigns layer 0 for sources (no predecessors)", () => {
    const layers = assignLayers(["A", "B"], [{ from: "A", to: "B" }]);
    expect(layers.get("A")).toBe(0);
  });

  it("assigns sequential layers on linear chain", () => {
    const layers = assignLayers(
      ["A", "B", "C"],
      [
        { from: "A", to: "B" },
        { from: "B", to: "C" },
      ],
    );
    expect(layers.get("A")).toBe(0);
    expect(layers.get("B")).toBe(1);
    expect(layers.get("C")).toBe(2);
  });

  it("uses longest-path for diamond graph", () => {
    // A→B→D and A→C→D — D should be at layer 2
    const layers = assignLayers(
      ["A", "B", "C", "D"],
      [
        { from: "A", to: "B" },
        { from: "A", to: "C" },
        { from: "B", to: "D" },
        { from: "C", to: "D" },
      ],
    );
    expect(layers.get("A")).toBe(0);
    expect(layers.get("B")).toBe(1);
    expect(layers.get("C")).toBe(1);
    expect(layers.get("D")).toBe(2);
  });

  it("handles isolated node at layer 0", () => {
    const layers = assignLayers(["A", "B", "ALONE"], [{ from: "A", to: "B" }]);
    expect(layers.get("ALONE")).toBe(0);
  });
});

describe("createDummyNodes", () => {
  it("creates no dummies for span-1 edge", () => {
    const nodes = new Map<string, InternalNode>([
      ["A", makeInternalNode("A", 0)],
      ["B", makeInternalNode("B", 1)],
    ]);
    const edges = [makeInternalEdge("A", "B", 0)];
    const result = createDummyNodes(nodes, edges);
    expect(result.nodes.size).toBe(2);
    expect(result.edges).toHaveLength(1);
  });

  it("creates one dummy for span-2 edge", () => {
    const nodes = new Map<string, InternalNode>([
      ["A", makeInternalNode("A", 0)],
      ["B", makeInternalNode("B", 2)],
    ]);
    const edges = [makeInternalEdge("A", "B", 0)];
    const result = createDummyNodes(nodes, edges);
    // A → dummy → B: 3 nodes, 2 edges
    expect(result.nodes.size).toBe(3);
    expect(result.edges).toHaveLength(2);
    // The dummy should be at layer 1
    const dummies = [...result.nodes.values()].filter((n) => n.isDummy);
    expect(dummies).toHaveLength(1);
    expect(dummies[0].layer).toBe(1);
  });

  it("creates N-1 dummies for span-N edge", () => {
    const nodes = new Map<string, InternalNode>([
      ["A", makeInternalNode("A", 0)],
      ["B", makeInternalNode("B", 5)],
    ]);
    const edges = [makeInternalEdge("A", "B", 0)];
    const result = createDummyNodes(nodes, edges);
    // span is 5, so 4 dummies
    const dummies = [...result.nodes.values()].filter((n) => n.isDummy);
    expect(dummies).toHaveLength(4);
    expect(result.edges).toHaveLength(5);
  });

  it("passes backedges through unchanged", () => {
    const nodes = new Map<string, InternalNode>([
      ["A", makeInternalNode("A", 0)],
      ["B", makeInternalNode("B", 2)],
    ]);
    const edges = [makeInternalEdge("B", "A", 0, { isBackedge: true })];
    const result = createDummyNodes(nodes, edges);
    expect(result.nodes.size).toBe(2); // no dummies added
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].isBackedge).toBe(true);
  });
});

describe("estimateNodeWidth", () => {
  it("returns 0 for dummy nodes", () => {
    const dummy: InternalNode = {
      id: "__dummy_0",
      original: null,
      isDummy: true,
      layer: 1,
      filePath: "src/file.ts",
    };
    expect(estimateNodeWidth(dummy)).toBe(0);
  });

  it("returns correct width for normal node", () => {
    const node = makeInternalNode("A", 0);
    // label is "A:1" = 3 chars
    const expected = 3 * CHAR_WIDTH + NODE_PADDING_X * 2;
    expect(estimateNodeWidth(node)).toBe(expected);
  });

  it("returns correct width for collapsed node", () => {
    const node: InternalNode = {
      id: "__collapsed:src/foo.ts",
      original: makeGraphNode({ id: "__collapsed:src/foo.ts", filePath: "src/foo.ts" }),
      isDummy: false,
      layer: 0,
      filePath: "src/foo.ts",
      collapsedCount: 3,
    };
    // label is "foo.ts (3)" = 10 chars
    const expected = 10 * CHAR_WIDTH + NODE_PADDING_X * 2;
    expect(estimateNodeWidth(node)).toBe(expected);
  });

  it("uses full package name for collapsed external node", () => {
    const node: InternalNode = {
      id: "__collapsed:<external>::@opentelemetry/api",
      original: makeGraphNode({
        id: "__collapsed:<external>::@opentelemetry/api",
        filePath: "<external>::@opentelemetry/api",
        isExternal: true,
      }),
      isDummy: false,
      layer: 0,
      filePath: "<external>::@opentelemetry/api",
      collapsedCount: 5,
    };
    // label is "@opentelemetry/api (5)" = 22 chars
    const expected = 22 * CHAR_WIDTH + NODE_PADDING_X * 2;
    expect(estimateNodeWidth(node)).toBe(expected);
  });

  it("omits :line suffix for external node", () => {
    const node = makeInternalNode("createHash", 0, "<external>::crypto", {
      original: makeGraphNode({
        id: "createHash",
        qualifiedName: "createHash",
        isExternal: true,
        line: 0,
      }),
    });
    // label is "createHash" = 10 chars (no ":0")
    const expected = 10 * CHAR_WIDTH + NODE_PADDING_X * 2;
    expect(estimateNodeWidth(node)).toBe(expected);
  });
});

describe("preprocessCollapsed", () => {
  const data: GraphData = {
    nodes: [
      makeGraphNode({ id: "a", filePath: "src/a.ts", qualifiedName: "funcA" }),
      makeGraphNode({ id: "b", filePath: "src/a.ts", qualifiedName: "funcB" }),
      makeGraphNode({ id: "c", filePath: "src/b.ts", qualifiedName: "funcC" }),
    ],
    edges: [makeGraphEdge("a", "b"), makeGraphEdge("a", "c"), makeGraphEdge("b", "c")],
  };

  it("replaces file nodes with single synthetic node", () => {
    const result = preprocessCollapsed(data, new Set(["src/a.ts"]));
    const syntheticNode = result.data.nodes.find((n) => n.id === "__collapsed:src/a.ts");
    expect(syntheticNode).toBeDefined();
    // Original a and b should be gone
    expect(result.data.nodes.find((n) => n.id === "a")).toBeUndefined();
    expect(result.data.nodes.find((n) => n.id === "b")).toBeUndefined();
    // c should still exist
    expect(result.data.nodes.find((n) => n.id === "c")).toBeDefined();
  });

  it("remaps edges to synthetic node", () => {
    const result = preprocessCollapsed(data, new Set(["src/a.ts"]));
    // Should have edge from __collapsed:src/a.ts → c
    const edgeToC = result.data.edges.find((e) => e.to === "c");
    expect(edgeToC?.from).toBe("__collapsed:src/a.ts");
  });

  it("removes self-loops after collapse", () => {
    const result = preprocessCollapsed(data, new Set(["src/a.ts"]));
    // a→b was within same file, should become self-loop and be removed
    const selfLoops = result.data.edges.filter((e) => e.from === e.to);
    expect(selfLoops).toHaveLength(0);
  });

  it("preserves uncollapsed nodes", () => {
    const result = preprocessCollapsed(data, new Set(["src/a.ts"]));
    expect(result.data.nodes.find((n) => n.id === "c")).toBeDefined();
  });

  it("reports correct collapsed counts", () => {
    const result = preprocessCollapsed(data, new Set(["src/a.ts"]));
    expect(result.collapsedCounts.get("src/a.ts")).toBe(2);
  });

  it("deduplicates remapped edges", () => {
    // Both a→c and b→c become __collapsed:src/a.ts→c
    const result = preprocessCollapsed(data, new Set(["src/a.ts"]));
    const edgesToC = result.data.edges.filter((e) => e.to === "c");
    expect(edgesToC).toHaveLength(1);
  });
});

describe("assignCoordinates with previousClusterOrder", () => {
  // Build a 3-file graph: A(src/a.ts) → B(src/b.ts) → C(src/c.ts)
  function buildThreeFileGraph() {
    const nodes = new Map<string, InternalNode>([
      ["A", makeInternalNode("A", 0, "src/a.ts")],
      ["B", makeInternalNode("B", 1, "src/b.ts")],
      ["C", makeInternalNode("C", 2, "src/c.ts")],
    ]);
    const edges: InternalEdge[] = [makeInternalEdge("A", "B", 0), makeInternalEdge("B", "C", 1)];
    return { nodes, edges };
  }

  it("returns clusterOrder reflecting file positions", () => {
    const { nodes } = buildThreeFileGraph();
    const order = new Map<string, number>([
      ["A", 0],
      ["B", 0],
      ["C", 0],
    ]);
    const result = assignCoordinates(nodes, order, 2);
    expect(result.clusterOrder).toContain("src/a.ts");
    expect(result.clusterOrder).toContain("src/b.ts");
    expect(result.clusterOrder).toContain("src/c.ts");
    expect(result.clusterOrder).toHaveLength(3);
  });

  it("preserves previous cluster order for existing clusters", () => {
    const { nodes } = buildThreeFileGraph();
    const order = new Map<string, number>([
      ["A", 0],
      ["B", 0],
      ["C", 0],
    ]);
    // Force a specific previous order: c, a, b
    const previousOrder = ["src/c.ts", "src/a.ts", "src/b.ts"];
    const result = assignCoordinates(nodes, order, 2, previousOrder);
    expect(result.clusterOrder).toEqual(["src/c.ts", "src/a.ts", "src/b.ts"]);
  });

  it("filters out removed clusters from previous order", () => {
    const { nodes } = buildThreeFileGraph();
    const order = new Map<string, number>([
      ["A", 0],
      ["B", 0],
      ["C", 0],
    ]);
    // Previous order includes a file that no longer exists
    const previousOrder = ["src/removed.ts", "src/c.ts", "src/a.ts", "src/b.ts"];
    const result = assignCoordinates(nodes, order, 2, previousOrder);
    expect(result.clusterOrder).not.toContain("src/removed.ts");
    expect(result.clusterOrder).toEqual(["src/c.ts", "src/a.ts", "src/b.ts"]);
  });

  it("inserts new clusters at natural position", () => {
    const { nodes } = buildThreeFileGraph();
    const order = new Map<string, number>([
      ["A", 0],
      ["B", 0],
      ["C", 0],
    ]);
    // Previous order only had a and c; b is "new"
    const previousOrder = ["src/a.ts", "src/c.ts"];
    const result = assignCoordinates(nodes, order, 2, previousOrder);
    // a and c should keep their relative order; b should be inserted
    expect(result.clusterOrder.indexOf("src/a.ts")).toBeLessThan(
      result.clusterOrder.indexOf("src/c.ts"),
    );
    expect(result.clusterOrder).toContain("src/b.ts");
  });

  it("without previous order, derives order from layer scan", () => {
    const { nodes } = buildThreeFileGraph();
    const order = new Map<string, number>([
      ["A", 0],
      ["B", 0],
      ["C", 0],
    ]);
    const result = assignCoordinates(nodes, order, 2);
    // Without previous order, should derive naturally from layer scan
    expect(result.clusterOrder).toHaveLength(3);
  });
});

describe("orderNodes with previousClusterOrder", () => {
  it("uses previous order for initial sort instead of alphabetical", () => {
    // Two files: src/z.ts and src/a.ts. Alphabetically z > a,
    // but with previousClusterOrder [z, a], z should come first.
    const nodes = new Map<string, InternalNode>([
      ["Z1", makeInternalNode("Z1", 0, "src/z.ts")],
      ["A1", makeInternalNode("A1", 0, "src/a.ts")],
    ]);
    const edges: InternalEdge[] = [];

    // Without previous order: alphabetical (a before z)
    const orderWithout = orderNodes(nodes, edges, 0);
    expect(orderWithout.get("A1")!).toBeLessThan(orderWithout.get("Z1")!);

    // With previous order [z, a]: z should come first
    const orderWith = orderNodes(nodes, edges, 0, ["src/z.ts", "src/a.ts"]);
    expect(orderWith.get("Z1")!).toBeLessThan(orderWith.get("A1")!);
  });
});

describe("assignCoordinates LR", () => {
  function buildThreeLayerGraph() {
    const nodes = new Map<string, InternalNode>([
      ["A", makeInternalNode("A", 0, "src/a.ts")],
      ["B", makeInternalNode("B", 1, "src/b.ts")],
      ["C", makeInternalNode("C", 2, "src/c.ts")],
    ]);
    const edges: InternalEdge[] = [makeInternalEdge("A", "B", 0), makeInternalEdge("B", "C", 1)];
    return { nodes, edges };
  }

  it("nodes in different layers get different X positions (increasing left-to-right)", () => {
    const { nodes } = buildThreeLayerGraph();
    const order = new Map<string, number>([
      ["A", 0],
      ["B", 0],
      ["C", 0],
    ]);
    const result = assignCoordinates(nodes, order, 2, undefined, "LR");
    const posA = result.positioned.find((p) => p.id === "A")!;
    const posB = result.positioned.find((p) => p.id === "B")!;
    const posC = result.positioned.find((p) => p.id === "C")!;
    expect(posA.x).toBeLessThan(posB.x);
    expect(posB.x).toBeLessThan(posC.x);
  });

  it("nodes in different clusters get different Y positions", () => {
    const { nodes } = buildThreeLayerGraph();
    const order = new Map<string, number>([
      ["A", 0],
      ["B", 0],
      ["C", 0],
    ]);
    const result = assignCoordinates(nodes, order, 2, undefined, "LR");
    const posA = result.positioned.find((p) => p.id === "A")!;
    const posB = result.positioned.find((p) => p.id === "B")!;
    const posC = result.positioned.find((p) => p.id === "C")!;
    // All three are in different files, so different Y
    const ys = new Set([posA.y, posB.y, posC.y]);
    expect(ys.size).toBe(3);
  });

  it("cluster order is preserved with previousClusterOrder", () => {
    const { nodes } = buildThreeLayerGraph();
    const order = new Map<string, number>([
      ["A", 0],
      ["B", 0],
      ["C", 0],
    ]);
    const previousOrder = ["src/c.ts", "src/a.ts", "src/b.ts"];
    const result = assignCoordinates(nodes, order, 2, previousOrder, "LR");
    expect(result.clusterOrder).toEqual(["src/c.ts", "src/a.ts", "src/b.ts"]);
  });

  it("returns clusterOrder reflecting file positions", () => {
    const { nodes } = buildThreeLayerGraph();
    const order = new Map<string, number>([
      ["A", 0],
      ["B", 0],
      ["C", 0],
    ]);
    const result = assignCoordinates(nodes, order, 2, undefined, "LR");
    expect(result.clusterOrder).toContain("src/a.ts");
    expect(result.clusterOrder).toContain("src/b.ts");
    expect(result.clusterOrder).toContain("src/c.ts");
    expect(result.clusterOrder).toHaveLength(3);
  });

  it("nodes in same layer but different files are stacked vertically", () => {
    // Two nodes in the same layer but different files
    const nodes = new Map<string, InternalNode>([
      ["X", makeInternalNode("X", 0, "src/x.ts")],
      ["Y", makeInternalNode("Y", 0, "src/y.ts")],
    ]);
    const order = new Map<string, number>([
      ["X", 0],
      ["Y", 1],
    ]);
    const result = assignCoordinates(nodes, order, 0, undefined, "LR");
    const posX = result.positioned.find((p) => p.id === "X")!;
    const posY = result.positioned.find((p) => p.id === "Y")!;
    // Same layer → same X column, different file → different Y
    expect(posX.x).toBe(posY.x);
    expect(posX.y).not.toBe(posY.y);
  });
});
