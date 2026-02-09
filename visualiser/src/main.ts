import type { GraphData } from "./types.js";
import { layoutGraph } from "./layout.js";
import { renderGraph } from "./render.js";

declare global {
  interface Window {
    GRAPH_DATA?: GraphData;
  }
}

function run(data: GraphData): void {
  const container = document.getElementById("graph-container");
  if (!container) {
    console.error("No #graph-container found");
    return;
  }

  const layout = layoutGraph(data);
  renderGraph(container, layout, data);

  // Hide input panel if visible
  const inputPanel = document.getElementById("input-panel");
  if (inputPanel) inputPanel.style.display = "none";

  // Show toolbar
  const toolbar = document.getElementById("toolbar");
  if (toolbar) toolbar.style.display = "flex";
}

function setupInputUI(): void {
  const loadBtn = document.getElementById("load-btn");
  const jsonInput = document.getElementById("json-input") as HTMLTextAreaElement | null;
  const fileInput = document.getElementById("file-input") as HTMLInputElement | null;
  const errorEl = document.getElementById("error-msg");

  function showError(msg: string): void {
    if (errorEl) {
      errorEl.textContent = msg;
      errorEl.style.display = "block";
    }
  }

  function parseAndRun(text: string): void {
    try {
      const data = JSON.parse(text) as GraphData;
      if (!data.nodes || !data.edges) {
        showError('Invalid JSON: must have "nodes" and "edges" arrays');
        return;
      }
      run(data);
    } catch (e) {
      showError(`JSON parse error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  loadBtn?.addEventListener("click", () => {
    const text = jsonInput?.value?.trim();
    if (text) {
      parseAndRun(text);
    } else {
      showError("Paste JSON into the textarea or select a file");
    }
  });

  fileInput?.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        parseAndRun(reader.result);
      }
    };
    reader.readAsText(file);
  });

  // Allow drag-and-drop on the textarea
  jsonInput?.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  jsonInput?.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer?.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          jsonInput.value = reader.result;
          parseAndRun(reader.result);
        }
      };
      reader.readAsText(file);
    }
  });
}

// ── Theme ───────────────────────────────────────────────────────────────────

type ThemeSetting = "system" | "light" | "dark";

function resolveTheme(setting: ThemeSetting): "light" | "dark" {
  if (setting === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return setting;
}

function applyTheme(setting: ThemeSetting): void {
  const effective = resolveTheme(setting);
  if (effective === "dark") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", effective);
  }
  const btn = document.getElementById("theme-btn");
  if (btn) {
    const label =
      setting === "system"
        ? `Theme: System <kbd>T</kbd>`
        : setting === "light"
          ? `Theme: Light <kbd>T</kbd>`
          : `Theme: Dark <kbd>T</kbd>`;
    btn.innerHTML = label;
  }
}

let currentThemeSetting: ThemeSetting = "system";

function initTheme(): void {
  const stored = localStorage.getItem("ts-callpath-theme");
  if (stored === "light" || stored === "dark" || stored === "system") {
    currentThemeSetting = stored;
  }
  applyTheme(currentThemeSetting);

  // Listen for system preference changes
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (currentThemeSetting === "system") {
      applyTheme("system");
    }
  });
}

function toggleTheme(): void {
  const cycle: ThemeSetting[] = ["system", "light", "dark"];
  const idx = cycle.indexOf(currentThemeSetting);
  currentThemeSetting = cycle[(idx + 1) % cycle.length];
  localStorage.setItem("ts-callpath-theme", currentThemeSetting);
  applyTheme(currentThemeSetting);
}

// ── Init ───────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  // Initialize theme
  initTheme();
  // Toolbar fit button
  document.getElementById("fit-btn")?.addEventListener("click", () => {
    (window as any).__fitAll?.();
  });

  // Exit focus
  document.getElementById("exit-focus-btn")?.addEventListener("click", () => {
    (window as any).__exitFocus?.();
  });

  // Collapse all
  document.getElementById("collapse-all-btn")?.addEventListener("click", () => {
    (window as any).__collapseAll?.();
  });

  // Expand all
  document.getElementById("expand-all-btn")?.addEventListener("click", () => {
    (window as any).__expandAll?.();
  });

  // Show hidden
  document.getElementById("show-hidden-btn")?.addEventListener("click", () => {
    (window as any).__showHidden?.();
  });

  // Toggle legend
  document.getElementById("legend-btn")?.addEventListener("click", () => {
    const legend = document.getElementById("legend-panel");
    if (legend) {
      legend.style.display = legend.style.display === "none" ? "block" : "none";
    }
  });
  // Expose toggle for keyboard shortcut
  (window as any).__toggleLegend = () => {
    const legend = document.getElementById("legend-panel");
    if (legend) {
      legend.style.display = legend.style.display === "none" ? "block" : "none";
    }
  };

  // Search button
  document.getElementById("search-btn")?.addEventListener("click", () => {
    (window as any).__search?.();
  });

  // Theme button
  document.getElementById("theme-btn")?.addEventListener("click", () => {
    toggleTheme();
  });
  (window as any).__toggleTheme = () => toggleTheme();

  // Help button
  document.getElementById("help-btn")?.addEventListener("click", () => {
    (window as any).__toggleHelp?.();
  });
  // Expose toggle for keyboard shortcut
  (window as any).__toggleHelp = () => {
    const panel = document.getElementById("help-panel");
    if (panel) {
      panel.style.display = panel.style.display === "none" ? "block" : "none";
    }
  };

  // Check for injected data (self-contained mode)
  if (window.GRAPH_DATA) {
    run(window.GRAPH_DATA);
  } else {
    setupInputUI();
  }
});
