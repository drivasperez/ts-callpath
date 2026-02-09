#!/usr/bin/env node
import { Command } from "commander";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { makeFunctionId } from "./types.js";
import type { FunctionId } from "./types.js";
import { Resolver } from "./resolver.js";
import { forwardBfs, sliceGraph, mergeGraphs } from "./graph.js";
import { renderDot, renderJson } from "./dotRenderer.js";
import { renderHtml } from "./htmlRenderer.js";
import { loadCodeowners } from "./codeowners.js";

function findGitRoot(): string {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
    }).trim();
  } catch {
    return process.cwd();
  }
}

/**
 * Parse a user-provided function spec.
 * Accepts:
 *   "path/to/file.ts"            → all symbols in the file
 *   "path/to/file.ts::funcName"  → single symbol
 *   "path/to/file.ts::a|b|C.m"  → pipe-separated symbols
 * The path can be relative to the repo root.
 */
function parseUserFunctionSpecs(
  spec: string,
  repoRoot: string,
): { filePath: string; qualifiedNames: string[] } {
  const sep = spec.indexOf("::");

  let rawPath: string;
  let qualifiedNames: string[];

  if (sep === -1) {
    // Bare file path → all symbols
    rawPath = spec;
    qualifiedNames = [];
  } else {
    rawPath = spec.slice(0, sep);
    const symbolPart = spec.slice(sep + 2);
    qualifiedNames = symbolPart.split("|").filter(Boolean);
  }

  let filePath = rawPath;
  if (!path.isAbsolute(filePath)) {
    filePath = path.resolve(repoRoot, filePath);
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  return { filePath, qualifiedNames };
}

/**
 * Expand parsed specs into resolved FunctionIds using the resolver.
 */
function resolveSpecs(
  specs: { filePath: string; qualifiedNames: string[] },
  resolver: Resolver,
): FunctionId[] {
  const file = resolver.getFile(specs.filePath);
  if (!file) {
    process.stderr.write(`Error: cannot parse ${specs.filePath}\n`);
    process.exit(1);
  }

  // Empty qualifiedNames = all functions in the file
  if (specs.qualifiedNames.length === 0) {
    return file.functions.map((f) => makeFunctionId(specs.filePath, f.qualifiedName));
  }

  // Resolve each named symbol (through bindings)
  const ids: FunctionId[] = [];
  for (const name of specs.qualifiedNames) {
    const resolved = resolver.resolveQualifiedName(specs.filePath, name);
    if (resolved) {
      ids.push(makeFunctionId(specs.filePath, resolved.qualifiedName));
    } else {
      process.stderr.write(`Warning: "${name}" not found in ${specs.filePath}\n`);
    }
  }
  return ids;
}

const program = new Command();

program
  .name("ts-callpath")
  .description("Find call paths between two TypeScript functions")
  .argument("<source>", "Source: file.ts (all symbols), file.ts::func, or file.ts::a|b|c")
  .argument("[target]", "Target: file.ts (all symbols), file.ts::func, or file.ts::a|b|c")
  .option("--max-depth <n>", "BFS depth limit", "20")
  .option("--max-nodes <n>", "Node limit", "500")
  .option("--root <dir>", "Repo root directory")
  .option("-o, --output <file>", "Write output to file (default: stdout)")
  .option("--tsconfig <path>", "Path to tsconfig.json (auto-detected if omitted)")
  .option("--verbose", "Show progress on stderr", false)
  .option("--json", "Output JSON instead of DOT", false)
  .option("--html", "Output self-contained HTML visualizer", false)
  .option("--editor <name>", "Editor for open-in-editor links (cursor, vscode, zed)", "cursor")
  .option("--open", "Write to a temp file and open it", false)
  .option(
    "--full",
    "Output full forward BFS graph (no slicing; implied when target is omitted)",
    false,
  )
  .action(
    (
      sourceSpec: string,
      targetSpec: string | undefined,
      opts: {
        maxDepth: string;
        maxNodes: string;
        root?: string;
        output?: string;
        tsconfig?: string;
        verbose: boolean;
        json: boolean;
        html: boolean;
        editor: string;
        open: boolean;
        full: boolean;
      },
    ) => {
      const hasTarget = targetSpec != null;
      const impliedFull = opts.full || !hasTarget;
      const repoRoot = opts.root ?? findGitRoot();
      const maxDepth = Number(opts.maxDepth);
      const maxNodes = Number(opts.maxNodes);

      if (
        !Number.isInteger(maxDepth) ||
        !Number.isInteger(maxNodes) ||
        maxDepth < 0 ||
        maxNodes < 0
      ) {
        process.stderr.write(
          `Error: --max-depth and --max-nodes must be non-negative integers (got depth="${opts.maxDepth}", nodes="${opts.maxNodes}")\n`,
        );
        process.exit(1);
      }

      if (opts.verbose) {
        process.stderr.write(`Repo root: ${repoRoot}\n`);
      }

      // Parse source spec
      const sourceSpecs = parseUserFunctionSpecs(sourceSpec, repoRoot);

      const resolver = new Resolver(repoRoot, {
        verbose: opts.verbose,
        tsconfigPath: opts.tsconfig ? path.resolve(opts.tsconfig) : undefined,
      });

      // Resolve source specs
      const sourceIds = resolveSpecs(sourceSpecs, resolver);

      if (sourceIds.length === 0) {
        process.stderr.write(`Error: no functions resolved for source "${sourceSpec}"\n`);
        process.exit(1);
      }

      // Parse and resolve target specs (only when target is provided)
      let targetIds: FunctionId[] = [];
      if (hasTarget) {
        const targetSpecs = parseUserFunctionSpecs(targetSpec, repoRoot);
        targetIds = resolveSpecs(targetSpecs, resolver);

        if (targetIds.length === 0) {
          process.stderr.write(`Error: no functions resolved for target "${targetSpec}"\n`);
          process.exit(1);
        }
      }

      if (opts.verbose) {
        process.stderr.write(`Source IDs (${sourceIds.length}):\n`);
        for (const id of sourceIds) process.stderr.write(`  ${id}\n`);
        if (hasTarget) {
          process.stderr.write(`Target IDs (${targetIds.length}):\n`);
          for (const id of targetIds) process.stderr.write(`  ${id}\n`);
        }
        process.stderr.write(`Max depth: ${maxDepth}, Max nodes: ${maxNodes}\n`);
        process.stderr.write("\nBuilding call graph (forward BFS)...\n");
      }

      const startTime = Date.now();

      // Forward BFS from each source, merge results
      const bfsGraphs = sourceIds.map((id) =>
        forwardBfs(id, resolver, { maxDepth, maxNodes, verbose: opts.verbose }),
      );
      const fullGraph = bfsGraphs.length === 1 ? bfsGraphs[0] : mergeGraphs(bfsGraphs);

      const bfsTime = Date.now() - startTime;

      if (opts.verbose) {
        process.stderr.write(
          `\nForward BFS complete: ${fullGraph.nodes.size} nodes, ${fullGraph.edges.length} edges (${bfsTime}ms)\n`,
        );
      }

      const targetIdSet = new Set(targetIds);
      const sourceIdSet = new Set(sourceIds);

      // Check if any target was reached
      const anyTargetReached = hasTarget && targetIds.some((id) => fullGraph.nodes.has(id));
      if (hasTarget && !anyTargetReached && !impliedFull) {
        process.stderr.write(`\nWarning: no target functions reached in BFS.\n`);
        process.stderr.write(
          `  The targets may be unreachable from the sources within ${maxDepth} hops,\n`,
        );
        process.stderr.write(
          `  or the calls may go through unresolvable patterns (method calls on variables, etc.)\n`,
        );
        process.stderr.write(
          `\nTip: try --full to see the full BFS graph, or --max-depth to increase depth.\n`,
        );

        if (opts.verbose) {
          process.stderr.write(`\nOutputting full forward BFS graph instead.\n`);
        }
      }

      // Slice to paths from sources to targets (unless --full/implied or no target reachable)
      let outputGraph = fullGraph;
      if (!impliedFull && anyTargetReached) {
        if (opts.verbose) {
          process.stderr.write("\nSlicing graph to source→target paths...\n");
        }
        const reachableTargets = targetIds.filter((id) => fullGraph.nodes.has(id));
        outputGraph = sliceGraph(fullGraph, sourceIds, reachableTargets);
        if (opts.verbose) {
          process.stderr.write(
            `Sliced: ${outputGraph.nodes.size} nodes, ${outputGraph.edges.length} edges\n`,
          );
        }
      }

      // Load CODEOWNERS if available
      const codeownersRules = loadCodeowners(repoRoot);

      // Render output
      const dotOptions = {
        repoRoot,
        sourceIds: sourceIdSet,
        targetIds: targetIdSet,
        ...(codeownersRules ? { codeownersRules } : {}),
        ...(opts.html ? { includeSource: true, editor: opts.editor } : {}),
      };
      let output: string;
      if (opts.html) {
        output = renderHtml(renderJson(outputGraph, dotOptions));
      } else if (opts.json) {
        output = JSON.stringify(renderJson(outputGraph, dotOptions), null, 2);
      } else {
        output = renderDot(outputGraph, dotOptions);
      }

      if (opts.open) {
        const ext = opts.html ? ".html" : opts.json ? ".json" : ".dot";
        const tmpFile = path.join(os.tmpdir(), `ts-callpath-${Date.now()}${ext}`);
        fs.writeFileSync(tmpFile, output);
        if (opts.verbose) {
          process.stderr.write(`Opening ${tmpFile}\n`);
        }
        execSync(`open ${JSON.stringify(tmpFile)}`);
      } else if (opts.output) {
        fs.writeFileSync(opts.output, output);
        if (opts.verbose) {
          process.stderr.write(`Output written to ${opts.output}\n`);
        }
      } else {
        process.stdout.write(output + "\n");
      }

      const totalTime = Date.now() - startTime;
      if (opts.verbose) {
        process.stderr.write(`\nTotal time: ${totalTime}ms\n`);
      }
    },
  );

program.parse();
