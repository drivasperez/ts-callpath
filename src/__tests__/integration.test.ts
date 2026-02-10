import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Resolver } from "../resolver.js";
import { forwardBfs, sliceGraph } from "../graph.js";
import { makeFunctionId } from "../types.js";

describe("integration: parser + resolver + graph", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-callpath-test-"));

    // File A: imports from B, calls B.process and helper
    fs.writeFileSync(
      path.join(tmpDir, "a.ts"),
      `import { helper } from './b';
import { Worker } from './c';

export function main() {
  const result = helper();
  Worker.process(result);
}
`,
    );

    // File B: exports helper, imports from C
    fs.writeFileSync(
      path.join(tmpDir, "b.ts"),
      `import { transform } from './c';

export function helper() {
  return transform("data");
}
`,
    );

    // File C: exports Worker class with a process method, and transform
    fs.writeFileSync(
      path.join(tmpDir, "c.ts"),
      `export function transform(input: string) {
  return input.toUpperCase();
}

export class Worker {
  static process(data: string) {
    return data;
  }
}
`,
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("forwardBfs discovers all reachable functions", () => {
    const resolver = new Resolver(tmpDir);
    const sourceId = makeFunctionId(path.join(tmpDir, "a.ts"), "main");

    const graph = forwardBfs(sourceId, resolver, {
      maxDepth: 10,
      maxNodes: 100,
      verbose: false,
    });

    // Should find: main, helper, Worker.process, transform
    expect(graph.nodes.size).toBeGreaterThanOrEqual(3);

    const nodeNames = Array.from(graph.nodes.values()).map((n) => n.qualifiedName);
    expect(nodeNames).toContain("main");
    expect(nodeNames).toContain("helper");
    expect(nodeNames).toContain("transform");
  });

  it("sliceGraph finds path from main to transform", () => {
    const resolver = new Resolver(tmpDir);
    const sourceId = makeFunctionId(path.join(tmpDir, "a.ts"), "main");
    const targetId = makeFunctionId(path.join(tmpDir, "c.ts"), "transform");

    const fullGraph = forwardBfs(sourceId, resolver, {
      maxDepth: 10,
      maxNodes: 100,
      verbose: false,
    });

    const sliced = sliceGraph(fullGraph, [sourceId], [targetId]);

    // Path: main → helper → transform
    expect(sliced.nodes.size).toBeGreaterThanOrEqual(3);

    const nodeNames = Array.from(sliced.nodes.values()).map((n) => n.qualifiedName);
    expect(nodeNames).toContain("main");
    expect(nodeNames).toContain("helper");
    expect(nodeNames).toContain("transform");

    // Should have at least 2 edges in the path
    expect(sliced.edges.length).toBeGreaterThanOrEqual(2);
  });

  it("sliceGraph finds path from main to Worker.process", () => {
    const resolver = new Resolver(tmpDir);
    const sourceId = makeFunctionId(path.join(tmpDir, "a.ts"), "main");
    const targetId = makeFunctionId(path.join(tmpDir, "c.ts"), "Worker.process");

    const fullGraph = forwardBfs(sourceId, resolver, {
      maxDepth: 10,
      maxNodes: 100,
      verbose: false,
    });

    const sliced = sliceGraph(fullGraph, [sourceId], [targetId]);

    // Path: main → Worker.process (direct)
    expect(sliced.nodes.size).toBeGreaterThanOrEqual(2);

    const nodeNames = Array.from(sliced.nodes.values()).map((n) => n.qualifiedName);
    expect(nodeNames).toContain("main");
    expect(nodeNames).toContain("Worker.process");
  });

  it("sliceGraph excludes nodes not on the target path", () => {
    const resolver = new Resolver(tmpDir);
    const sourceId = makeFunctionId(path.join(tmpDir, "a.ts"), "main");
    const targetId = makeFunctionId(path.join(tmpDir, "c.ts"), "Worker.process");

    const fullGraph = forwardBfs(sourceId, resolver, {
      maxDepth: 10,
      maxNodes: 100,
      verbose: false,
    });

    const sliced = sliceGraph(fullGraph, [sourceId], [targetId]);

    // helper and transform should NOT be in the slice to Worker.process
    // since the path is main → Worker.process directly
    const nodeNames = Array.from(sliced.nodes.values()).map((n) => n.qualifiedName);
    expect(nodeNames).not.toContain("transform");
  });
});

describe("integration: object-literal property resolution", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-callpath-objlit-test-"));

    // fkloader.ts: FKLoader pattern — shorthand properties referencing standalone functions
    fs.writeFileSync(
      path.join(tmpDir, "fkloader.ts"),
      `function validate(id: string) { return !!id; }

function loadById(id: string) {
  validate(id);
  return { id };
}

function loadMany(ids: string[]) {
  return ids.map((id) => loadById(id));
}

const FKLoader = Object.freeze({ loadById, loadMany });
export default FKLoader;
`,
    );

    // martaloader.ts: inline method definitions
    fs.writeFileSync(
      path.join(tmpDir, "martaloader.ts"),
      `function transform(data: any) { return data; }

export const MartaLoader = Object.freeze({
  async fetch(id: string) {
    const raw = await Promise.resolve(id);
    return transform(raw);
  },
  process(data: any) {
    return transform(data);
  }
});
`,
    );

    // ym.ts: exported const plain object (YM pattern)
    fs.writeFileSync(
      path.join(tmpDir, "ym.ts"),
      `export const YM = {
  fromDate(d: Date) { return d.getFullYear() * 12 + d.getMonth(); },
  compare: (a: number, b: number) => a - b
};
`,
    );

    // caller.ts: imports all three and calls their methods
    fs.writeFileSync(
      path.join(tmpDir, "caller.ts"),
      `import FKLoader from './fkloader';
import { MartaLoader } from './martaloader';
import { YM } from './ym';

export function main() {
  FKLoader.loadById("abc");
  MartaLoader.fetch("xyz");
  YM.fromDate(new Date());
}
`,
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("forwardBfs discovers FKLoader shorthand-referenced functions", () => {
    const resolver = new Resolver(tmpDir);
    const sourceId = makeFunctionId(path.join(tmpDir, "caller.ts"), "main");

    const graph = forwardBfs(sourceId, resolver, {
      maxDepth: 10,
      maxNodes: 100,
      verbose: false,
    });

    const nodeNames = Array.from(graph.nodes.values()).map((n) => n.qualifiedName);
    expect(nodeNames).toContain("main");
    expect(nodeNames).toContain("loadById");
    expect(nodeNames).toContain("validate");
  });

  it("forwardBfs discovers MartaLoader inline method functions", () => {
    const resolver = new Resolver(tmpDir);
    const sourceId = makeFunctionId(path.join(tmpDir, "caller.ts"), "main");

    const graph = forwardBfs(sourceId, resolver, {
      maxDepth: 10,
      maxNodes: 100,
      verbose: false,
    });

    const nodeNames = Array.from(graph.nodes.values()).map((n) => n.qualifiedName);
    expect(nodeNames).toContain("MartaLoader.fetch");
    expect(nodeNames).toContain("transform");
  });

  it("forwardBfs discovers YM exported const methods", () => {
    const resolver = new Resolver(tmpDir);
    const sourceId = makeFunctionId(path.join(tmpDir, "caller.ts"), "main");

    const graph = forwardBfs(sourceId, resolver, {
      maxDepth: 10,
      maxNodes: 100,
      verbose: false,
    });

    const nodeNames = Array.from(graph.nodes.values()).map((n) => n.qualifiedName);
    expect(nodeNames).toContain("YM.fromDate");
  });

  it("sliceGraph finds transitive path main → loadById → validate", () => {
    const resolver = new Resolver(tmpDir);
    const sourceId = makeFunctionId(path.join(tmpDir, "caller.ts"), "main");
    const targetId = makeFunctionId(path.join(tmpDir, "fkloader.ts"), "validate");

    const fullGraph = forwardBfs(sourceId, resolver, {
      maxDepth: 10,
      maxNodes: 100,
      verbose: false,
    });

    const sliced = sliceGraph(fullGraph, [sourceId], [targetId]);

    const nodeNames = Array.from(sliced.nodes.values()).map((n) => n.qualifiedName);
    expect(nodeNames).toContain("main");
    expect(nodeNames).toContain("loadById");
    expect(nodeNames).toContain("validate");
    expect(sliced.edges.length).toBeGreaterThanOrEqual(2);
  });
});

describe("integration: tsconfig paths resolution", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-callpath-paths-test-"));

    // tsconfig.json with paths alias
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@mylib/*": ["lib/*"],
            },
            target: "ESNext",
            moduleResolution: "Node10",
            esModuleInterop: true,
          },
        },
        null,
        2,
      ),
    );

    // lib/utils.ts: the aliased module
    fs.mkdirSync(path.join(tmpDir, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "lib", "utils.ts"),
      `export function doWork(input: string) {
  return input.toUpperCase();
}
`,
    );

    // app.ts: imports via @mylib/utils alias
    fs.writeFileSync(
      path.join(tmpDir, "app.ts"),
      `import { doWork } from '@mylib/utils';

export function main() {
  return doWork("hello");
}
`,
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves @mylib/utils via tsconfig paths", () => {
    const resolver = new Resolver(tmpDir);
    const sourceId = makeFunctionId(path.join(tmpDir, "app.ts"), "main");

    const graph = forwardBfs(sourceId, resolver, {
      maxDepth: 10,
      maxNodes: 100,
      verbose: false,
    });

    const nodeNames = Array.from(graph.nodes.values()).map((n) => n.qualifiedName);
    expect(nodeNames).toContain("main");
    expect(nodeNames).toContain("doWork");
  });

  it("slices path from main to doWork via alias", () => {
    const resolver = new Resolver(tmpDir);
    const sourceId = makeFunctionId(path.join(tmpDir, "app.ts"), "main");
    const targetId = makeFunctionId(path.join(tmpDir, "lib", "utils.ts"), "doWork");

    const fullGraph = forwardBfs(sourceId, resolver, {
      maxDepth: 10,
      maxNodes: 100,
      verbose: false,
    });

    const sliced = sliceGraph(fullGraph, [sourceId], [targetId]);
    const nodeNames = Array.from(sliced.nodes.values()).map((n) => n.qualifiedName);
    expect(nodeNames).toContain("main");
    expect(nodeNames).toContain("doWork");
    expect(sliced.edges.length).toBeGreaterThanOrEqual(1);
  });
});

describe("integration: constructor field assignment DI resolution", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-callpath-field-di-test-"));

    // streamText.ts: the imported function that the DI default points to
    fs.writeFileSync(
      path.join(tmpDir, "streamText.ts"),
      `export function streamText(prompt: string) {
  return "streamed: " + prompt;
}
`,
    );

    // agent.ts: class with constructor DI → field assignment → method calling this._field()
    fs.writeFileSync(
      path.join(tmpDir, "agent.ts"),
      `import { streamText } from './streamText';

export class Agent {
  private _streamText: typeof streamText;

  constructor(deps = { streamText }) {
    this._streamText = deps.streamText;
  }

  run() {
    return this._streamText("hello");
  }
}
`,
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves this._streamText() through constructor field assignment to imported function", () => {
    const resolver = new Resolver(tmpDir);
    const sourceId = makeFunctionId(path.join(tmpDir, "agent.ts"), "Agent.run");

    const graph = forwardBfs(sourceId, resolver, {
      maxDepth: 10,
      maxNodes: 100,
      verbose: false,
    });

    const nodeNames = Array.from(graph.nodes.values()).map((n) => n.qualifiedName);
    expect(nodeNames).toContain("Agent.run");
    expect(nodeNames).toContain("streamText");
  });

  it("produces a di-default edge kind for the field assignment resolution", () => {
    const resolver = new Resolver(tmpDir);
    const sourceId = makeFunctionId(path.join(tmpDir, "agent.ts"), "Agent.run");

    const graph = forwardBfs(sourceId, resolver, {
      maxDepth: 10,
      maxNodes: 100,
      verbose: false,
    });

    const diEdges = graph.edges.filter((e) => e.kind === "di-default");
    expect(diEdges.length).toBeGreaterThanOrEqual(1);
  });

  it("slices path from Agent.run to streamText through DI field", () => {
    const resolver = new Resolver(tmpDir);
    const sourceId = makeFunctionId(path.join(tmpDir, "agent.ts"), "Agent.run");
    const targetId = makeFunctionId(path.join(tmpDir, "streamText.ts"), "streamText");

    const fullGraph = forwardBfs(sourceId, resolver, {
      maxDepth: 10,
      maxNodes: 100,
      verbose: false,
    });

    const sliced = sliceGraph(fullGraph, [sourceId], [targetId]);
    const nodeNames = Array.from(sliced.nodes.values()).map((n) => n.qualifiedName);
    expect(nodeNames).toContain("Agent.run");
    expect(nodeNames).toContain("streamText");
    expect(sliced.edges.length).toBeGreaterThanOrEqual(1);
  });
});

describe("integration: external package calls", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-callpath-external-test-"));

    // app.ts: imports from an external package and calls it
    fs.writeFileSync(
      path.join(tmpDir, "app.ts"),
      `import { streamText } from 'some-external-pkg';
import * as extNs from 'another-ext-pkg';

export function main() {
  streamText("hello");
  extNs.doThing();
}
`,
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes external nodes when includeExternal is true", () => {
    const resolver = new Resolver(tmpDir, { includeExternal: true });
    const sourceId = makeFunctionId(path.join(tmpDir, "app.ts"), "main");

    const graph = forwardBfs(sourceId, resolver, {
      maxDepth: 10,
      maxNodes: 100,
      verbose: false,
    });

    const nodes = Array.from(graph.nodes.values());
    const externalNodes = nodes.filter((n) => n.isExternal);
    expect(externalNodes.length).toBe(2);

    const qualifiedNames = externalNodes.map((n) => n.qualifiedName);
    expect(qualifiedNames).toContain("streamText");
    expect(qualifiedNames).toContain("doThing");

    // External nodes should have <external>:: prefix in filePath
    for (const n of externalNodes) {
      expect(n.filePath).toMatch(/^<external>::/);
      expect(n.line).toBe(0);
    }

    // Edges to external nodes should have kind "external"
    const externalEdges = graph.edges.filter((e) => e.kind === "external");
    expect(externalEdges.length).toBe(2);
  });

  it("excludes external nodes when includeExternal is false", () => {
    const resolver = new Resolver(tmpDir, { includeExternal: false });
    const sourceId = makeFunctionId(path.join(tmpDir, "app.ts"), "main");

    const graph = forwardBfs(sourceId, resolver, {
      maxDepth: 10,
      maxNodes: 100,
      verbose: false,
    });

    const nodes = Array.from(graph.nodes.values());
    const externalNodes = nodes.filter((n) => n.isExternal);
    expect(externalNodes.length).toBe(0);
  });

  it("does not enqueue external nodes for further BFS", () => {
    const resolver = new Resolver(tmpDir, { includeExternal: true });
    const sourceId = makeFunctionId(path.join(tmpDir, "app.ts"), "main");

    const graph = forwardBfs(sourceId, resolver, {
      maxDepth: 10,
      maxNodes: 100,
      verbose: false,
    });

    // External nodes should be leaf nodes (no outgoing edges from them)
    const externalIds = new Set(
      Array.from(graph.nodes.values())
        .filter((n) => n.isExternal)
        .map((n) => n.id),
    );
    for (const edge of graph.edges) {
      expect(externalIds.has(edge.callerId)).toBe(false);
    }
  });
});

describe("integration: tsconfig baseUrl resolution", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-callpath-baseurl-test-"));

    // tsconfig.json with baseUrl
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: "./src",
            target: "ESNext",
            moduleResolution: "Node10",
            esModuleInterop: true,
          },
        },
        null,
        2,
      ),
    );

    // src/utils/helper.ts
    fs.mkdirSync(path.join(tmpDir, "src", "utils"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "utils", "helper.ts"),
      `export function helper(x: number) {
  return x * 2;
}
`,
    );

    // src/app.ts: imports via baseUrl-relative path
    fs.writeFileSync(
      path.join(tmpDir, "src", "app.ts"),
      `import { helper } from 'utils/helper';

export function main() {
  return helper(42);
}
`,
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves utils/helper via tsconfig baseUrl", () => {
    const resolver = new Resolver(tmpDir);
    const sourceId = makeFunctionId(path.join(tmpDir, "src", "app.ts"), "main");

    const graph = forwardBfs(sourceId, resolver, {
      maxDepth: 10,
      maxNodes: 100,
      verbose: false,
    });

    const nodeNames = Array.from(graph.nodes.values()).map((n) => n.qualifiedName);
    expect(nodeNames).toContain("main");
    expect(nodeNames).toContain("helper");
  });

  it("slices path from main to helper via baseUrl", () => {
    const resolver = new Resolver(tmpDir);
    const sourceId = makeFunctionId(path.join(tmpDir, "src", "app.ts"), "main");
    const targetId = makeFunctionId(path.join(tmpDir, "src", "utils", "helper.ts"), "helper");

    const fullGraph = forwardBfs(sourceId, resolver, {
      maxDepth: 10,
      maxNodes: 100,
      verbose: false,
    });

    const sliced = sliceGraph(fullGraph, [sourceId], [targetId]);
    const nodeNames = Array.from(sliced.nodes.values()).map((n) => n.qualifiedName);
    expect(nodeNames).toContain("main");
    expect(nodeNames).toContain("helper");
    expect(sliced.edges.length).toBeGreaterThanOrEqual(1);
  });
});
