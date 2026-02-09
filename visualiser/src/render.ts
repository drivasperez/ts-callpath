import type {
  GraphData,
  GraphNode,
  LayoutDirection,
  LayoutResult,
  LayoutNode,
  LayoutEdge,
  LayoutCluster,
  GraphEdge,
} from "./types.js";
import { layoutGraph } from "./layout.js";
import {
  COLORS,
  TRANSITION_MS,
  teamColor,
  edgeColor,
  edgeDasharray,
  edgeLabel,
  nodeColor,
  buildOrthogonalPath,
  computeBounds,
  fileName,
  nodeLabel,
  filterByFocus,
  filterByHidden,
} from "./render-utils.js";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
// @ts-expect-error -- loaded as text by esbuild (text loader) and vite (?raw)
import hljsThemeDark from "highlight.js/styles/github-dark.css?raw";
// @ts-expect-error -- loaded as text by esbuild (text loader) and vite (?raw)
import hljsThemeLight from "highlight.js/styles/github.css?raw";

hljs.registerLanguage("typescript", typescript);

// ── SVG Helpers ────────────────────────────────────────────────────────────

export function svgEl(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  return el;
}

export function htmlEl(tag: string, attrs: Record<string, string> = {}): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

// ── Arrowhead Markers ──────────────────────────────────────────────────────

function createMarker(defs: SVGElement, id: string, color: string): void {
  const marker = svgEl("marker", {
    id,
    viewBox: "0 0 10 7",
    refX: 10,
    refY: 3.5,
    markerWidth: 8,
    markerHeight: 6,
    orient: "auto-start-reverse",
  });
  const polygon = svgEl("polygon", {
    points: "0 0, 10 3.5, 0 7",
    fill: color,
  });
  marker.appendChild(polygon);
  defs.appendChild(marker);
}

function markerIdForEdge(edge: { kind: string; isBackedge: boolean }): string {
  return edge.isBackedge ? "arrow-backedge" : `arrow-${edge.kind}`;
}

function ensureMarkers(defs: SVGElement, layout: LayoutResult): void {
  const existing = new Set<string>();
  for (const child of Array.from(defs.children)) {
    const id = child.getAttribute("id");
    if (id) existing.add(id);
  }
  for (const e of layout.edges) {
    const color = e.isBackedge ? COLORS.backedge : edgeColor(e.kind);
    const markerId = markerIdForEdge(e);
    if (!existing.has(markerId)) {
      createMarker(defs, markerId, color);
      existing.add(markerId);
    }
  }
}

// ── Context Menu ──────────────────────────────────────────────────────────

interface ContextMenuItem {
  icon: string;
  label: string;
  action: () => void;
  shortcut?: string;
}

function createContextMenu(): {
  show: (items: ContextMenuItem[], x: number, y: number) => void;
  hide: () => void;
} {
  const el = htmlEl("div", { id: "context-menu" });
  el.style.cssText = `
    position: fixed; display: none;
    background: var(--ctx-bg); border: 1px solid var(--ctx-border); border-radius: 6px;
    font: 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    z-index: 110; min-width: 160px; padding: 4px 0;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  `;
  document.body.appendChild(el);

  function hide() {
    el.style.display = "none";
    el.innerHTML = "";
  }

  function show(items: ContextMenuItem[], x: number, y: number) {
    el.innerHTML = "";
    for (const item of items) {
      const row = htmlEl("div");
      row.style.cssText = `
        display: flex; align-items: center; gap: 8px;
        padding: 6px 12px; cursor: pointer; color: var(--ctx-text);
      `;
      row.addEventListener("mouseenter", () => {
        row.style.background = "var(--ctx-hover-bg)";
        row.style.color = "var(--ctx-hover-text)";
      });
      row.addEventListener("mouseleave", () => {
        row.style.background = "none";
        row.style.color = "var(--ctx-text)";
      });

      const iconSpan = htmlEl("span");
      iconSpan.style.cssText = "width: 18px; text-align: center; flex-shrink: 0;";
      iconSpan.textContent = item.icon;
      row.appendChild(iconSpan);

      const labelSpan = htmlEl("span");
      labelSpan.textContent = item.label;
      row.appendChild(labelSpan);

      if (item.shortcut) {
        const shortcutSpan = htmlEl("span");
        shortcutSpan.textContent = item.shortcut;
        shortcutSpan.style.cssText = `
          margin-left: auto; font-size: 10px; color: var(--ctx-shortcut-text);
          background: var(--ctx-shortcut-bg); border: 1px solid var(--ctx-shortcut-border);
          border-radius: 3px; padding: 0 4px; line-height: 1.4;
        `;
        row.appendChild(shortcutSpan);
      }

      row.addEventListener("click", (e) => {
        e.stopPropagation();
        hide();
        item.action();
      });

      el.appendChild(row);
    }

    el.style.display = "block";
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;

    // Viewport clamping
    requestAnimationFrame(() => {
      const rect = el.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        el.style.left = `${window.innerWidth - rect.width - 4}px`;
      }
      if (rect.bottom > window.innerHeight) {
        el.style.top = `${window.innerHeight - rect.height - 4}px`;
      }
    });
  }

  return { show, hide };
}

// ── Tooltip ────────────────────────────────────────────────────────────────

function createTooltip(): {
  el: HTMLElement;
  show: (node: LayoutNode, x: number, y: number) => void;
  hide: () => void;
} {
  const el = htmlEl("div", { id: "tooltip" });
  el.style.cssText = `
    position: fixed; display: none; pointer-events: none;
    background: var(--tooltip-bg); color: var(--tooltip-text); padding: 8px 12px;
    border-radius: 4px; font: 11px monospace; z-index: 100;
    max-width: 400px; white-space: pre-wrap; border: 1px solid var(--tooltip-border);
  `;
  document.body.appendChild(el);

  return {
    el,
    show(node: LayoutNode, x: number, y: number) {
      if (node.isCollapsedGroup && node.original) {
        el.textContent = [
          `${node.original.filePath}`,
          `Collapsed: ${node.nodeCount} functions`,
          `Click cluster to expand`,
        ].join("\n");
      } else if (node.original) {
        const n = node.original;
        const flags: string[] = [];
        if (n.isSource) flags.push("SOURCE");
        if (n.isTarget) flags.push("TARGET");
        if (n.isInstrumented) flags.push("INSTRUMENTED");

        el.innerHTML = "";
        const meta = document.createElement("div");
        meta.style.whiteSpace = "pre-wrap";
        meta.textContent = [
          n.qualifiedName,
          `File: ${n.filePath}`,
          `Line: ${n.line}`,
          flags.length > 0 ? `Flags: ${flags.join(", ")}` : null,
        ]
          .filter(Boolean)
          .join("\n");
        el.appendChild(meta);

        if (n.description) {
          const desc = document.createElement("div");
          desc.style.cssText = `
            margin-top: 6px; padding: 5px 8px;
            background: var(--source-desc-bg);
            border-left: 3px solid var(--source-desc-border);
            border-radius: 2px;
            color: var(--source-desc-text);
            font-style: italic;
            white-space: pre-wrap;
          `;
          desc.textContent = n.description;
          el.appendChild(desc);
        }
      } else {
        return;
      }

      el.style.display = "block";
      el.style.left = `${x + 12}px`;
      el.style.top = `${y + 12}px`;
    },
    hide() {
      el.style.display = "none";
    },
  };
}

// ── Edge Tooltip ────────────────────────────────────────────────────────────

function createEdgeTooltip(): {
  el: HTMLElement;
  show: (edge: GraphEdge, isBackedge: boolean, x: number, y: number) => void;
  hide: () => void;
} {
  const el = htmlEl("div", { id: "edge-tooltip" });
  el.style.cssText = `
    position: fixed; display: none; pointer-events: none;
    background: var(--tooltip-bg); color: var(--tooltip-text); padding: 8px 12px;
    border-radius: 4px; font: 11px monospace; z-index: 100;
    max-width: 400px; white-space: pre-wrap; border: 1px solid var(--tooltip-border);
  `;
  document.body.appendChild(el);

  return {
    el,
    show(edge: GraphEdge, isBackedge: boolean, x: number, y: number) {
      const fromShort = edge.from.split("::").pop() ?? edge.from;
      const toShort = edge.to.split("::").pop() ?? edge.to;
      const lines: string[] = [
        `${fromShort} \u2192 ${toShort}`,
        `Kind: ${edge.kind}`,
        `Called at line ${edge.callLine}`,
      ];
      if (isBackedge) lines.push("Backedge (cycle)");
      el.textContent = lines.join("\n");
      el.style.display = "block";
      el.style.left = `${x + 12}px`;
      el.style.top = `${y + 12}px`;
    },
    hide() {
      el.style.display = "none";
    },
  };
}

// ── Source Preview Panel ────────────────────────────────────────────────────

let hljsThemeInjected = false;

function createSourcePanel(data: GraphData): {
  show: (node: GraphNode) => void;
  hide: () => void;
  el: HTMLElement;
} {
  const savedWidth = localStorage.getItem("ts-callpath-source-width");
  const defaultWidth = savedWidth ? `${savedWidth}px` : "600px";

  const el = htmlEl("div", { id: "source-panel" });
  el.style.cssText = `
    position: fixed; right: 0; top: 50px; bottom: 0; width: ${defaultWidth};
    background: var(--source-bg); border-left: 1px solid var(--panel-border);
    display: none; flex-direction: column; z-index: 25;
    font: 12px monospace; color: var(--panel-text);
  `;

  // Resize handle on the left edge
  const resizeHandle = htmlEl("div");
  resizeHandle.style.cssText = `
    position: absolute; left: 0; top: 0; bottom: 0; width: 5px;
    cursor: col-resize; z-index: 1;
  `;
  el.appendChild(resizeHandle);

  resizeHandle.addEventListener("mousedown", (e: MouseEvent) => {
    e.preventDefault();
    const onMouseMove = (ev: MouseEvent) => {
      const newWidth = Math.min(
        Math.max(300, window.innerWidth - ev.clientX),
        window.innerWidth * 0.8,
      );
      el.style.width = `${newWidth}px`;
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      localStorage.setItem("ts-callpath-source-width", String(parseInt(el.style.width)));
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });

  const header = htmlEl("div");
  header.style.cssText = `
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 12px; background: var(--source-header-bg); border-bottom: 1px solid var(--source-header-border);
    font-size: 12px; color: var(--source-header-text); flex-shrink: 0; gap: 8px;
  `;
  const headerTitle = htmlEl("span");
  headerTitle.style.cssText =
    "flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
  const headerRight = htmlEl("div");
  headerRight.style.cssText = "display: flex; align-items: center; gap: 6px; flex-shrink: 0;";
  const editorLink = htmlEl("a") as HTMLAnchorElement;
  editorLink.style.cssText = `
    color: var(--source-link); font-size: 11px; text-decoration: none;
    padding: 2px 6px; border: 1px solid var(--panel-border); border-radius: 3px;
    white-space: nowrap;
  `;
  editorLink.textContent = "Open in editor";
  const closeBtn = htmlEl("button");
  closeBtn.textContent = "\u00d7";
  closeBtn.style.cssText = `
    background: none; border: none; color: var(--source-close); font-size: 18px;
    cursor: pointer; padding: 0 4px; line-height: 1;
  `;
  headerRight.appendChild(editorLink);
  headerRight.appendChild(closeBtn);
  header.appendChild(headerTitle);
  header.appendChild(headerRight);
  el.appendChild(header);

  // Persistent signature container — stays pinned between header and body
  const sigContainer = htmlEl("div");
  sigContainer.style.cssText = `
    flex-shrink: 0; overflow: hidden; display: none;
  `;
  el.appendChild(sigContainer);

  const body = htmlEl("div");
  body.style.cssText = `
    flex: 1; overflow: auto; padding: 0;
  `;
  el.appendChild(body);

  document.body.appendChild(el);

  if (!hljsThemeInjected) {
    // Scope hljs themes to data-theme attributes so they switch with theme
    function scopeHljsTheme(css: string, selector: string): string {
      return (css as string).replace(/\.hljs\b/g, `${selector} .hljs`);
    }
    const darkStyle = document.createElement("style");
    darkStyle.textContent = scopeHljsTheme(
      hljsThemeDark as string,
      ':root:not([data-theme="light"])',
    );
    document.head.appendChild(darkStyle);
    const lightStyle = document.createElement("style");
    lightStyle.textContent = scopeHljsTheme(hljsThemeLight as string, '[data-theme="light"]');
    document.head.appendChild(lightStyle);
    hljsThemeInjected = true;
  }

  closeBtn.addEventListener("click", () => hide());

  function buildEditorUrl(filePath: string, line: number): string | null {
    const editor = data.editor ?? "cursor";
    const repoRoot = data.repoRoot;
    if (!repoRoot) return null;
    const absPath = `${repoRoot}/${filePath}`;
    return `${editor}://file/${absPath}:${line}:1`;
  }

  function hide() {
    el.style.display = "none";
  }

  function show(node: GraphNode) {
    if (!node.sourceSnippet) return;
    headerTitle.textContent = `${node.filePath}:${node.line}`;

    // Editor link
    const url = buildEditorUrl(node.filePath, node.line);
    if (url) {
      editorLink.href = url;
      editorLink.textContent = `Open in ${data.editor ?? "cursor"}`;
      editorLink.style.display = "inline-block";
    } else {
      editorLink.style.display = "none";
    }

    body.innerHTML = "";

    // Signature section — pinned above the scroll area
    if (node.signature) {
      sigContainer.innerHTML = "";
      const sigBlock = htmlEl("div");
      sigBlock.style.cssText = `
        padding: 8px 12px; background: var(--source-sig-bg);
        border-bottom: 1px solid var(--source-sig-border); color: var(--source-sig-text); font-size: 12px;
        white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow-y: auto;
      `;
      sigBlock.textContent = `${node.qualifiedName}${node.signature}`;
      sigContainer.appendChild(sigBlock);
      sigContainer.style.display = "block";
    } else {
      sigContainer.style.display = "none";
    }

    // Source lines (syntax-highlighted)
    const highlighted = hljs.highlight(node.sourceSnippet, { language: "typescript" }).value;
    const highlightedLines = highlighted.split("\n");
    const pre = htmlEl("pre");
    pre.className = "hljs";
    pre.style.cssText = `margin: 0; padding: 8px 0; font-size: 11px; line-height: 1.5; background: transparent;`;
    for (let i = 0; i < highlightedLines.length; i++) {
      const lineNum = node.line + i;
      const row = htmlEl("div");
      row.style.cssText = `display: flex; padding: 0 12px;${i === 0 ? " background: var(--source-highlight);" : ""}`;
      const num = htmlEl("span");
      num.style.cssText = `
        display: inline-block; width: 40px; text-align: right;
        color: var(--source-linenum); margin-right: 12px; flex-shrink: 0; user-select: none;
      `;
      num.textContent = String(lineNum);
      const code = htmlEl("span");
      code.style.cssText = "white-space: pre;";
      code.innerHTML = highlightedLines[i];
      row.appendChild(num);
      row.appendChild(code);
      pre.appendChild(row);
    }
    body.appendChild(pre);

    el.style.display = "flex";
  }

  return { show, hide, el };
}

// ── Search Overlay ──────────────────────────────────────────────────────────

function createSearchOverlay(
  data: GraphData,
  panToNode: (id: string) => void,
  nodeEls: Map<string, SVGGElement>,
): {
  show: () => void;
  hide: () => void;
  el: HTMLElement;
} {
  const el = htmlEl("div", { id: "search-overlay" });
  el.style.cssText = `
    position: fixed; top: 80px; left: 50%; transform: translateX(-50%);
    width: 420px; background: var(--search-bg); border: 1px solid var(--search-border);
    border-radius: 8px; z-index: 120; display: none;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    font: 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  `;

  const input = htmlEl("input") as HTMLInputElement;
  input.type = "text";
  input.placeholder = "Search functions\u2026";
  input.style.cssText = `
    width: 100%; padding: 10px 14px; background: var(--search-input-bg); color: var(--search-input-text);
    border: none; border-bottom: 1px solid var(--search-input-border); border-radius: 8px 8px 0 0;
    font: 13px monospace; outline: none; box-sizing: border-box;
  `;
  el.appendChild(input);

  const resultList = htmlEl("div");
  resultList.style.cssText = `
    max-height: 300px; overflow-y: auto;
  `;
  el.appendChild(resultList);

  document.body.appendChild(el);

  let selectedIdx = 0;
  let currentResults: GraphNode[] = [];

  function updateResults() {
    const query = input.value.toLowerCase().trim();
    resultList.innerHTML = "";
    selectedIdx = 0;

    if (!query) {
      currentResults = [];
      return;
    }

    currentResults = data.nodes
      .filter(
        (n) =>
          n.qualifiedName.toLowerCase().includes(query) || n.filePath.toLowerCase().includes(query),
      )
      .slice(0, 10);

    for (let i = 0; i < currentResults.length; i++) {
      const n = currentResults[i];
      const row = htmlEl("div");
      row.style.cssText = `
        padding: 8px 14px; cursor: pointer; color: var(--search-result-text);
        ${i === selectedIdx ? "background: var(--search-result-hover);" : ""}
      `;
      row.addEventListener("mouseenter", () => {
        selectedIdx = i;
        highlightSelected();
      });
      row.addEventListener("click", () => selectResult(n));

      const name = htmlEl("div");
      name.style.cssText = "font-weight: bold; font-size: 12px;";
      name.textContent = n.qualifiedName;
      row.appendChild(name);

      const fp = htmlEl("div");
      fp.style.cssText = "font-size: 10px; color: var(--search-result-secondary);";
      fp.textContent = `${n.filePath}:${n.line}`;
      row.appendChild(fp);

      resultList.appendChild(row);
    }
  }

  function highlightSelected() {
    const children = resultList.children;
    for (let i = 0; i < children.length; i++) {
      (children[i] as HTMLElement).style.background =
        i === selectedIdx ? "var(--search-result-hover)" : "none";
    }
  }

  function selectResult(node: GraphNode) {
    hide();
    panToNode(node.id);
    // Pulse animation
    const nodeEl = nodeEls.get(node.id);
    if (nodeEl) {
      nodeEl.classList.add("node-pulse");
      nodeEl.addEventListener("animationend", () => nodeEl.classList.remove("node-pulse"), {
        once: true,
      });
    }
  }

  input.addEventListener("input", updateResults);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (selectedIdx < currentResults.length - 1) selectedIdx++;
      highlightSelected();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (selectedIdx > 0) selectedIdx--;
      highlightSelected();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (currentResults[selectedIdx]) {
        selectResult(currentResults[selectedIdx]);
      }
    } else if (e.key === "Escape") {
      hide();
    }
  });

  function show() {
    el.style.display = "block";
    input.value = "";
    resultList.innerHTML = "";
    currentResults = [];
    input.focus();
  }

  function hide() {
    el.style.display = "none";
  }

  // Close on click outside
  document.addEventListener("mousedown", (e) => {
    if (el.style.display !== "none" && !el.contains(e.target as Node)) {
      hide();
    }
  });

  return { show, hide, el };
}

// ── Pan & Zoom ─────────────────────────────────────────────────────────────

function setupPanZoom(svg: SVGSVGElement): {
  fitAll: () => void;
  panToNode: (nx: number, ny: number, nw: number, nh: number) => void;
  bounds: { x: number; y: number; w: number; h: number };
} {
  let isPanning = false;
  let panStart = { x: 0, y: 0 };
  let initialBounds = { x: 0, y: 0, w: 0, h: 0 };

  function getViewBox() {
    const vb = svg.getAttribute("viewBox")?.split(" ").map(Number) ?? [0, 0, 800, 600];
    return { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
  }

  function setViewBox(vb: { x: number; y: number; w: number; h: number }) {
    svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  }

  /** Convert a screen-space pixel point to SVG-coordinate point via the CTM. */
  function screenToSvg(screenX: number, screenY: number): DOMPoint {
    const ctm = svg.getScreenCTM();
    if (ctm) {
      const inv = ctm.inverse();
      return new DOMPoint(screenX, screenY).matrixTransform(inv);
    }
    // Fallback: manual computation
    const vb = getViewBox();
    const rect = svg.getBoundingClientRect();
    const scale = Math.min(rect.width / vb.w, rect.height / vb.h);
    const offsetX = (rect.width - vb.w * scale) / 2;
    const offsetY = (rect.height - vb.h * scale) / 2;
    return new DOMPoint(
      (screenX - rect.left - offsetX) / scale + vb.x,
      (screenY - rect.top - offsetY) / scale + vb.y,
    );
  }

  svg.addEventListener("mousedown", (e: MouseEvent) => {
    if (e.target === svg || (e.target as Element).tagName === "rect") {
      // Only pan on background click
      const target = e.target as Element;
      if (target === svg || target.classList.contains("bg")) {
        isPanning = true;
        panStart = { x: e.clientX, y: e.clientY };
        svg.style.cursor = "grabbing";
      }
    }
  });

  window.addEventListener("mousemove", (e: MouseEvent) => {
    if (!isPanning) return;
    // Map both the previous and current screen positions to SVG coords.
    // The difference gives a pixel-perfect 1:1 pan via the CTM.
    const prev = screenToSvg(panStart.x, panStart.y);
    const curr = screenToSvg(e.clientX, e.clientY);
    const vb = getViewBox();
    setViewBox({
      x: vb.x - (curr.x - prev.x),
      y: vb.y - (curr.y - prev.y),
      w: vb.w,
      h: vb.h,
    });
    panStart = { x: e.clientX, y: e.clientY };
  });

  window.addEventListener("mouseup", () => {
    isPanning = false;
    svg.style.cursor = "default";
  });

  svg.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      e.preventDefault();

      // Normalize deltaY across deltaMode (pixels vs lines vs pages)
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16; // lines → pixels
      if (e.deltaMode === 2) dy *= 100; // pages → pixels

      // Continuous zoom: proportional to scroll amount.
      // Pinch-to-zoom on macOS trackpads fires with ctrlKey=true and
      // small deltaY values; regular scroll uses larger values.
      // Using exp() gives smooth, symmetric zoom in both directions.
      const sensitivity = e.ctrlKey ? 0.01 : 0.003;
      const factor = Math.exp(dy * sensitivity);

      const vb = getViewBox();
      const mouse = screenToSvg(e.clientX, e.clientY);

      const newW = vb.w * factor;
      const newH = vb.h * factor;

      setViewBox({
        x: mouse.x - (mouse.x - vb.x) * factor,
        y: mouse.y - (mouse.y - vb.y) * factor,
        w: newW,
        h: newH,
      });
    },
    { passive: false },
  );

  function fitAll() {
    setViewBox({
      x: initialBounds.x - 20,
      y: initialBounds.y - 20,
      w: initialBounds.w + 40,
      h: initialBounds.h + 40,
    });
  }

  function panToNode(nx: number, ny: number, nw: number, nh: number) {
    const centerX = nx + nw / 2;
    const centerY = ny + nh / 2;
    const vb = getViewBox();
    setViewBox({
      x: centerX - vb.w / 2,
      y: centerY - vb.h / 2,
      w: vb.w,
      h: vb.h,
    });
  }

  return {
    fitAll,
    panToNode,
    set bounds(b: { x: number; y: number; w: number; h: number }) {
      initialBounds = b;
    },
    get bounds() {
      return initialBounds;
    },
  };
}

// ── Highlight Paths ────────────────────────────────────────────────────────

function setupHighlighting(
  svg: SVGSVGElement,
  layout: LayoutResult,
  nodeEls: Map<string, SVGGElement>,
  edgeEls: Map<string, SVGGElement>,
): () => void {
  // Build adjacency for path finding
  const predecessors = new Map<string, Set<string>>();
  const successors = new Map<string, Set<string>>();
  for (const n of layout.nodes) {
    predecessors.set(n.id, new Set());
    successors.set(n.id, new Set());
  }
  for (const e of layout.edges) {
    predecessors.get(e.to)?.add(e.from);
    successors.get(e.from)?.add(e.to);
  }

  function getConnected(nodeId: string): Set<string> {
    const connected = new Set<string>();
    // BFS forward
    const fwd: string[] = [nodeId];
    while (fwd.length > 0) {
      const id = fwd.pop()!;
      if (connected.has(id)) continue;
      connected.add(id);
      for (const s of successors.get(id) ?? []) fwd.push(s);
    }
    // BFS backward
    const bwd: string[] = [nodeId];
    while (bwd.length > 0) {
      const id = bwd.pop()!;
      if (connected.has(id)) continue;
      connected.add(id);
      for (const p of predecessors.get(id) ?? []) bwd.push(p);
    }
    return connected;
  }

  // Track whether mouse moved between mousedown and click (i.e. a drag/pan).
  // If so, suppress the click so dragging doesn't clear the highlight.
  let didDrag = false;
  let mouseDownPos = { x: 0, y: 0 };
  svg.addEventListener("mousedown", (e: MouseEvent) => {
    didDrag = false;
    mouseDownPos = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener("mousemove", (e: MouseEvent) => {
    if (didDrag) return;
    const dx = e.clientX - mouseDownPos.x;
    const dy = e.clientY - mouseDownPos.y;
    if (dx * dx + dy * dy > 9) didDrag = true;
  });

  let highlighted: string | null = null;

  function clearHighlight() {
    if (!highlighted) return;
    for (const [, el] of nodeEls) el.style.opacity = "1";
    for (const [, el] of edgeEls) el.style.opacity = "1";
    highlighted = null;
  }

  function handler(e: MouseEvent) {
    if (didDrag) return;

    const target = e.target as Element;
    const nodeGroup = target.closest(".node-group");

    if (!nodeGroup) {
      // Click on background: clear highlight
      clearHighlight();
      return;
    }

    const nodeId = nodeGroup.getAttribute("data-id");
    if (!nodeId) return;

    if (highlighted === nodeId) {
      // Toggle off
      clearHighlight();
      return;
    }

    highlighted = nodeId;
    const connected = getConnected(nodeId);

    for (const [id, el] of nodeEls) {
      el.style.opacity = connected.has(id) ? "1" : "0.15";
    }
    for (const [key, el] of edgeEls) {
      const [from, to] = key.split("→");
      el.style.opacity = connected.has(from) && connected.has(to) ? "1" : "0.1";
    }
  }

  svg.addEventListener("click", handler);

  // Return cleanup function
  return () => {
    svg.removeEventListener("click", handler);
  };
}

// ── Element Creation ───────────────────────────────────────────────────────

export function createNodeEl(
  node: LayoutNode,
  tooltip: {
    show: (n: LayoutNode, x: number, y: number) => void;
    hide: () => void;
  },
): SVGGElement {
  const g = svgEl("g", {
    class: "node-group",
    "data-id": node.id,
    transform: `translate(${node.x}, ${node.y})`,
  }) as SVGGElement;
  g.style.cursor = "pointer";

  const colors = nodeColor(node);
  const rectAttrs: Record<string, string | number> = {
    x: 0,
    y: 0,
    width: node.width,
    height: node.height,
    fill: colors.fill,
    stroke: colors.stroke,
    "stroke-width": node.isCollapsedGroup ? 2 : 1,
    rx: 8,
    filter: "url(#node-shadow)",
  };
  if (node.isCollapsedGroup) {
    rectAttrs["stroke-dasharray"] = "4,2";
  }
  const rect = svgEl("rect", rectAttrs);
  g.appendChild(rect);

  const label = svgEl("text", {
    x: node.width / 2,
    y: node.height / 2 + 4,
    fill: colors.textFill,
    "font-size": "11",
    "font-family": "monospace",
    "text-anchor": "middle",
    "font-weight": node.isCollapsedGroup ? "bold" : "normal",
  });
  label.textContent = nodeLabel(node);
  g.appendChild(label);

  // Tooltip events
  g.addEventListener("mouseenter", (e: MouseEvent) => {
    tooltip.show(node, e.clientX, e.clientY);
  });
  g.addEventListener("mousemove", (e: MouseEvent) => {
    tooltip.show(node, e.clientX, e.clientY);
  });
  g.addEventListener("mouseleave", () => {
    tooltip.hide();
  });

  return g;
}

export function createEdgeEl(
  edge: LayoutEdge,
  edgeTooltip?: {
    show: (e: GraphEdge, isBackedge: boolean, x: number, y: number) => void;
    hide: () => void;
  },
  edgeLookup?: Map<string, GraphEdge>,
): SVGGElement {
  const g = svgEl("g", { class: "edge-group" }) as SVGGElement;
  const color = edge.isBackedge ? COLORS.backedge : edgeColor(edge.kind);
  const dash = edge.isBackedge ? "6,3" : edgeDasharray(edge.kind);
  const markerId = markerIdForEdge(edge);

  // Invisible wider hitbox path for easier hover targeting
  const hitbox = svgEl("path", {
    d: buildOrthogonalPath(edge.waypoints),
    fill: "none",
    stroke: "transparent",
    "stroke-width": 10,
  });
  g.appendChild(hitbox);

  const pathEl = svgEl("path", {
    d: buildOrthogonalPath(edge.waypoints),
    fill: "none",
    stroke: color,
    "stroke-width": 1.5,
    "marker-end": `url(#${markerId})`,
  });
  if (dash) pathEl.setAttribute("stroke-dasharray", dash);
  g.appendChild(pathEl);

  // Edge label
  const labelText = edgeLabel(edge.kind);
  if (labelText && edge.waypoints.length >= 2) {
    const mid = edge.waypoints[Math.floor(edge.waypoints.length / 2)];
    const el = svgEl("text", {
      x: mid.x + 4,
      y: mid.y - 4,
      fill: color,
      "font-size": "9",
      "font-family": "monospace",
    });
    el.textContent = labelText;
    g.appendChild(el);
  }

  // Call-line label near the start of the edge
  const graphEdge = edgeLookup?.get(`${edge.from}\u2192${edge.to}`);
  if (graphEdge && edge.waypoints.length >= 2) {
    const wp = edge.waypoints[0];
    const callLineLabel = svgEl("text", {
      x: wp.x + 4,
      y: wp.y + 4,
      fill: color,
      "font-size": "8",
      "font-family": "monospace",
      opacity: "0.6",
    });
    callLineLabel.textContent = `:${graphEdge.callLine}`;
    g.appendChild(callLineLabel);
  }

  // Edge tooltip events
  if (edgeTooltip && graphEdge) {
    const showTip = (e: MouseEvent) => {
      edgeTooltip.show(graphEdge, edge.isBackedge, e.clientX, e.clientY);
    };
    g.addEventListener("mouseenter", showTip);
    g.addEventListener("mousemove", showTip);
    g.addEventListener("mouseleave", () => edgeTooltip.hide());
  }

  return g;
}

export function createClusterEl(
  cluster: LayoutCluster,
  isCollapsed: boolean,
  owners: string[] = [],
): SVGGElement {
  const g = svgEl("g", {
    class: "cluster-group",
    "data-filepath": cluster.filePath,
    transform: `translate(${cluster.x}, ${cluster.y})`,
  }) as SVGGElement;
  g.style.cursor = "pointer";

  const rect = svgEl("rect", {
    x: 0,
    y: 0,
    width: cluster.width,
    height: cluster.height,
    fill: COLORS.clusterFill,
    stroke: COLORS.clusterBorder,
    "stroke-dasharray": "4,4",
    rx: 6,
  });
  g.appendChild(rect);

  const indicator = isCollapsed ? "\u25b8" : "\u25be";
  const label = svgEl("text", {
    x: 6,
    y: 12,
    fill: COLORS.clusterLabel,
    "font-size": "10",
    "font-family": "monospace",
    class: "cluster-label",
  });
  label.textContent = `${indicator} ${fileName(cluster.filePath)}`;
  g.appendChild(label);

  // Team ownership chips (below the filename label)
  if (owners.length > 0) {
    let chipX = 6;
    const chipY = 17;
    const chipHeight = 13;

    for (const owner of owners) {
      const chipWidth = owner.length * 5.5 + 10;
      const color = teamColor(owner);

      const chipRect = svgEl("rect", {
        x: chipX,
        y: chipY,
        width: chipWidth,
        height: chipHeight,
        fill: color,
        rx: 3,
        filter: "url(#chip-shadow)",
      });
      g.appendChild(chipRect);

      const chipText = svgEl("text", {
        x: chipX + chipWidth / 2,
        y: chipY + chipHeight / 2 + 3,
        fill: "#ffffff",
        "font-size": "9",
        "font-family": "monospace",
        "text-anchor": "middle",
      });
      chipText.textContent = owner;
      g.appendChild(chipText);

      chipX += chipWidth + 4;
    }
  }

  const title = svgEl("title");
  title.textContent = cluster.filePath;
  g.appendChild(title);

  return g;
}

// ── Main Render ────────────────────────────────────────────────────────────

export function renderGraph(container: HTMLElement, layout: LayoutResult, data: GraphData): void {
  container.innerHTML = "";

  // ── State ──
  const collapsedFiles = new Set<string>();
  let focusedNodeIds: Set<string> | null = null;
  const hiddenNodeIds = new Set<string>();
  let direction: LayoutDirection = "LR";
  let currentLayout: LayoutResult = layout;
  const nodeEls = new Map<string, SVGGElement>();
  const edgeEls = new Map<string, SVGGElement>();
  const clusterEls = new Map<string, SVGGElement>();
  let cleanupHighlighting: (() => void) | null = null;

  // ── SVG Setup ──
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.style.display = "block";

  // CSS transitions
  const style = svgEl("style");
  style.textContent = `
    .node-group { transition: transform ${TRANSITION_MS}ms ease, opacity ${TRANSITION_MS}ms ease; }
    .cluster-group { transition: transform ${TRANSITION_MS}ms ease, opacity ${TRANSITION_MS}ms ease; }
    .cluster-group rect { transition: width ${TRANSITION_MS}ms ease, height ${TRANSITION_MS}ms ease; }
    .edge-group { transition: opacity ${TRANSITION_MS}ms ease; }
    @keyframes node-pulse {
      0%, 100% { filter: none; }
      50% { filter: drop-shadow(0 0 8px var(--pulse-glow)); }
    }
    .node-pulse { animation: node-pulse 0.6s ease 2; }
  `;
  svg.appendChild(style);

  const bounds = computeBounds(layout);
  svg.setAttribute("viewBox", `${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`);

  // Defs
  const defs = svgEl("defs");
  ensureMarkers(defs, layout);

  // Drop shadow filter for team chips
  const chipShadow = svgEl("filter", {
    id: "chip-shadow",
    x: "-10%",
    y: "-10%",
    width: "130%",
    height: "150%",
  });
  const feDropShadow = svgEl("feDropShadow", {
    dx: 0,
    dy: 1,
    stdDeviation: 1,
    "flood-color": "rgba(0,0,0,0.3)",
  });
  chipShadow.appendChild(feDropShadow);
  defs.appendChild(chipShadow);

  // Light drop shadow for node cards
  const nodeShadow = svgEl("filter", {
    id: "node-shadow",
    x: "-5%",
    y: "-5%",
    width: "110%",
    height: "120%",
  });
  nodeShadow.appendChild(
    svgEl("feDropShadow", {
      dx: 0,
      dy: 1,
      stdDeviation: 2,
      "flood-color": "rgba(0,0,0,0.15)",
    }),
  );
  defs.appendChild(nodeShadow);

  svg.appendChild(defs);

  // Background rect for pan detection
  const bg = svgEl("rect", {
    x: bounds.x - 10000,
    y: bounds.y - 10000,
    width: bounds.w + 20000,
    height: bounds.h + 20000,
    fill: "transparent",
    class: "bg",
  });
  svg.appendChild(bg);

  // Layers
  const clusterLayer = svgEl("g", { class: "clusters" });
  const edgeLayer = svgEl("g", { class: "edges" });
  const nodeLayer = svgEl("g", { class: "nodes" });
  svg.appendChild(clusterLayer);
  svg.appendChild(edgeLayer);
  svg.appendChild(nodeLayer);

  const tooltip = createTooltip();
  const edgeTooltip = createEdgeTooltip();
  const contextMenu = createContextMenu();
  const sourcePanel = createSourcePanel(data);

  // ── Edge lookup map (from→to → original GraphEdge) ──
  const edgeLookup = new Map<string, GraphEdge>();
  for (const e of data.edges) {
    edgeLookup.set(`${e.from}\u2192${e.to}`, e);
  }

  // ── Layout node map (for pan-to-node) ──
  const layoutNodeMap = new Map<string, LayoutNode>();
  for (const n of layout.nodes) {
    if (!n.isDummy && n.original) layoutNodeMap.set(n.id, n);
  }

  // ── Codeowners lookup helper ──
  function getOwners(filePath: string): string[] {
    return data.codeowners?.[filePath] ?? [];
  }

  // ── Initial Render ──
  for (const cluster of layout.clusters) {
    const g = createClusterEl(cluster, false, getOwners(cluster.filePath));
    clusterLayer.appendChild(g);
    clusterEls.set(cluster.filePath, g);
  }

  for (const edge of layout.edges) {
    const g = createEdgeEl(edge, edgeTooltip, edgeLookup);
    edgeLayer.appendChild(g);
    edgeEls.set(`${edge.from}\u2192${edge.to}`, g);
  }

  for (const node of layout.nodes) {
    if (node.isDummy || !node.original) continue;
    const g = createNodeEl(node, tooltip);
    nodeLayer.appendChild(g);
    nodeEls.set(node.id, g);
  }

  container.appendChild(svg);

  // ── Interactions ──
  const panZoom = setupPanZoom(svg);
  panZoom.bounds = bounds;
  cleanupHighlighting = setupHighlighting(svg, layout, nodeEls, edgeEls);

  // ── Pan-to-node helper ──
  function panToNodeById(id: string) {
    const ln = layoutNodeMap.get(id);
    if (ln) {
      panZoom.panToNode(ln.x, ln.y, ln.width, ln.height);
    }
  }

  // ── Search Overlay ──
  const searchOverlay = createSearchOverlay(data, panToNodeById, nodeEls);

  // ── Direction Toggle ──
  function toggleDirection(): void {
    direction = direction === "TB" ? "LR" : "TB";
    relayout();
    panZoom.fitAll();
    // Update toolbar button text
    const dirBtn = document.getElementById("direction-btn");
    if (dirBtn) {
      dirBtn.innerHTML = `Layout: ${direction} <kbd>R</kbd>`;
    }
  }

  // Expose actions on window
  (window as any).__fitAll = () => panZoom.fitAll();
  (window as any).__exitFocus = () => exitFocus();
  (window as any).__collapseAll = () => collapseAll();
  (window as any).__expandAll = () => expandAll();
  (window as any).__showHidden = () => showHidden();
  (window as any).__search = () => searchOverlay.show();
  (window as any).__toggleDirection = () => toggleDirection();
  (window as any).__showSource = (nodeId: string) => {
    const node = data.nodes.find((n) => n.id === nodeId);
    if (node?.sourceSnippet) sourcePanel.show(node);
  };

  // ── Context Menu Dismiss ──
  document.addEventListener("click", () => contextMenu.hide());
  svg.addEventListener("wheel", () => contextMenu.hide(), { passive: true });

  // ── Keyboard Shortcuts ──
  document.addEventListener("keydown", (e) => {
    // Skip when typing in an input
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      if (e.key === "Escape") {
        searchOverlay.hide();
      }
      return;
    }

    // Skip single-key shortcuts when modifier held (preserve Cmd+C, etc.)
    const hasModifier = e.ctrlKey || e.metaKey;

    if (e.key === "Escape") {
      exitFocus();
      searchOverlay.hide();
      sourcePanel.hide();
      contextMenu.hide();
      const helpPanel = document.getElementById("help-panel");
      if (helpPanel) helpPanel.style.display = "none";
      return;
    }

    if (e.key === "/" || (e.key === "k" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      searchOverlay.show();
      return;
    }

    if (hasModifier) return;

    switch (e.key.toUpperCase()) {
      case "F":
        panZoom.fitAll();
        break;
      case "L":
        (window as any).__toggleLegend?.();
        break;
      case "C":
        collapseAll();
        break;
      case "E":
        expandAll();
        break;
      case "R":
        toggleDirection();
        break;
      case "T":
        (window as any).__toggleTheme?.();
        break;
      case "H":
        (window as any).__toggleHelp?.();
        break;
    }
  });

  // ── Double-click Handler (open details panel) ──
  svg.addEventListener("dblclick", (e: MouseEvent) => {
    const target = e.target as Element;
    const nodeGroup = target.closest(".node-group");
    if (!nodeGroup) return;
    const nodeId = nodeGroup.getAttribute("data-id");
    if (!nodeId) return;
    const node = data.nodes.find((n) => n.id === nodeId);
    if (node?.sourceSnippet) sourcePanel.show(node);
  });

  // ── Context Menu Handler (event delegation) ──
  svg.addEventListener("contextmenu", (e: MouseEvent) => {
    e.preventDefault();
    const target = e.target as Element;

    const nodeGroup = target.closest(".node-group");
    if (nodeGroup) {
      const nodeId = nodeGroup.getAttribute("data-id");
      if (nodeId) {
        contextMenu.show(buildNodeMenuItems(nodeId), e.clientX, e.clientY);
        return;
      }
    }

    const clusterGroup = target.closest(".cluster-group");
    if (clusterGroup) {
      const filePath = clusterGroup.getAttribute("data-filepath");
      if (filePath) {
        contextMenu.show(buildClusterMenuItems(filePath), e.clientX, e.clientY);
        return;
      }
    }
  });

  // ── Menu Item Builders ──

  function buildNodeMenuItems(nodeId: string): ContextMenuItem[] {
    const node = data.nodes.find((n) => n.id === nodeId);
    const items: ContextMenuItem[] = [
      {
        icon: "\u{1F50D}",
        label: "Focus this node",
        action: () => focusNode(nodeId),
      },
      {
        icon: "\u{1F3AF}",
        label: "Target this node",
        action: () => targetNode(nodeId),
      },
      {
        icon: "\u2195",
        label: "Paths through here",
        action: () => pathsThrough(nodeId),
      },
      {
        icon: "\u{1F441}",
        label: "Hide this node",
        action: () => hideNode(nodeId),
      },
      {
        icon: "\u{1F4CB}",
        label: "Copy name",
        action: () => copyNodeName(nodeId),
      },
    ];
    if (node?.sourceSnippet) {
      items.push({
        icon: "\u{1F4C4}",
        label: "View source",
        action: () => sourcePanel.show(node),
      });
    }
    return items;
  }

  function buildClusterMenuItems(filePath: string): ContextMenuItem[] {
    const isCollapsed = collapsedFiles.has(filePath);
    return [
      {
        icon: isCollapsed ? "\u25b8" : "\u25be",
        label: isCollapsed ? "Expand file" : "Collapse file",
        action: () => toggleCollapse(filePath),
      },
      {
        icon: "\u{1F50D}",
        label: "Focus this file",
        action: () => focusFile(filePath),
      },
      {
        icon: "\u{1F4C1}",
        label: "Collapse all others",
        action: () => collapseAllOthers(filePath),
      },
      {
        icon: "\u{1F3AF}",
        label: "Target this file",
        action: () => targetFile(filePath),
      },
      {
        icon: "\u{1F441}",
        label: "Hide this file",
        action: () => hideFile(filePath),
      },
    ];
  }

  // ── Initial toolbar state ──
  updateToolbarState();

  // ── Cluster Click Handling ──
  clusterLayer.addEventListener("click", (e: MouseEvent) => {
    const target = e.target as Element;
    const clusterGroup = target.closest(".cluster-group");
    if (!clusterGroup) return;
    const filePath = clusterGroup.getAttribute("data-filepath");
    if (!filePath) return;

    e.stopPropagation();
    toggleCollapse(filePath);
  });

  // ── Collapse / Focus Logic ──

  function toggleCollapse(filePath: string): void {
    if (collapsedFiles.has(filePath)) {
      collapsedFiles.delete(filePath);
    } else {
      collapsedFiles.add(filePath);
    }
    relayout();
  }

  // ── BFS / Adjacency Helpers ──

  function buildAdjacency(l: LayoutResult) {
    const predecessors = new Map<string, Set<string>>();
    const successors = new Map<string, Set<string>>();
    const sourceIds = new Set<string>();
    const targetIds = new Set<string>();
    for (const n of l.nodes) {
      predecessors.set(n.id, new Set());
      successors.set(n.id, new Set());
      if (n.original?.isSource) sourceIds.add(n.id);
      if (n.original?.isTarget) targetIds.add(n.id);
    }
    for (const e of l.edges) {
      predecessors.get(e.to)?.add(e.from);
      successors.get(e.from)?.add(e.to);
    }
    return { predecessors, successors, sourceIds, targetIds };
  }

  function bfsForward(
    startIds: Iterable<string>,
    successors: Map<string, Set<string>>,
  ): Set<string> {
    const visited = new Set<string>();
    const queue: string[] = [...startIds];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const s of successors.get(id) ?? []) queue.push(s);
    }
    return visited;
  }

  function bfsBackward(
    startIds: Iterable<string>,
    predecessors: Map<string, Set<string>>,
  ): Set<string> {
    const visited = new Set<string>();
    const queue: string[] = [...startIds];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const p of predecessors.get(id) ?? []) queue.push(p);
    }
    return visited;
  }

  function layoutIdsToOriginal(ids: Set<string>): Set<string> {
    const originalIds = new Set<string>();
    for (const id of ids) {
      if (id.startsWith("__collapsed:")) {
        const filePath = id.slice("__collapsed:".length);
        for (const n of data.nodes) {
          if (n.filePath === filePath) originalIds.add(n.id);
        }
      } else {
        originalIds.add(id);
      }
    }
    return originalIds;
  }

  // ── Focus / Target / Paths Through ──

  function computeFocusSet(clickedNodeId: string): Set<string> {
    const fullLayout = layoutGraph(data, collapsedFiles);
    const { predecessors, successors } = buildAdjacency(fullLayout);
    const fwd = bfsForward([clickedNodeId], successors);
    const bwd = bfsBackward([clickedNodeId], predecessors);
    const connected = new Set([...fwd, ...bwd]);
    return layoutIdsToOriginal(connected);
  }

  function computeTargetSet(targetNodeId: string): Set<string> {
    const fullLayout = layoutGraph(data, collapsedFiles);
    const { predecessors, successors, sourceIds } = buildAdjacency(fullLayout);
    const ancestors = bfsBackward([targetNodeId], predecessors);
    const fromSources = bfsForward(sourceIds, successors);
    const result = new Set<string>();
    for (const id of ancestors) {
      if (fromSources.has(id)) result.add(id);
    }
    return layoutIdsToOriginal(result);
  }

  function computePathsThroughSet(nodeId: string): Set<string> {
    const fullLayout = layoutGraph(data, collapsedFiles);
    const { predecessors, successors, sourceIds, targetIds } = buildAdjacency(fullLayout);
    const ancestors = bfsBackward([nodeId], predecessors);
    const descendants = bfsForward([nodeId], successors);
    const fromSources = bfsForward(sourceIds, successors);
    const toTargets = bfsBackward(targetIds, predecessors);
    const upstreamPath = new Set<string>();
    for (const id of ancestors) {
      if (fromSources.has(id)) upstreamPath.add(id);
    }
    const downstreamPath = new Set<string>();
    for (const id of descendants) {
      if (toTargets.has(id)) downstreamPath.add(id);
    }
    return layoutIdsToOriginal(new Set([...upstreamPath, ...downstreamPath]));
  }

  // ── Relayout ──

  function relayout(): void {
    let effectiveData = focusedNodeIds ? filterByFocus(data, focusedNodeIds) : data;
    effectiveData = filterByHidden(effectiveData, hiddenNodeIds);
    const newLayout = layoutGraph(
      effectiveData,
      collapsedFiles,
      currentLayout.clusterOrder,
      direction,
    );
    currentLayout = newLayout;
    updateLayout(newLayout);
    updateToolbarState();
  }

  // ── Actions ──

  function focusNode(nodeId: string): void {
    focusedNodeIds = computeFocusSet(nodeId);
    relayout();
    panZoom.fitAll();
  }

  function focusFile(filePath: string): void {
    const collapsedId = `__collapsed:${filePath}`;
    const fullLayout = layoutGraph(data, collapsedFiles);
    const hasCollapsedNode = fullLayout.nodes.some((n) => n.id === collapsedId);

    if (hasCollapsedNode) {
      focusedNodeIds = computeFocusSet(collapsedId);
    } else {
      const fileNodeIds = data.nodes.filter((n) => n.filePath === filePath).map((n) => n.id);
      const union = new Set<string>();
      for (const nid of fileNodeIds) {
        for (const id of computeFocusSet(nid)) {
          union.add(id);
        }
      }
      focusedNodeIds = union;
    }
    relayout();
    panZoom.fitAll();
  }

  function exitFocus(): void {
    focusedNodeIds = null;
    relayout();
    panZoom.fitAll();
  }

  function targetNode(nodeId: string): void {
    focusedNodeIds = computeTargetSet(nodeId);
    relayout();
    panZoom.fitAll();
  }

  function targetFile(filePath: string): void {
    const collapsedId = `__collapsed:${filePath}`;
    const fullLayout = layoutGraph(data, collapsedFiles);
    const hasCollapsedNode = fullLayout.nodes.some((n) => n.id === collapsedId);

    if (hasCollapsedNode) {
      focusedNodeIds = computeTargetSet(collapsedId);
    } else {
      const fileNodeIds = data.nodes.filter((n) => n.filePath === filePath).map((n) => n.id);
      const union = new Set<string>();
      for (const nid of fileNodeIds) {
        for (const id of computeTargetSet(nid)) {
          union.add(id);
        }
      }
      focusedNodeIds = union;
    }
    relayout();
    panZoom.fitAll();
  }

  function pathsThrough(nodeId: string): void {
    focusedNodeIds = computePathsThroughSet(nodeId);
    relayout();
    panZoom.fitAll();
  }

  function hideNode(nodeId: string): void {
    hiddenNodeIds.add(nodeId);
    relayout();
  }

  function hideFile(filePath: string): void {
    for (const n of data.nodes) {
      if (n.filePath === filePath) hiddenNodeIds.add(n.id);
    }
    relayout();
  }

  function copyNodeName(nodeId: string): void {
    const node = data.nodes.find((n) => n.id === nodeId);
    if (node) {
      navigator.clipboard.writeText(node.qualifiedName);
    }
  }

  function collapseAllOthers(filePath: string): void {
    const allFiles = new Set(data.nodes.map((n) => n.filePath));
    for (const fp of allFiles) {
      if (fp !== filePath) {
        collapsedFiles.add(fp);
      } else {
        collapsedFiles.delete(fp);
      }
    }
    relayout();
  }

  function collapseAll(): void {
    const allFiles = new Set(data.nodes.map((n) => n.filePath));
    for (const fp of allFiles) {
      collapsedFiles.add(fp);
    }
    relayout();
  }

  function expandAll(): void {
    collapsedFiles.clear();
    relayout();
  }

  function showHidden(): void {
    hiddenNodeIds.clear();
    relayout();
  }

  function updateToolbarState(): void {
    const exitBtn = document.getElementById("exit-focus-btn");
    if (exitBtn) {
      exitBtn.style.display = focusedNodeIds ? "inline-block" : "none";
    }
    const hiddenBtn = document.getElementById("show-hidden-btn");
    if (hiddenBtn) {
      if (hiddenNodeIds.size > 0) {
        hiddenBtn.style.display = "inline-block";
        hiddenBtn.textContent = `Show Hidden (${hiddenNodeIds.size})`;
      } else {
        hiddenBtn.style.display = "none";
      }
    }
    // Stats badge
    const statsEl = document.getElementById("stats");
    if (statsEl) {
      const effectiveData = focusedNodeIds
        ? filterByHidden(filterByFocus(data, focusedNodeIds), hiddenNodeIds)
        : filterByHidden(data, hiddenNodeIds);
      statsEl.textContent = `${effectiveData.nodes.length} nodes \u00b7 ${effectiveData.edges.length} edges`;
    }
  }

  function updateLayout(newLayout: LayoutResult): void {
    ensureMarkers(defs, newLayout);

    // ── Diff Nodes ──
    const newNodeMap = new Map<string, LayoutNode>();
    for (const n of newLayout.nodes) {
      if (!n.isDummy && n.original) newNodeMap.set(n.id, n);
    }
    const oldNodeIds = new Set(nodeEls.keys());

    // Update existing / remove old nodes
    for (const [id, el] of nodeEls) {
      const newNode = newNodeMap.get(id);
      if (newNode) {
        // EXISTS in both → animate position
        el.setAttribute("transform", `translate(${newNode.x}, ${newNode.y})`);
        // Update rect size in case it changed (collapsed group width changes)
        const rect = el.querySelector("rect");
        if (rect) {
          rect.setAttribute("width", String(newNode.width));
          rect.setAttribute("height", String(newNode.height));
        }
        const text = el.querySelector("text");
        if (text) {
          text.setAttribute("x", String(newNode.width / 2));
          text.setAttribute("y", String(newNode.height / 2 + 4));
          text.textContent = nodeLabel(newNode);
        }
      } else {
        // REMOVED → fade out, then remove
        el.style.opacity = "0";
        setTimeout(() => {
          el.remove();
          nodeEls.delete(id);
        }, TRANSITION_MS);
      }
    }

    // Add new nodes
    for (const [id, node] of newNodeMap) {
      if (oldNodeIds.has(id)) continue;
      const g = createNodeEl(node, tooltip);
      g.style.opacity = "0";
      nodeLayer.appendChild(g);
      nodeEls.set(id, g);
      // Fade in next frame
      requestAnimationFrame(() => {
        g.style.opacity = "1";
      });
    }

    // ── Diff Edges ──
    const newEdgeMap = new Map<string, LayoutEdge>();
    for (const e of newLayout.edges) {
      newEdgeMap.set(`${e.from}\u2192${e.to}`, e);
    }
    const oldEdgeKeys = new Set(edgeEls.keys());

    for (const [key, el] of edgeEls) {
      const newEdge = newEdgeMap.get(key);
      if (newEdge) {
        // EXISTS in both → update all paths (hitbox + visible)
        const newPath = buildOrthogonalPath(newEdge.waypoints);
        for (const path of el.querySelectorAll("path")) {
          path.setAttribute("d", newPath);
        }
        // Update label positions to match new waypoints
        const texts = el.querySelectorAll("text");
        let ti = 0;
        if (edgeLabel(newEdge.kind) && newEdge.waypoints.length >= 2 && ti < texts.length) {
          const mid = newEdge.waypoints[Math.floor(newEdge.waypoints.length / 2)];
          texts[ti].setAttribute("x", String(mid.x + 4));
          texts[ti].setAttribute("y", String(mid.y - 4));
          ti++;
        }
        if (newEdge.waypoints.length >= 2 && ti < texts.length) {
          const wp = newEdge.waypoints[0];
          texts[ti].setAttribute("x", String(wp.x + 4));
          texts[ti].setAttribute("y", String(wp.y + 4));
        }
      } else {
        // REMOVED → fade out, then remove
        el.style.opacity = "0";
        setTimeout(() => {
          el.remove();
          edgeEls.delete(key);
        }, TRANSITION_MS);
      }
    }

    for (const [key, edge] of newEdgeMap) {
      if (oldEdgeKeys.has(key)) continue;
      const g = createEdgeEl(edge, edgeTooltip, edgeLookup);
      g.style.opacity = "0";
      edgeLayer.appendChild(g);
      edgeEls.set(key, g);
      requestAnimationFrame(() => {
        g.style.opacity = "1";
      });
    }

    // ── Diff Clusters ──
    const newClusterMap = new Map<string, LayoutCluster>();
    for (const c of newLayout.clusters) {
      newClusterMap.set(c.filePath, c);
    }
    const oldClusterKeys = new Set(clusterEls.keys());

    for (const [fp, el] of clusterEls) {
      const newCluster = newClusterMap.get(fp);
      if (newCluster) {
        // EXISTS in both → update position, size, label
        el.setAttribute("transform", `translate(${newCluster.x}, ${newCluster.y})`);
        const rect = el.querySelector("rect");
        if (rect) {
          rect.setAttribute("width", String(newCluster.width));
          rect.setAttribute("height", String(newCluster.height));
        }
        const label = el.querySelector(".cluster-label");
        if (label) {
          const indicator = collapsedFiles.has(fp) ? "\u25b8" : "\u25be";
          label.textContent = `${indicator} ${fileName(fp)}`;
        }
      } else {
        // REMOVED → fade out, then remove
        el.style.opacity = "0";
        setTimeout(() => {
          el.remove();
          clusterEls.delete(fp);
        }, TRANSITION_MS);
      }
    }

    for (const [fp, cluster] of newClusterMap) {
      if (oldClusterKeys.has(fp)) continue;
      const g = createClusterEl(cluster, collapsedFiles.has(fp), getOwners(fp));
      g.style.opacity = "0";
      clusterLayer.appendChild(g);
      clusterEls.set(fp, g);
      requestAnimationFrame(() => {
        g.style.opacity = "1";
      });
    }

    // ── Update layout node map for search pan-to-node ──
    layoutNodeMap.clear();
    for (const n of newLayout.nodes) {
      if (!n.isDummy && n.original) layoutNodeMap.set(n.id, n);
    }

    // ── Update bounds and highlighting ──
    const newBounds = computeBounds(newLayout);
    panZoom.bounds = newBounds;

    // Rebuild highlighting after transition
    if (cleanupHighlighting) cleanupHighlighting();
    setTimeout(() => {
      cleanupHighlighting = setupHighlighting(svg, newLayout, nodeEls, edgeEls);
    }, TRANSITION_MS);
  }
}
