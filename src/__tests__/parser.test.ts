import { describe, it, expect } from "vitest";
import { parseSource } from "../parser.js";

describe("parseSource - function declarations", () => {
  it("extracts a named function declaration", () => {
    const parsed = parseSource("/test/file.ts", `function hello() { return 1; }`);
    expect(parsed.functions).toHaveLength(1);
    expect(parsed.functions[0].qualifiedName).toBe("hello");
    expect(parsed.functions[0].isInstrumented).toBe(false);
  });

  it("extracts exported function declarations", () => {
    const parsed = parseSource("/test/file.ts", `export function greet() { return "hi"; }`);
    expect(parsed.functions).toHaveLength(1);
    expect(parsed.exportedNames.get("greet")).toBe("greet");
  });
});

describe("parseSource - arrow functions", () => {
  it("extracts arrow function variable declarations", () => {
    const parsed = parseSource("/test/file.ts", `const add = (a: number, b: number) => a + b;`);
    expect(parsed.functions).toHaveLength(1);
    expect(parsed.functions[0].qualifiedName).toBe("add");
    expect(parsed.functions[0].isInstrumented).toBe(false);
  });

  it("extracts exported arrow functions", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `export const multiply = (a: number, b: number) => a * b;`,
    );
    expect(parsed.functions).toHaveLength(1);
    expect(parsed.exportedNames.get("multiply")).toBe("multiply");
  });
});

describe("parseSource - class methods", () => {
  it("extracts instance methods", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `class Foo {
        bar() { return 1; }
        baz() { return 2; }
      }`,
    );
    const names = parsed.functions.map((f) => f.qualifiedName);
    expect(names).toContain("Foo.bar");
    expect(names).toContain("Foo.baz");
  });

  it("extracts static methods", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `class MyService {
        static create() { return new MyService(); }
      }`,
    );
    expect(parsed.functions).toHaveLength(1);
    expect(parsed.functions[0].qualifiedName).toBe("MyService.create");
  });

  it("extracts new expression as constructor call site", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `class MyService {
        static create() { return new MyService(); }
      }`,
    );
    const createFn = parsed.functions.find((f) => f.qualifiedName === "MyService.create");
    expect(createFn!.callSites).toEqual([
      expect.objectContaining({ objectName: "MyService", propertyName: "constructor" }),
    ]);
  });

  it("resolves this.method() calls to the enclosing class", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `class MyService {
        run() { this.helper(); this.cleanup(); }
        helper() {}
        cleanup() {}
      }`,
    );
    const runFn = parsed.functions.find((f) => f.qualifiedName === "MyService.run");
    expect(runFn!.callSites).toEqual([
      expect.objectContaining({ objectName: "MyService", propertyName: "helper" }),
      expect.objectContaining({ objectName: "MyService", propertyName: "cleanup" }),
    ]);
  });

  it("extracts constructor call sites", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `class MyService {
        constructor() { init(); setup(); }
        process() { run(); }
      }`,
    );
    const names = parsed.functions.map((f) => f.qualifiedName);
    expect(names).toContain("MyService.constructor");
    expect(names).toContain("MyService.process");
    const ctorFn = parsed.functions.find((f) => f.qualifiedName === "MyService.constructor");
    const callNames = ctorFn!.callSites.map((c) => c.calleeName).filter(Boolean);
    expect(callNames).toContain("init");
    expect(callNames).toContain("setup");
  });

  it("extracts getter and setter call sites", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `class Config {
        get value() { return compute(); }
        set value(v: string) { validate(v); }
      }`,
    );
    const names = parsed.functions.map((f) => f.qualifiedName);
    expect(names).toContain("Config.get value");
    expect(names).toContain("Config.set value");
    const getter = parsed.functions.find((f) => f.qualifiedName === "Config.get value");
    expect(getter!.callSites.map((c) => c.calleeName).filter(Boolean)).toContain("compute");
    const setter = parsed.functions.find((f) => f.qualifiedName === "Config.set value");
    expect(setter!.callSites.map((c) => c.calleeName).filter(Boolean)).toContain("validate");
  });

  it("marks class exported in exportedNames", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `export class Worker {
        process() {}
      }`,
    );
    expect(parsed.exportedNames.get("Worker")).toBe("Worker");
  });
});

describe("parseSource - imports", () => {
  it("extracts named imports", () => {
    const parsed = parseSource("/test/file.ts", `import { foo, bar } from './utils';`);
    expect(parsed.imports).toHaveLength(2);
    expect(parsed.imports[0]).toMatchObject({
      localName: "foo",
      importedName: "foo",
      moduleSpecifier: "./utils",
      isNamespace: false,
    });
    expect(parsed.imports[1]).toMatchObject({
      localName: "bar",
      importedName: "bar",
      moduleSpecifier: "./utils",
      isNamespace: false,
    });
  });

  it("extracts default imports", () => {
    const parsed = parseSource("/test/file.ts", `import MyDefault from './module';`);
    expect(parsed.imports).toHaveLength(1);
    expect(parsed.imports[0]).toMatchObject({
      localName: "MyDefault",
      importedName: "default",
      isNamespace: false,
    });
  });

  it("extracts namespace imports", () => {
    const parsed = parseSource("/test/file.ts", `import * as utils from './utils';`);
    expect(parsed.imports).toHaveLength(1);
    expect(parsed.imports[0]).toMatchObject({
      localName: "utils",
      importedName: "*",
      isNamespace: true,
    });
  });

  it("extracts aliased imports", () => {
    const parsed = parseSource("/test/file.ts", `import { original as renamed } from './mod';`);
    expect(parsed.imports).toHaveLength(1);
    expect(parsed.imports[0]).toMatchObject({
      localName: "renamed",
      importedName: "original",
    });
  });
});

describe("parseSource - re-exports", () => {
  it("extracts re-exports", () => {
    const parsed = parseSource("/test/file.ts", `export { foo } from './bar';`);
    expect(parsed.reExports).toHaveLength(1);
    expect(parsed.reExports[0]).toMatchObject({
      exportedName: "foo",
      importedName: "foo",
      moduleSpecifier: "./bar",
    });
    expect(parsed.exportedNames.get("foo")).toBe("foo");
  });

  it("extracts aliased re-exports", () => {
    const parsed = parseSource("/test/file.ts", `export { original as renamed } from './source';`);
    expect(parsed.reExports).toHaveLength(1);
    expect(parsed.reExports[0]).toMatchObject({
      exportedName: "renamed",
      importedName: "original",
      moduleSpecifier: "./source",
    });
  });
});

describe("parseSource - call sites", () => {
  it("extracts simple function calls", () => {
    const parsed = parseSource("/test/file.ts", `function main() { foo(); bar(); }`);
    const callSites = parsed.functions[0].callSites;
    const names = callSites.filter((c) => c.calleeName).map((c) => c.calleeName);
    expect(names).toContain("foo");
    expect(names).toContain("bar");
  });

  it("extracts property access calls", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `function main() { X.doStuff(); console.log("hi"); }`,
    );
    const callSites = parsed.functions[0].callSites;
    const propCalls = callSites.filter((c) => c.objectName);
    expect(propCalls).toContainEqual(
      expect.objectContaining({ objectName: "X", propertyName: "doStuff" }),
    );
    expect(propCalls).toContainEqual(
      expect.objectContaining({ objectName: "console", propertyName: "log" }),
    );
  });

  it("extracts call sites inside arrow function callbacks", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `function main() {
        items.map((item) => transform(item));
      }`,
    );
    const callSites = parsed.functions[0].callSites;
    const names = callSites.map((c) => c.calleeName).filter(Boolean);
    expect(names).toContain("transform");
  });

  it("extracts call sites inside block-body arrow callbacks", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `function main() {
        items.forEach((item) => {
          process(item);
          finalize(item);
        });
      }`,
    );
    const callSites = parsed.functions[0].callSites;
    const names = callSites.map((c) => c.calleeName).filter(Boolean);
    expect(names).toContain("process");
    expect(names).toContain("finalize");
  });
});

describe("parseSource - DI defaults", () => {
  it("extracts DI defaults with property access pattern", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `function doWork(deps = { service: RealService.run }) {
        deps.service();
      }`,
    );
    const fn = parsed.functions[0];
    expect(fn.diDefaults).toHaveLength(1);
    expect(fn.diDefaults[0]).toMatchObject({
      paramName: "deps",
      propName: "service",
      objectRef: "RealService",
      methodRef: "run",
    });
  });

  it("extracts DI defaults with simple identifier", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `function doWork(deps = { helper: realHelper }) {
        deps.helper();
      }`,
    );
    const fn = parsed.functions[0];
    expect(fn.diDefaults).toHaveLength(1);
    expect(fn.diDefaults[0]).toMatchObject({
      paramName: "deps",
      propName: "helper",
      localRef: "realHelper",
    });
  });
});

describe("parseSource - instrumentFn wrappers", () => {
  it("recognizes instrumentFn and sets isInstrumented", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `const myFunc = instrumentFn(async function myFunc() { doSomething(); });`,
    );
    expect(parsed.functions).toHaveLength(1);
    expect(parsed.functions[0].qualifiedName).toBe("myFunc");
    expect(parsed.functions[0].isInstrumented).toBe(true);
  });
});

describe("parseSource - instrumentOwnMethodsInPlace", () => {
  it("marks class methods as instrumented", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `class MyService {
        doWork() { return 1; }
        doOther() { return 2; }
      }
      instrumentOwnMethodsInPlace(MyService);`,
    );
    const methods = parsed.functions.filter((f) => f.qualifiedName !== "<module>");
    expect(methods).toHaveLength(2);
    for (const fn of methods) {
      expect(fn.isInstrumented).toBe(true);
    }
  });
});

describe("parseSource - exported names", () => {
  it("tracks local export { x, y } correctly", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `function a() {}
      function b() {}
      export { a, b };`,
    );
    expect(parsed.exportedNames.get("a")).toBe("a");
    expect(parsed.exportedNames.get("b")).toBe("b");
  });

  it("tracks aliased local exports", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `function internal() {}
      export { internal as external };`,
    );
    expect(parsed.exportedNames.get("external")).toBe("internal");
  });

  it("tracks export default assignment", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `function main() {}
      export default main;`,
    );
    expect(parsed.exportedNames.get("default")).toBe("main");
  });

  it("tracks export default function declaration", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `export default function processData() { return 1; }`,
    );
    expect(parsed.exportedNames.get("default")).toBe("processData");
    expect(parsed.exportedNames.get("processData")).toBe("processData");
  });

  it("tracks export default class declaration", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `export default class DataProcessor {
        run() { return 1; }
      }`,
    );
    expect(parsed.exportedNames.get("default")).toBe("DataProcessor");
    expect(parsed.exportedNames.get("DataProcessor")).toBe("DataProcessor");
  });
});

describe("parseSource - JSDoc descriptions", () => {
  it("extracts JSDoc description from a function declaration", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `/** Greets the user warmly. */
      function greet() { return "hi"; }`,
    );
    expect(parsed.functions[0].description).toBe("Greets the user warmly.");
  });

  it("extracts JSDoc description from an arrow function", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `/** Adds two numbers. */
      const add = (a: number, b: number) => a + b;`,
    );
    expect(parsed.functions[0].description).toBe("Adds two numbers.");
  });

  it("extracts JSDoc description from a class method", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `class Foo {
        /** Does the work. */
        bar() { return 1; }
      }`,
    );
    expect(parsed.functions[0].description).toBe("Does the work.");
  });

  it("returns undefined when no JSDoc is present", () => {
    const parsed = parseSource("/test/file.ts", `function noDoc() { return 1; }`);
    expect(parsed.functions[0].description).toBeUndefined();
  });

  it("extracts only description text, not @param/@returns tags", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `/**
       * Computes the sum.
       * @param a - first number
       * @param b - second number
       * @returns the sum
       */
      function sum(a: number, b: number) { return a + b; }`,
    );
    expect(parsed.functions[0].description).toBe("Computes the sum.");
  });

  it("extracts JSDoc from a class property arrow function", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `class Svc {
        /** Runs the process. */
        run = () => { return 1; };
      }`,
    );
    const fn = parsed.functions.find((f) => f.qualifiedName === "Svc.run");
    expect(fn?.description).toBe("Runs the process.");
  });

  it("extracts JSDoc from an object literal method", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `const Utils = {
        /** Formats a string. */
        format(s: string) { return s.trim(); }
      };`,
    );
    const fn = parsed.functions.find((f) => f.qualifiedName === "Utils.format");
    expect(fn?.description).toBe("Formats a string.");
  });

  it("extracts JSDoc from an object literal arrow property", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `const Utils = {
        /** Computes double. */
        double: (x: number) => x * 2,
      };`,
    );
    const fn = parsed.functions.find((f) => f.qualifiedName === "Utils.double");
    expect(fn?.description).toBe("Computes double.");
  });
});

describe("parseSource - object property bindings", () => {
  it("extracts shorthand properties from Object.freeze", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `function loadById() { return 1; }
      function loadMany() { return 2; }
      const FKLoader = Object.freeze({ loadById, loadMany });`,
    );
    expect(parsed.objectPropertyBindings.get("FKLoader.loadById")).toBe("loadById");
    expect(parsed.objectPropertyBindings.get("FKLoader.loadMany")).toBe("loadMany");
  });

  it("extracts inline method definitions from Object.freeze", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `const MartaLoader = Object.freeze({
        async load(id: string) { return fetch(id); },
        process(data: any) { return data; }
      });`,
    );
    expect(parsed.objectPropertyBindings.get("MartaLoader.load")).toBe("MartaLoader.load");
    expect(parsed.objectPropertyBindings.get("MartaLoader.process")).toBe("MartaLoader.process");
    const names = parsed.functions.map((f) => f.qualifiedName);
    expect(names).toContain("MartaLoader.load");
    expect(names).toContain("MartaLoader.process");
  });

  it("extracts inline arrow function properties", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `const Utils = Object.freeze({
        compute: (x: number) => x * 2,
        format: (s: string) => { return s.trim(); }
      });`,
    );
    expect(parsed.objectPropertyBindings.get("Utils.compute")).toBe("Utils.compute");
    expect(parsed.objectPropertyBindings.get("Utils.format")).toBe("Utils.format");
    const names = parsed.functions.map((f) => f.qualifiedName);
    expect(names).toContain("Utils.compute");
    expect(names).toContain("Utils.format");
  });

  it("extracts non-shorthand identifier properties", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `function realImpl() { return 42; }
      const Wrapper = Object.freeze({ fn: realImpl });`,
    );
    expect(parsed.objectPropertyBindings.get("Wrapper.fn")).toBe("realImpl");
  });

  it("extracts properties from plain object literals (no Object.freeze)", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `function doStuff() {}
      const MyObj = { doStuff };`,
    );
    expect(parsed.objectPropertyBindings.get("MyObj.doStuff")).toBe("doStuff");
  });

  it("extracts properties from exported const with inline methods (YM pattern)", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `export const YM = {
        fromDate(d: Date) { return d.getFullYear(); },
        compare: (a: number, b: number) => a - b
      };`,
    );
    expect(parsed.objectPropertyBindings.get("YM.fromDate")).toBe("YM.fromDate");
    expect(parsed.objectPropertyBindings.get("YM.compare")).toBe("YM.compare");
    expect(parsed.exportedNames.get("YM")).toBe("YM");
    const names = parsed.functions.map((f) => f.qualifiedName);
    expect(names).toContain("YM.fromDate");
    expect(names).toContain("YM.compare");
  });

  it("extracts call sites from inline method bodies", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `function validate(x: any) { return !!x; }
      const Loader = Object.freeze({
        load(id: string) { validate(id); return fetch(id); }
      });`,
    );
    const loadFn = parsed.functions.find((f) => f.qualifiedName === "Loader.load");
    expect(loadFn).toBeDefined();
    const callNames = loadFn!.callSites.map((c) => c.calleeName).filter(Boolean);
    expect(callNames).toContain("validate");
  });

  it("handles mixed shorthand and inline properties", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `function existing() { return 1; }
      const Mixed = Object.freeze({
        existing,
        inline() { return 2; },
        arrow: () => 3,
        ref: existing
      });`,
    );
    expect(parsed.objectPropertyBindings.get("Mixed.existing")).toBe("existing");
    expect(parsed.objectPropertyBindings.get("Mixed.inline")).toBe("Mixed.inline");
    expect(parsed.objectPropertyBindings.get("Mixed.arrow")).toBe("Mixed.arrow");
    expect(parsed.objectPropertyBindings.get("Mixed.ref")).toBe("existing");
  });
});

describe("parseSource - module-level call sites", () => {
  it("captures calls inside callbacks passed to method chains", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `import { run } from './runner.js';
      const app = createApp();
      app.command('go').action((opts) => {
        run(opts);
        cleanup();
      });`,
    );
    const mod = parsed.functions.find((f) => f.qualifiedName === "<module>");
    expect(mod).toBeDefined();
    const callNames = mod!.callSites.map((c) => c.calleeName).filter(Boolean);
    expect(callNames).toContain("run");
    expect(callNames).toContain("cleanup");
  });

  it("captures direct top-level expression statement calls", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `function setup() {}
      setup();`,
    );
    const mod = parsed.functions.find((f) => f.qualifiedName === "<module>");
    expect(mod).toBeDefined();
    const callNames = mod!.callSites.map((c) => c.calleeName).filter(Boolean);
    expect(callNames).toContain("setup");
  });

  it("does not create <module> when there are no expression statements", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `function hello() { return 1; }
      const greet = () => "hi";`,
    );
    const mod = parsed.functions.find((f) => f.qualifiedName === "<module>");
    expect(mod).toBeUndefined();
  });

  it("captures nested calls inside chained callback arguments", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `import { forwardBfs, sliceGraph, mergeGraphs } from './graph.js';
      program
        .option('--verbose')
        .action((opts) => {
          const graphs = sources.map((id) => forwardBfs(id));
          const merged = mergeGraphs(graphs);
          const sliced = sliceGraph(merged, sources, targets);
        });`,
    );
    const mod = parsed.functions.find((f) => f.qualifiedName === "<module>");
    expect(mod).toBeDefined();
    const callNames = mod!.callSites.map((c) => c.calleeName).filter(Boolean);
    expect(callNames).toContain("forwardBfs");
    expect(callNames).toContain("mergeGraphs");
    expect(callNames).toContain("sliceGraph");
  });

  it("captures calls inside top-level for-of loops", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `import { register } from './registry.js';
      const ENTRIES = [a, b, c];
      for (const entry of ENTRIES) {
        register(entry);
      }`,
    );
    const mod = parsed.functions.find((f) => f.qualifiedName === "<module>");
    expect(mod).toBeDefined();
    const callNames = mod!.callSites.map((c) => c.calleeName).filter(Boolean);
    expect(callNames).toContain("register");
  });

  it("captures calls inside top-level if statements", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `if (process.env.NODE_ENV === 'development') {
        enableDebug();
      }`,
    );
    const mod = parsed.functions.find((f) => f.qualifiedName === "<module>");
    expect(mod).toBeDefined();
    const callNames = mod!.callSites.map((c) => c.calleeName).filter(Boolean);
    expect(callNames).toContain("enableDebug");
  });
});

describe("parseSource - constructor field assignments", () => {
  it("extracts this._x = deps.y as a field assignment", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `class Agent {
        constructor(deps = { streamText: realStreamText }) {
          this._streamText = deps.streamText;
        }
        run() { this._streamText(); }
      }`,
    );
    const ctor = parsed.functions.find((f) => f.qualifiedName === "Agent.constructor");
    expect(ctor!.fieldAssignments).toHaveLength(1);
    expect(ctor!.fieldAssignments![0]).toMatchObject({
      fieldName: "_streamText",
      paramName: "deps",
      propName: "streamText",
    });
  });

  it("extracts this._x = localParam as a field assignment with localRef", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `class Agent {
        constructor(handler: Function) {
          this._handler = handler;
        }
      }`,
    );
    const ctor = parsed.functions.find((f) => f.qualifiedName === "Agent.constructor");
    expect(ctor!.fieldAssignments).toHaveLength(1);
    expect(ctor!.fieldAssignments![0]).toMatchObject({
      fieldName: "_handler",
      localRef: "handler",
    });
  });

  it("does not capture non-parameter assignments", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `class Agent {
        constructor(deps = { x: realX }) {
          this._computed = someGlobal.compute();
          this._literal = "hello";
        }
      }`,
    );
    const ctor = parsed.functions.find((f) => f.qualifiedName === "Agent.constructor");
    expect(ctor!.fieldAssignments).toBeUndefined();
  });

  it("does not produce fieldAssignments for non-constructor methods", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `class Agent {
        run(deps = { x: realX }) {
          this._x = deps.x;
        }
      }`,
    );
    const runFn = parsed.functions.find((f) => f.qualifiedName === "Agent.run");
    expect(runFn!.fieldAssignments).toBeUndefined();
  });
});

describe("parseSource - function signatures", () => {
  it("extracts signature from a function declaration with params and return type", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `function add(a: number, b: number): number { return a + b; }`,
    );
    expect(parsed.functions[0].signature).toBe("(a: number, b: number): number");
  });

  it("extracts signature from an arrow function", () => {
    const parsed = parseSource("/test/file.ts", `const greet = (name: string): string => name;`);
    expect(parsed.functions[0].signature).toBe("(name: string): string");
  });

  it("extracts signature without return type", () => {
    const parsed = parseSource("/test/file.ts", `function doWork(x: number) { return x * 2; }`);
    expect(parsed.functions[0].signature).toBe("(x: number)");
  });

  it("extracts signature with no parameters", () => {
    const parsed = parseSource("/test/file.ts", `function noop(): void {}`);
    expect(parsed.functions[0].signature).toBe("(): void");
  });

  it("extracts signature from a class method", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `class Svc {
        process(input: string): boolean { return true; }
      }`,
    );
    const fn = parsed.functions.find((f) => f.qualifiedName === "Svc.process");
    expect(fn?.signature).toBe("(input: string): boolean");
  });

  it("returns undefined signature for constructors", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `class Svc {
        constructor(private x: number) {}
      }`,
    );
    const fn = parsed.functions.find((f) => f.qualifiedName === "Svc.constructor");
    expect(fn?.signature).toBeUndefined();
  });
});

describe("parseSource - instance bindings", () => {
  it("extracts const x = new ClassName()", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `import { Registry } from './registry';
      const reg = new Registry();`,
    );
    expect(parsed.instanceBindings.get("reg")).toBe("Registry");
  });

  it("extracts const x = new ClassName(args)", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `class Service {}
      const svc = new Service("config", 42);`,
    );
    expect(parsed.instanceBindings.get("svc")).toBe("Service");
  });

  it("skips non-identifier constructors (new ns.Class())", () => {
    const parsed = parseSource("/test/file.ts", `const x = new ns.MyClass();`);
    expect(parsed.instanceBindings.size).toBe(0);
  });

  it("extracts multiple instance bindings in one file", () => {
    const parsed = parseSource(
      "/test/file.ts",
      `const a = new Foo();
      const b = new Bar();`,
    );
    expect(parsed.instanceBindings.get("a")).toBe("Foo");
    expect(parsed.instanceBindings.get("b")).toBe("Bar");
  });
});
