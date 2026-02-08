# ts-callpath

TypeScript call graph slicer and HTML visualiser.

## Commands

```bash
pnpm install                    # Install deps 
pnpm test                       # All tests, watch mode
pnpm test:unit                  # Unit tests only, watch mode
pnpm test:browser               # Browser tests only, watch mode
pnpm test:ci                    # All tests, single run (CI)
pnpm test:unit:ci               # Unit tests only, single run
pnpm test:browser:ci            # Browser tests only, single run
pnpm typecheck                  # Type-check, watch mode
pnpm typecheck:ci               # Type-check, single run
pnpm build:visualiser           # Bundle the visualiser
```

## Module Structure

### CLI / Core (`src/`)
Parser, graph builder, dot/HTML renderer. Tests in `src/__tests__/*.test.ts`.

### Visualiser (`visualiser/src/`)
Browser-side graph layout and rendering. Key modules:

| Module | Purpose |
|--------|---------|
| `layout.ts` | `layoutGraph` orchestrator |
| `layout-utils.ts` | Pure layout algorithms (layer assignment, backedge detection, dummy nodes, coordinate assignment, edge routing, clustering) |
| `render.ts` | DOM rendering, pan/zoom, interactions. Exports element factories (`createNodeEl`, `createEdgeEl`, `createClusterEl`) |
| `render-utils.ts` | Pure render helpers (colors, path building, bounds, labels, graph filtering) |
| `types.ts` | Shared types (`GraphData`, `LayoutResult`, etc.) |
| `main.ts` | Entry point (bundled by esbuild) |

### Test Configuration

`vitest.config.ts` uses `projects` for dual environments:
- **`unit`** — Node env, runs `src/__tests__/**/*.test.ts` and `visualiser/src/__tests__/**/*.unit.test.ts`
- **`browser`** — Chromium via `@vitest/browser-playwright`, runs `visualiser/src/__tests__/**/*.browser.test.ts`

Test fixtures in `visualiser/src/__tests__/fixtures.ts` (`makeGraphNode`, `makeGraphEdge`, `makeLayoutNode`, `buildGraphData`).

## Conventions

- Pure logic lives in `*-utils.ts` files for direct unit testing
- Browser tests use `.browser.test.ts` suffix; unit tests use `.unit.test.ts`
- Always verify `node visualiser/build.mjs` after changing visualiser source
