import ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import type {
  FunctionId,
  CallSite,
  ParsedFile,
  ParsedFunction,
  FunctionNode,
  EdgeKind,
} from "./types.js";
import { makeFunctionId } from "./types.js";
import { parseFile } from "./parser.js";

export interface ResolverOptions {
  verbose?: boolean;
  tsconfigPath?: string;
}

export class Resolver {
  private fileCache = new Map<string, ParsedFile>();
  private verbose: boolean;
  private compilerOptions: ts.CompilerOptions;

  constructor(
    private repoRoot: string,
    opts?: ResolverOptions,
  ) {
    this.verbose = opts?.verbose ?? false;
    this.compilerOptions = this.loadCompilerOptions(opts?.tsconfigPath);
  }

  private loadCompilerOptions(tsconfigPath?: string): ts.CompilerOptions {
    const configPath = tsconfigPath ?? ts.findConfigFile(this.repoRoot, ts.sys.fileExists);

    if (configPath) {
      const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
      if (!configFile.error) {
        const parsed = ts.parseJsonConfigFileContent(
          configFile.config,
          ts.sys,
          path.dirname(configPath),
        );
        if (this.verbose) {
          process.stderr.write(`  using tsconfig: ${configPath}\n`);
        }
        return parsed.options;
      }
    }

    // Fallback defaults when no tsconfig is found
    return {
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ESNext,
      esModuleInterop: true,
    };
  }

  /**
   * Parse and cache a file. Returns null if file doesn't exist or isn't TS.
   */
  getFile(filePath: string): ParsedFile | null {
    const cached = this.fileCache.get(filePath);
    if (cached) return cached;

    if (!fs.existsSync(filePath)) return null;
    if (this.verbose) {
      process.stderr.write(`  parsing ${path.relative(this.repoRoot, filePath)}\n`);
    }

    try {
      const parsed = parseFile(filePath);
      this.fileCache.set(filePath, parsed);
      return parsed;
    } catch (e) {
      if (this.verbose) {
        process.stderr.write(`  warning: failed to parse ${filePath}: ${e}\n`);
      }
      return null;
    }
  }

  /**
   * Resolve a module specifier from a given source file to an absolute file path.
   */
  resolveModule(specifier: string, fromFile: string): string | null {
    // 1. Unified resolution via ts.resolveModuleName (handles paths, baseUrl, relative, etc.)
    const result = ts.resolveModuleName(specifier, fromFile, this.compilerOptions, ts.sys);

    if (result.resolvedModule) {
      const resolved = result.resolvedModule;

      // Accept in-project (non-external) modules directly
      if (!resolved.isExternalLibraryImport) {
        return resolved.resolvedFileName;
      }

      // For external hits, check if they're actually workspace symlinks
      const realPath = ts.sys.realpath?.(resolved.resolvedFileName);
      if (
        realPath &&
        realPath.startsWith(this.repoRoot) &&
        !realPath.slice(this.repoRoot.length).includes("node_modules")
      ) {
        return realPath;
      }
    }

    // 2. Fallback: manual resolution for relative paths as safety net
    if (specifier.startsWith(".")) {
      const dir = path.dirname(fromFile);
      const basePath = path.resolve(dir, specifier);
      const extensions = [".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"];
      for (const ext of extensions) {
        const candidate = basePath + ext;
        if (fs.existsSync(candidate)) return candidate;
      }
      if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
        return basePath;
      }
    }

    return null;
  }

  /**
   * Resolve a qualifiedName through object-property bindings.
   * E.g. "FKLoader.loadById" → "loadById" if FKLoader is an object literal.
   * Returns the resolved qualifiedName and the function, or null if not found.
   */
  resolveQualifiedName(
    filePath: string,
    qualifiedName: string,
  ): { qualifiedName: string; fn: ParsedFunction } | null {
    const file = this.getFile(filePath);
    if (!file) return null;

    // Direct match
    const directFn = file.functions.find((f) => f.qualifiedName === qualifiedName);
    if (directFn) return { qualifiedName, fn: directFn };

    // Binding fallback
    const binding = file.objectPropertyBindings.get(qualifiedName);
    if (binding) {
      const boundFn = file.functions.find((f) => f.qualifiedName === binding);
      if (boundFn) return { qualifiedName: binding, fn: boundFn };
    }

    return null;
  }

  /**
   * Find the function node for a specific export in a file, following re-exports.
   * Returns [filePath, parsedFunction] or null.
   */
  findExport(
    filePath: string,
    exportedName: string,
    visited?: Set<string>,
  ): { filePath: string; fn: ParsedFunction } | null {
    visited = visited ?? new Set();
    const key = `${filePath}::${exportedName}`;
    if (visited.has(key)) return null;
    visited.add(key);

    const file = this.getFile(filePath);
    if (!file) return null;

    // Check re-exports first
    for (const reExport of file.reExports) {
      if (reExport.exportedName === exportedName) {
        const targetPath = this.resolveModule(reExport.moduleSpecifier, filePath);
        if (targetPath) {
          return this.findExport(targetPath, reExport.importedName, visited);
        }
      }
    }

    // Check local exports
    const localName = file.exportedNames.get(exportedName);
    if (localName) {
      // Find a function with this exact name
      const fn = file.functions.find((f) => f.qualifiedName === localName);
      if (fn) return { filePath, fn };
      // Might be a class — look for static methods later (caller handles Class.method)
    }

    // For 'default' export: also check if any function is the default
    if (exportedName === "default") {
      const defaultLocal = file.exportedNames.get("default");
      if (defaultLocal) {
        const fn = file.functions.find((f) => f.qualifiedName === defaultLocal);
        if (fn) return { filePath, fn };
      }
    }

    return null;
  }

  /**
   * Find a class method in a file.
   * exportedName is the class name, methodName is the method.
   */
  findClassMethod(
    filePath: string,
    exportedName: string,
    methodName: string,
    visited?: Set<string>,
  ): { filePath: string; fn: ParsedFunction } | null {
    visited = visited ?? new Set();
    const key = `${filePath}::${exportedName}.${methodName}`;
    if (visited.has(key)) return null;
    visited.add(key);

    const file = this.getFile(filePath);
    if (!file) return null;

    // Check re-exports
    for (const reExport of file.reExports) {
      if (reExport.exportedName === exportedName) {
        const targetPath = this.resolveModule(reExport.moduleSpecifier, filePath);
        if (targetPath) {
          return this.findClassMethod(targetPath, reExport.importedName, methodName, visited);
        }
      }
    }

    // Find ClassName.methodName in functions
    const localName = file.exportedNames.get(exportedName) ?? exportedName;
    const qualifiedName = `${localName}.${methodName}`;
    const fn = file.functions.find((f) => f.qualifiedName === qualifiedName);
    if (fn) return { filePath, fn };

    // Fallback: check object property bindings
    const binding = file.objectPropertyBindings.get(qualifiedName);
    if (binding && binding !== qualifiedName) {
      const boundFn = file.functions.find((f) => f.qualifiedName === binding);
      if (boundFn) return { filePath, fn: boundFn };
    }

    return null;
  }

  /**
   * Resolve a call site to a FunctionId + EdgeKind, given the context of the calling file.
   */
  resolveCallSite(
    callSite: CallSite,
    callerFile: ParsedFile,
    callerFunction: ParsedFunction,
  ): { targetId: FunctionId; targetNode: FunctionNode; kind: EdgeKind } | null {
    if (callSite.calleeName) {
      return this.resolveSimpleCall(callSite.calleeName, callerFile, callerFunction);
    }
    if (callSite.objectName && callSite.propertyName) {
      return this.resolvePropertyCall(
        callSite.objectName,
        callSite.propertyName,
        callerFile,
        callerFunction,
      );
    }
    return null;
  }

  private resolveSimpleCall(
    calleeName: string,
    callerFile: ParsedFile,
    callerFunction: ParsedFunction,
  ): { targetId: FunctionId; targetNode: FunctionNode; kind: EdgeKind } | null {
    // 1. Check if it's a local function in the same file
    const localFn = callerFile.functions.find((f) => f.qualifiedName === calleeName);
    if (localFn) {
      const id = makeFunctionId(callerFile.filePath, calleeName);
      return {
        targetId: id,
        targetNode: {
          id,
          filePath: callerFile.filePath,
          qualifiedName: calleeName,
          line: localFn.line,
          endLine: localFn.endLine,
          isInstrumented: localFn.isInstrumented,
          description: localFn.description,
          signature: localFn.signature,
        },
        kind: "direct",
      };
    }

    // 2. Check imports
    const imp = callerFile.imports.find((i) => i.localName === calleeName);
    if (imp && !imp.isNamespace) {
      const targetPath = this.resolveModule(imp.moduleSpecifier, callerFile.filePath);
      if (targetPath) {
        const result = this.findExport(targetPath, imp.importedName);
        if (result) {
          const id = makeFunctionId(result.filePath, result.fn.qualifiedName);
          return {
            targetId: id,
            targetNode: {
              id,
              filePath: result.filePath,
              qualifiedName: result.fn.qualifiedName,
              line: result.fn.line,
              endLine: result.fn.endLine,
              isInstrumented: result.fn.isInstrumented,
              description: result.fn.description,
              signature: result.fn.signature,
            },
            kind: "direct",
          };
        }
        if (this.verbose) {
          process.stderr.write(
            `  warning: followed import of ${calleeName} from ${imp.moduleSpecifier} but could not find exported function\n`,
          );
        }
      }
    }

    // 3. Check DI defaults — if a DI default's localRef differs from calleeName,
    // resolve through the ref (avoids infinite recursion when they're the same).
    for (const di of callerFunction.diDefaults) {
      if (di.localRef && di.localRef !== calleeName) {
        const result = this.resolveSimpleCall(di.localRef, callerFile, callerFunction);
        if (result) return { ...result, kind: "di-default" };
      }
    }

    return null;
  }

  private resolvePropertyCall(
    objectName: string,
    propertyName: string,
    callerFile: ParsedFile,
    callerFunction: ParsedFunction,
  ): { targetId: FunctionId; targetNode: FunctionNode; kind: EdgeKind } | null {
    // 1. Check DI defaults: if objectName matches a DI parameter name
    for (const di of callerFunction.diDefaults) {
      if (di.paramName === objectName && di.propName === propertyName) {
        if (di.objectRef && di.methodRef) {
          // The DI default is Class.method — resolve via import
          const result = this.resolvePropertyCallViaImport(di.objectRef, di.methodRef, callerFile);
          if (result) return { ...result, kind: "di-default" };
        }
        if (di.localRef) {
          // The DI default is a simple identifier
          const result = this.resolveSimpleCall(di.localRef, callerFile, callerFunction);
          if (result) return { ...result, kind: "di-default" };
        }
      }
    }

    // 2. Check if objectName is an imported class → static method call
    const imp = callerFile.imports.find((i) => i.localName === objectName);
    if (imp) {
      if (imp.isNamespace) {
        // Namespace import: X.y() → resolve named export y from the module
        const targetPath = this.resolveModule(imp.moduleSpecifier, callerFile.filePath);
        if (targetPath) {
          const result = this.findExport(targetPath, propertyName);
          if (result) {
            const id = makeFunctionId(result.filePath, result.fn.qualifiedName);
            return {
              targetId: id,
              targetNode: {
                id,
                filePath: result.filePath,
                qualifiedName: result.fn.qualifiedName,
                line: result.fn.line,
                endLine: result.fn.endLine,
                isInstrumented: result.fn.isInstrumented,
                description: result.fn.description,
                signature: result.fn.signature,
              },
              kind: "direct",
            };
          }
        }
      } else {
        // Named/default import: likely a class with a static method
        const targetPath = this.resolveModule(imp.moduleSpecifier, callerFile.filePath);
        if (targetPath) {
          const result = this.findClassMethod(targetPath, imp.importedName, propertyName);
          if (result) {
            const id = makeFunctionId(result.filePath, result.fn.qualifiedName);
            return {
              targetId: id,
              targetNode: {
                id,
                filePath: result.filePath,
                qualifiedName: result.fn.qualifiedName,
                line: result.fn.line,
                endLine: result.fn.endLine,
                isInstrumented: result.fn.isInstrumented,
                description: result.fn.description,
                signature: result.fn.signature,
              },
              kind: "static-method",
            };
          }
          // Also check if the module exports a plain function with this name
          // (for cases like default import of a module that's actually a namespace)
          const fnResult = this.findExport(targetPath, propertyName);
          if (fnResult) {
            const id = makeFunctionId(fnResult.filePath, fnResult.fn.qualifiedName);
            return {
              targetId: id,
              targetNode: {
                id,
                filePath: fnResult.filePath,
                qualifiedName: fnResult.fn.qualifiedName,
                line: fnResult.fn.line,
                endLine: fnResult.fn.endLine,
                isInstrumented: fnResult.fn.isInstrumented,
                description: fnResult.fn.description,
                signature: fnResult.fn.signature,
              },
              kind: "direct",
            };
          }
          if (this.verbose) {
            process.stderr.write(
              `  warning: followed import of ${objectName} from ${imp.moduleSpecifier} but could not find ${objectName}.${propertyName}\n`,
            );
          }
        }
      }
    }

    // 3. Check if objectName is a local class
    const qualifiedName = `${objectName}.${propertyName}`;
    const localMethod = callerFile.functions.find((f) => f.qualifiedName === qualifiedName);
    if (localMethod) {
      const id = makeFunctionId(callerFile.filePath, qualifiedName);
      return {
        targetId: id,
        targetNode: {
          id,
          filePath: callerFile.filePath,
          qualifiedName,
          line: localMethod.line,
          endLine: localMethod.endLine,
          isInstrumented: localMethod.isInstrumented,
          description: localMethod.description,
          signature: localMethod.signature,
        },
        kind: "static-method",
      };
    }

    // 4. Fallback: check object property bindings for local objects
    const binding = callerFile.objectPropertyBindings.get(qualifiedName);
    if (binding && binding !== qualifiedName) {
      const boundFn = callerFile.functions.find((f) => f.qualifiedName === binding);
      if (boundFn) {
        const id = makeFunctionId(callerFile.filePath, binding);
        return {
          targetId: id,
          targetNode: {
            id,
            filePath: callerFile.filePath,
            qualifiedName: binding,
            line: boundFn.line,
            endLine: boundFn.endLine,
            isInstrumented: boundFn.isInstrumented,
            description: boundFn.description,
            signature: boundFn.signature,
          },
          kind: "static-method",
        };
      }
    }

    return null;
  }

  private resolvePropertyCallViaImport(
    objectName: string,
    methodName: string,
    callerFile: ParsedFile,
  ): { targetId: FunctionId; targetNode: FunctionNode; kind: EdgeKind } | null {
    const imp = callerFile.imports.find((i) => i.localName === objectName);
    if (!imp) return null;

    const targetPath = this.resolveModule(imp.moduleSpecifier, callerFile.filePath);
    if (!targetPath) return null;

    const result = this.findClassMethod(targetPath, imp.importedName, methodName);
    if (result) {
      const id = makeFunctionId(result.filePath, result.fn.qualifiedName);
      return {
        targetId: id,
        targetNode: {
          id,
          filePath: result.filePath,
          qualifiedName: result.fn.qualifiedName,
          line: result.fn.line,
          endLine: result.fn.endLine,
          isInstrumented: result.fn.isInstrumented,
          description: result.fn.description,
          signature: result.fn.signature,
        },
        kind: "static-method",
      };
    }

    // Also try as a plain export
    const fnResult = this.findExport(targetPath, methodName);
    if (fnResult) {
      const id = makeFunctionId(fnResult.filePath, fnResult.fn.qualifiedName);
      return {
        targetId: id,
        targetNode: {
          id,
          filePath: fnResult.filePath,
          qualifiedName: fnResult.fn.qualifiedName,
          line: fnResult.fn.line,
          endLine: fnResult.fn.endLine,
          isInstrumented: fnResult.fn.isInstrumented,
          description: fnResult.fn.description,
          signature: fnResult.fn.signature,
        },
        kind: "direct",
      };
    }

    return null;
  }
}
