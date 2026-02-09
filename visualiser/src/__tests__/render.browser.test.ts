import { describe, it, expect, beforeEach } from "vitest";
import { createNodeEl, createEdgeEl, createClusterEl } from "../render.js";
import { renderGraph } from "../render.js";
import { layoutGraph } from "../layout.js";
import { COLORS } from "../render-utils.js";
import { makeLayoutNode, makeGraphNode, makeGraphEdge } from "./fixtures.js";
import type { LayoutEdge, LayoutCluster, GraphData } from "../types.js";

const noopTooltip = {
  show: () => {},
  hide: () => {},
};

// ── createNodeEl ──

describe("createNodeEl", () => {
  it("creates <g> with class=node-group", () => {
    const node = makeLayoutNode({ id: "test-node" });
    const el = createNodeEl(node, noopTooltip);
    expect(el.tagName.toLowerCase()).toBe("g");
    expect(el.classList.contains("node-group")).toBe(true);
  });

  it("sets data-id attribute", () => {
    const node = makeLayoutNode({ id: "my-node" });
    const el = createNodeEl(node, noopTooltip);
    expect(el.getAttribute("data-id")).toBe("my-node");
  });

  it("sets transform to node position", () => {
    const node = makeLayoutNode({ id: "n", x: 100, y: 200 });
    const el = createNodeEl(node, noopTooltip);
    expect(el.getAttribute("transform")).toBe("translate(100, 200)");
  });

  it("contains <rect> with correct width/height", () => {
    const node = makeLayoutNode({ id: "n", width: 150, height: 28 });
    const el = createNodeEl(node, noopTooltip);
    const rect = el.querySelector("rect");
    expect(rect).not.toBeNull();
    expect(rect!.getAttribute("width")).toBe("150");
    expect(rect!.getAttribute("height")).toBe("28");
  });

  it("contains <text> with node label", () => {
    const node = makeLayoutNode({
      id: "n",
      original: makeGraphNode({
        id: "n",
        qualifiedName: "MyFunc",
        line: 10,
      }),
    });
    const el = createNodeEl(node, noopTooltip);
    const text = el.querySelector("text");
    expect(text).not.toBeNull();
    expect(text!.textContent).toBe("MyFunc:10");
  });

  it("source node has source fill", () => {
    const node = makeLayoutNode({
      id: "n",
      original: makeGraphNode({ id: "n", isSource: true }),
    });
    const el = createNodeEl(node, noopTooltip);
    const rect = el.querySelector("rect");
    expect(rect!.getAttribute("fill")).toBe(COLORS.source);
  });

  it("does not show signature text in node (moved to details panel)", () => {
    const node = makeLayoutNode({
      id: "n",
      width: 200,
      original: makeGraphNode({
        id: "n",
        qualifiedName: "foo",
        line: 1,
        signature: "(x: number) => void",
      }),
    });
    const el = createNodeEl(node, noopTooltip);
    const texts = el.querySelectorAll("text");
    // Should have only 1 text element: the label (signature is in details panel now)
    expect(texts.length).toBe(1);
  });
});

// ── createEdgeEl ──

describe("createEdgeEl", () => {
  const simpleEdge: LayoutEdge = {
    from: "a",
    to: "b",
    kind: "direct",
    isBackedge: false,
    waypoints: [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
    ],
  };

  it("creates <g> with class=edge-group", () => {
    const el = createEdgeEl(simpleEdge);
    expect(el.tagName.toLowerCase()).toBe("g");
    expect(el.classList.contains("edge-group")).toBe(true);
  });

  it("contains transparent hitbox <path> with stroke-width=10", () => {
    const el = createEdgeEl(simpleEdge);
    const paths = el.querySelectorAll("path");
    // First path is the hitbox
    const hitbox = paths[0];
    expect(hitbox.getAttribute("stroke")).toBe("transparent");
    expect(hitbox.getAttribute("stroke-width")).toBe("10");
  });

  it("contains visible <path> with correct color", () => {
    const el = createEdgeEl(simpleEdge);
    const paths = el.querySelectorAll("path");
    // Second path is the visible line
    const visible = paths[1];
    expect(visible.getAttribute("stroke")).toBe(COLORS.edgeDirect);
  });

  it("backedge uses red color", () => {
    const backedge: LayoutEdge = {
      ...simpleEdge,
      isBackedge: true,
    };
    const el = createEdgeEl(backedge);
    const paths = el.querySelectorAll("path");
    const visible = paths[1];
    expect(visible.getAttribute("stroke")).toBe(COLORS.backedge);
  });
});

// ── createClusterEl ──

describe("createClusterEl", () => {
  const cluster: LayoutCluster = {
    filePath: "src/utils/helper.ts",
    x: 10,
    y: 20,
    width: 200,
    height: 100,
  };

  it("creates <g> with data-filepath", () => {
    const el = createClusterEl(cluster, false);
    expect(el.getAttribute("data-filepath")).toBe("src/utils/helper.ts");
  });

  it("contains <rect> and <text> label", () => {
    const el = createClusterEl(cluster, false);
    expect(el.querySelector("rect")).not.toBeNull();
    const text = el.querySelector("text");
    expect(text).not.toBeNull();
    expect(text!.textContent).toContain("helper.ts");
  });

  it("collapsed shows ▸ indicator", () => {
    const el = createClusterEl(cluster, true);
    const text = el.querySelector("text");
    expect(text!.textContent).toContain("▸");
  });

  it("expanded shows ▾ indicator", () => {
    const el = createClusterEl(cluster, false);
    const text = el.querySelector("text");
    expect(text!.textContent).toContain("▾");
  });
});

// ── renderGraph integration ──

describe("renderGraph integration", () => {
  let container: HTMLElement;

  beforeEach(() => {
    // Clean up DOM
    document.body.innerHTML = "";
    container = document.createElement("div");
    container.id = "graph-container";
    document.body.appendChild(container);
  });

  function makeSimpleGraphData(): GraphData {
    return {
      nodes: [
        makeGraphNode({
          id: "a",
          filePath: "src/a.ts",
          qualifiedName: "funcA",
          isSource: true,
        }),
        makeGraphNode({
          id: "b",
          filePath: "src/b.ts",
          qualifiedName: "funcB",
          isTarget: true,
        }),
      ],
      edges: [makeGraphEdge("a", "b")],
    };
  }

  it("renders full graph into container element", () => {
    const data = makeSimpleGraphData();
    const layout = layoutGraph(data);
    renderGraph(container, layout, data);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("node count matches graph data", () => {
    const data = makeSimpleGraphData();
    const layout = layoutGraph(data);
    renderGraph(container, layout, data);
    const nodeEls = container.querySelectorAll(".node-group");
    expect(nodeEls.length).toBe(data.nodes.length);
  });

  it("edge count matches graph data", () => {
    const data = makeSimpleGraphData();
    const layout = layoutGraph(data);
    renderGraph(container, layout, data);
    const edgeEls = container.querySelectorAll(".edge-group");
    expect(edgeEls.length).toBe(data.edges.length);
  });

  it('keyboard shortcut "f" triggers fit-all (sets window.__fitAll)', () => {
    const data = makeSimpleGraphData();
    const layout = layoutGraph(data);
    renderGraph(container, layout, data);
    // renderGraph sets window.__fitAll
    expect(typeof (window as any).__fitAll).toBe("function");
  });

  it('search overlay opens on "/" key', () => {
    const data = makeSimpleGraphData();
    const layout = layoutGraph(data);
    renderGraph(container, layout, data);
    // Dispatch "/" keydown
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
    const searchOverlay = document.getElementById("search-overlay");
    expect(searchOverlay).not.toBeNull();
    expect(searchOverlay!.style.display).toBe("block");
  });

  it("updateLayout updates both hitbox and visible edge paths on direction toggle", () => {
    const data: GraphData = {
      nodes: [
        makeGraphNode({ id: "a", filePath: "src/a.ts", qualifiedName: "funcA", isSource: true }),
        makeGraphNode({ id: "b", filePath: "src/b.ts", qualifiedName: "funcB", isTarget: true }),
      ],
      edges: [makeGraphEdge("a", "b")],
    };
    const layout = layoutGraph(data);
    renderGraph(container, layout, data);

    // Capture initial path `d` attributes for both hitbox and visible paths
    const edgeGroup = container.querySelector(".edge-group")!;
    const paths = edgeGroup.querySelectorAll("path");
    expect(paths.length).toBe(2); // hitbox + visible
    const initialHitboxD = paths[0].getAttribute("d");
    const initialVisibleD = paths[1].getAttribute("d");
    expect(initialHitboxD).toBeTruthy();
    expect(initialVisibleD).toBeTruthy();
    // Both paths should have the same `d` (same route, different styling)
    expect(initialHitboxD).toBe(initialVisibleD);

    // Toggle direction LR → TB, which triggers relayout + updateLayout
    const toggle = (window as any).__toggleDirection;
    expect(typeof toggle).toBe("function");
    toggle();

    // After relayout, both paths must have updated `d` attributes
    const updatedHitboxD = paths[0].getAttribute("d");
    const updatedVisibleD = paths[1].getAttribute("d");
    expect(updatedHitboxD).toBeTruthy();
    expect(updatedVisibleD).toBeTruthy();
    // The new paths should differ from the TB layout
    expect(updatedHitboxD).not.toBe(initialHitboxD);
    expect(updatedVisibleD).not.toBe(initialVisibleD);
    // Both paths (hitbox + visible) must match each other after update
    expect(updatedHitboxD).toBe(updatedVisibleD);
  });
});
