import { describe, it, expect } from "vitest";
import { layoutGraph } from "../layout.js";
import { buildGraphData, makeGraphNode, makeGraphEdge } from "./fixtures.js";
import type { GraphData } from "../types.js";

describe("layoutGraph", () => {
  it("returns empty result for empty graph", () => {
    const result = layoutGraph({ nodes: [], edges: [] });
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
    expect(result.clusters).toHaveLength(0);
  });

  it("lays out simple A→B: 2 nodes, 1 edge, 2 clusters", () => {
    const data = buildGraphData(["src/a.ts::A->src/b.ts::B"]);
    const result = layoutGraph(data);
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(result.clusters).toHaveLength(2);
  });

  it("edge waypoints have at least 2 points", () => {
    const data = buildGraphData(["src/a.ts::A->src/b.ts::B"]);
    const result = layoutGraph(data);
    for (const edge of result.edges) {
      expect(edge.waypoints.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("all nodes have non-negative coordinates", () => {
    const data = buildGraphData(["src/a.ts::A->src/b.ts::B", "src/b.ts::B->src/c.ts::C"]);
    const result = layoutGraph(data);
    for (const node of result.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("collapsed files produce single node with isCollapsedGroup", () => {
    const data: GraphData = {
      nodes: [
        makeGraphNode({
          id: "f1::a",
          filePath: "src/f1.ts",
          qualifiedName: "a",
        }),
        makeGraphNode({
          id: "f1::b",
          filePath: "src/f1.ts",
          qualifiedName: "b",
        }),
        makeGraphNode({
          id: "f2::c",
          filePath: "src/f2.ts",
          qualifiedName: "c",
        }),
      ],
      edges: [makeGraphEdge("f1::a", "f1::b"), makeGraphEdge("f1::b", "f2::c")],
    };
    const result = layoutGraph(data, new Set(["src/f1.ts"]));
    const collapsed = result.nodes.find((n) => n.isCollapsedGroup);
    expect(collapsed).toBeDefined();
    expect(collapsed!.nodeCount).toBe(2);
    // Only the collapsed node + f2::c
    expect(result.nodes).toHaveLength(2);
  });

  it("graph with cycle has backedge marked", () => {
    const data: GraphData = {
      nodes: [
        makeGraphNode({
          id: "a",
          filePath: "src/a.ts",
          qualifiedName: "A",
          isSource: true,
        }),
        makeGraphNode({
          id: "b",
          filePath: "src/b.ts",
          qualifiedName: "B",
        }),
      ],
      edges: [makeGraphEdge("a", "b"), makeGraphEdge("b", "a")],
    };
    const result = layoutGraph(data);
    const backedges = result.edges.filter((e) => e.isBackedge);
    expect(backedges).toHaveLength(1);
  });

  it("clusters contain bounding boxes for their file", () => {
    const data = buildGraphData(["src/a.ts::A->src/a.ts::B", "src/a.ts::B->src/b.ts::C"]);
    const result = layoutGraph(data);
    const clusterA = result.clusters.find((c) => c.filePath === "src/a.ts");
    expect(clusterA).toBeDefined();
    expect(clusterA!.width).toBeGreaterThan(0);
    expect(clusterA!.height).toBeGreaterThan(0);
  });

  it("returns clusterOrder in layout result", () => {
    const data = buildGraphData(["src/a.ts::A->src/b.ts::B", "src/b.ts::B->src/c.ts::C"]);
    const result = layoutGraph(data);
    expect(result.clusterOrder).toBeDefined();
    expect(result.clusterOrder).toHaveLength(3);
    expect(result.clusterOrder).toContain("src/a.ts");
    expect(result.clusterOrder).toContain("src/b.ts");
    expect(result.clusterOrder).toContain("src/c.ts");
  });

  it("empty graph returns empty clusterOrder", () => {
    const result = layoutGraph({ nodes: [], edges: [] });
    expect(result.clusterOrder).toEqual([]);
  });
});

describe("layoutGraph cluster order stability", () => {
  // Build a 3-file graph: a.ts → b.ts → c.ts
  const threeFileData: GraphData = {
    nodes: [
      makeGraphNode({
        id: "a::fn",
        filePath: "src/a.ts",
        qualifiedName: "fnA",
        isSource: true,
      }),
      makeGraphNode({
        id: "b::fn1",
        filePath: "src/b.ts",
        qualifiedName: "fnB1",
      }),
      makeGraphNode({
        id: "b::fn2",
        filePath: "src/b.ts",
        qualifiedName: "fnB2",
      }),
      makeGraphNode({
        id: "c::fn",
        filePath: "src/c.ts",
        qualifiedName: "fnC",
        isTarget: true,
      }),
    ],
    edges: [
      makeGraphEdge("a::fn", "b::fn1"),
      makeGraphEdge("b::fn1", "b::fn2"),
      makeGraphEdge("b::fn2", "c::fn"),
    ],
  };

  it("collapsing a file preserves other clusters horizontal order", () => {
    // First layout: no collapse
    const initial = layoutGraph(threeFileData);

    // Get initial cluster X positions
    function clusterXMap(result: typeof initial) {
      const map = new Map<string, number>();
      for (const c of result.clusters) map.set(c.filePath, c.x);
      return map;
    }

    const initialX = clusterXMap(initial);

    // Collapse src/b.ts, passing previous cluster order
    const afterCollapse = layoutGraph(threeFileData, new Set(["src/b.ts"]), initial.clusterOrder);
    const afterCollapseX = clusterXMap(afterCollapse);

    // a.ts and c.ts should maintain their relative order
    const aBeforeCInitial = initialX.get("src/a.ts")! < initialX.get("src/c.ts")!;
    const aBeforeCAfter = afterCollapseX.get("src/a.ts")! < afterCollapseX.get("src/c.ts")!;
    expect(aBeforeCAfter).toBe(aBeforeCInitial);
  });

  it("cluster order from first layout is preserved through collapse/expand cycle", () => {
    // Initial layout
    const initial = layoutGraph(threeFileData);
    const initialOrder = initial.clusterOrder;

    // Collapse b.ts
    const collapsed = layoutGraph(threeFileData, new Set(["src/b.ts"]), initialOrder);

    // Expand again (no collapsed files), passing collapsed clusterOrder
    const expanded = layoutGraph(threeFileData, undefined, collapsed.clusterOrder);

    // The relative order of all three files should match the initial layout
    const initialAIdx = initialOrder.indexOf("src/a.ts");
    const initialBIdx = initialOrder.indexOf("src/b.ts");
    const initialCIdx = initialOrder.indexOf("src/c.ts");

    const expandedAIdx = expanded.clusterOrder.indexOf("src/a.ts");
    const expandedBIdx = expanded.clusterOrder.indexOf("src/b.ts");
    const expandedCIdx = expanded.clusterOrder.indexOf("src/c.ts");

    // Relative ordering should be the same
    expect(expandedAIdx < expandedBIdx).toBe(initialAIdx < initialBIdx);
    expect(expandedBIdx < expandedCIdx).toBe(initialBIdx < initialCIdx);
  });

  it("without previous order, layout still works correctly", () => {
    const result = layoutGraph(threeFileData);
    expect(result.nodes).toHaveLength(4);
    expect(result.clusters).toHaveLength(3);
    expect(result.clusterOrder).toHaveLength(3);
  });
});

describe("layoutGraph with LR direction", () => {
  it("produces valid layout for simple A→B", () => {
    const data = buildGraphData(["src/a.ts::A->src/b.ts::B"]);
    const result = layoutGraph(data, undefined, undefined, "LR");
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(result.clusters).toHaveLength(2);
  });

  it("all nodes have non-negative coordinates", () => {
    const data = buildGraphData(["src/a.ts::A->src/b.ts::B", "src/b.ts::B->src/c.ts::C"]);
    const result = layoutGraph(data, undefined, undefined, "LR");
    for (const node of result.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("edge waypoints have at least 2 points", () => {
    const data = buildGraphData(["src/a.ts::A->src/b.ts::B"]);
    const result = layoutGraph(data, undefined, undefined, "LR");
    for (const edge of result.edges) {
      expect(edge.waypoints.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("source node X < target node X (left-to-right flow)", () => {
    const data = buildGraphData(["src/a.ts::A->src/b.ts::B", "src/b.ts::B->src/c.ts::C"]);
    const result = layoutGraph(data, undefined, undefined, "LR");
    const nodeMap = new Map(result.nodes.map((n) => [n.id, n]));
    for (const edge of result.edges) {
      if (edge.isBackedge) continue;
      const fromNode = nodeMap.get(edge.from);
      const toNode = nodeMap.get(edge.to);
      if (fromNode && toNode) {
        expect(fromNode.x).toBeLessThan(toNode.x);
      }
    }
  });

  it("returns empty result for empty graph", () => {
    const result = layoutGraph({ nodes: [], edges: [] }, undefined, undefined, "LR");
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
    expect(result.clusters).toHaveLength(0);
  });

  it("returns clusterOrder in LR layout", () => {
    const data = buildGraphData(["src/a.ts::A->src/b.ts::B", "src/b.ts::B->src/c.ts::C"]);
    const result = layoutGraph(data, undefined, undefined, "LR");
    expect(result.clusterOrder).toBeDefined();
    expect(result.clusterOrder).toHaveLength(3);
  });

  it("collapsed files work in LR mode", () => {
    const data: GraphData = {
      nodes: [
        makeGraphNode({ id: "f1::a", filePath: "src/f1.ts", qualifiedName: "a" }),
        makeGraphNode({ id: "f1::b", filePath: "src/f1.ts", qualifiedName: "b" }),
        makeGraphNode({ id: "f2::c", filePath: "src/f2.ts", qualifiedName: "c" }),
      ],
      edges: [makeGraphEdge("f1::a", "f1::b"), makeGraphEdge("f1::b", "f2::c")],
    };
    const result = layoutGraph(data, new Set(["src/f1.ts"]), undefined, "LR");
    const collapsed = result.nodes.find((n) => n.isCollapsedGroup);
    expect(collapsed).toBeDefined();
    expect(collapsed!.nodeCount).toBe(2);
    expect(result.nodes).toHaveLength(2);
  });

  it("graph with cycle has backedge in LR mode", () => {
    const data: GraphData = {
      nodes: [
        makeGraphNode({ id: "a", filePath: "src/a.ts", qualifiedName: "A", isSource: true }),
        makeGraphNode({ id: "b", filePath: "src/b.ts", qualifiedName: "B" }),
      ],
      edges: [makeGraphEdge("a", "b"), makeGraphEdge("b", "a")],
    };
    const result = layoutGraph(data, undefined, undefined, "LR");
    const backedges = result.edges.filter((e) => e.isBackedge);
    expect(backedges).toHaveLength(1);
  });
});
