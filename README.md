# ts-callpath

Find and visualize call paths between TypeScript functions. Given a source and target, `ts-callpath` builds a call graph via BFS, slices it to only the nodes on connecting paths, and outputs DOT, JSON, or a self-contained interactive HTML visualizer.

## Usage

```bash
npx tsx tools/ts-callpath/src/cli.ts <source> <target> [options]

# or from within the tool directory:
pnpm callpath -- <source> <target> [options]
```

### Selectors

Both `<source>` and `<target>` accept three selector formats:

| Format                            | Meaning                          |
| --------------------------------- | -------------------------------- |
| `path/to/file.ts`                 | All functions in the file        |
| `path/to/file.ts::funcName`       | A single function                |
| `path/to/file.ts::a\|b\|C.method` | Pipe-separated list of functions |

Paths are resolved relative to the repo root (auto-detected via `git`). Qualified names use `ClassName.methodName` for methods.

### Options

| Flag                  | Default  | Description                                                 |
| --------------------- | -------- | ----------------------------------------------------------- |
| `--max-depth <n>`     | `20`     | Maximum BFS depth                                           |
| `--max-nodes <n>`     | `500`    | Maximum number of nodes to explore                          |
| `--root <dir>`        | git root | Override repo root directory                                |
| `-o, --output <file>` | stdout   | Write output to a file                                      |
| `--verbose`           | off      | Print progress info to stderr                               |
| `--json`              | off      | Output JSON instead of DOT                                  |
| `--html`              | off      | Output self-contained HTML visualizer                       |
| `--open`              | off      | Write to a temp file and open it                            |
| `--editor <name>`     | `cursor` | Editor for open-in-editor links (`cursor`, `vscode`, `zed`) |
| `--full`              | off      | Output the full BFS graph without slicing                   |

### Examples

```bash
# Single source to single target (DOT output)
npx tsx tools/ts-callpath/src/cli.ts \
  'workspaces/domain/foo.ts::processData' \
  'workspaces/db/db/FKLoader.ts::FKLoader.loadById'

# Interactive HTML visualizer
npx tsx tools/ts-callpath/src/cli.ts \
  'workspaces/domain/foo.ts::processData' \
  'workspaces/db/db/FKLoader.ts::FKLoader.loadById' \
  --html -o graph.html

# All functions in a file as source
npx tsx tools/ts-callpath/src/cli.ts \
  'workspaces/domain/foo.ts' \
  'workspaces/db/db/FKLoader.ts::FKLoader.loadById' --verbose

# Multiple targets via pipe separator
npx tsx tools/ts-callpath/src/cli.ts \
  'workspaces/domain/foo.ts::processData' \
  'workspaces/db/db/FKLoader.ts::FKLoader.loadById|FKLoader.loadManyByProp'

# JSON output to file
npx tsx tools/ts-callpath/src/cli.ts \
  'src/a.ts::main' 'src/b.ts::target' --json -o graph.json
```

## Output Formats

### DOT (default)

A Graphviz digraph with file-based subgraph clusters. Source nodes are colored green, target nodes red, and instrumented (wrapper) nodes yellow. Edge styles indicate the resolution kind (direct, DI, re-export, etc.).

```bash
npx tsx tools/ts-callpath/src/cli.ts <source> <target> | dot -Tsvg -o graph.svg
```

### JSON (`--json`)

An object with `nodes` and `edges` arrays. Each node includes `isSource`/`isTarget` flags and relative file paths.

### HTML Visualizer (`--html`)

A self-contained HTML file with an interactive graph viewer. Features:

- **Pan & zoom** — mouse drag to pan, scroll/pinch to zoom
- **Path highlighting** — click a node to highlight all connected paths
- **File clusters** — functions grouped by file with collapsible clusters
- **Search** — press `/` or `Ctrl+K` to search functions by name
- **Focus mode** — right-click a node to focus on its connected subgraph
- **Source preview** — right-click to view source snippets inline
- **Keyboard shortcuts** — `F` fit all, `C` collapse all, `E` expand all, `L` toggle legend

```bash
npx tsx tools/ts-callpath/src/cli.ts <source> <target> --html --open

# or write to a specific file:
npx tsx tools/ts-callpath/src/cli.ts <source> <target> --html -o graph.html
```

## Algorithm

### 1. Parsing

Each TypeScript file is parsed on-demand using the TypeScript compiler API. The parser extracts:

- **Functions** (top-level, class methods, object-literal methods, arrow functions assigned to variables)
- **Call sites** within each function body (simple calls and property-access calls like `Foo.bar()`)
- **Imports** and **re-exports** for cross-file resolution
- **Object-property bindings** (e.g. `const FKLoader = { loadById }` maps `FKLoader.loadById` to the standalone `loadById` function)
- **DI default parameters** (dependency injection patterns where default parameter values reference other functions)

### 2. Forward BFS

Starting from each source function, the tool performs a breadth-first search over the call graph:

1. Parse the source file, find the source function
2. For each call site in the current function, resolve the callee:
   - **Direct calls** (`foo()`) &rarr; look up `foo` in the current file or via imports
   - **Property-access calls** (`X.method()`) &rarr; resolve `X` through imports, then look up `method` as a static method, object-property binding, or class method
   - **DI defaults** &rarr; follow default parameter values to their implementations
   - **Re-exports** &rarr; follow `export { x } from './y'` chains
3. Add discovered nodes and edges to the graph
4. Continue BFS until `--max-depth` or `--max-nodes` is reached

When multiple sources are specified, BFS runs independently from each source and the results are merged (deduplicating edges).

### 3. Graph slicing

Unless `--full` is passed, the raw BFS graph is sliced to keep only nodes that lie on a path from **any** source to **any** target:

1. Compute **forward-reachable** nodes from all sources (BFS on forward edges)
2. Compute **backward-reachable** nodes from all targets (BFS on reverse edges)
3. Keep the **intersection** &mdash; these are exactly the nodes on source-to-target paths
4. Build the induced subgraph (edges between kept nodes)

### 4. Layout (HTML mode)

The HTML visualizer uses a custom layered graph layout algorithm:

1. **Backedge detection** — DFS to find cycle edges
2. **Layer assignment** — Kahn's topological sort with longest-path layering
3. **Dummy nodes** — inserted for edges spanning multiple layers
4. **Node ordering** — barycenter heuristic with file-cluster grouping to minimize crossings
5. **Coordinate assignment** — column-based positioning with cluster alignment
6. **Edge routing** — orthogonal paths with rounded corners; backedges routed around the right side

## Development

```bash
bun install                        # install deps

bun test                           # all tests, watch mode
bun test:unit                      # unit tests only, watch mode
bun test:browser                   # browser tests only, watch mode
bun test:ci                        # all tests, single run
bun typecheck                      # type-check, watch mode
bun typecheck:ci                   # type-check, single run
bun build:visualiser               # bundle the visualiser
```

### Project structure

```
src/                          CLI, parser, graph builder, DOT/JSON/HTML renderers
src/__tests__/                Core unit tests
visualiser/src/               Browser-side graph layout and rendering
  layout.ts                   layoutGraph orchestrator
  layout-utils.ts             Pure layout algorithms
  render.ts                   DOM rendering, pan/zoom, interactions
  render-utils.ts             Pure render helpers (colors, paths, labels, filtering)
  types.ts                    Shared types
  main.ts                     Entry point (bundled by esbuild)
visualiser/src/__tests__/     Visualiser tests
  *.unit.test.ts              Node unit tests (vitest)
  *.browser.test.ts           Browser tests (vitest + Playwright)
  fixtures.ts                 Shared test helpers
```
