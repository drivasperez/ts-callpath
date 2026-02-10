import ts from "typescript";
import * as fs from "fs";
import type {
  ParsedFile,
  ParsedFunction,
  CallSite,
  ImportInfo,
  ReExportInfo,
  DiDefaultMapping,
} from "./types.js";
import { unwrapVariableInitializer, isInstrumentOwnMethodsInPlace } from "./wrapperUnwrap.js";

/**
 * Extract the description text from a JSDoc comment attached to a node.
 * Returns only the description, not @param/@returns tags.
 */
function getJSDocDescription(node: ts.Node): string | undefined {
  const jsDocs = (node as any).jsDoc as ts.JSDoc[] | undefined;
  if (!jsDocs || jsDocs.length === 0) return undefined;
  const jsDoc = jsDocs[0];
  if (!jsDoc.comment) return undefined;
  if (typeof jsDoc.comment === "string") return jsDoc.comment;
  // TS 4.3+ structured comments
  const parts: string[] = [];
  for (const part of jsDoc.comment) {
    if ("text" in part) parts.push((part as any).text);
  }
  return parts.join("") || undefined;
}

/**
 * Extract the function signature (parameters + return type) from a declaration.
 */
function getFunctionSignature(
  node: ts.SignatureDeclaration,
  sourceFile: ts.SourceFile,
): string | undefined {
  if (!node.parameters) return undefined;
  const paramsStart = node.parameters.pos;
  const paramsEnd = node.parameters.end;
  let sig = "(" + sourceFile.text.substring(paramsStart, paramsEnd).trim() + ")";
  if (node.type) {
    sig += ": " + node.type.getText(sourceFile);
  }
  return sig;
}

/**
 * Parse a TypeScript file using ts.createSourceFile (parser-only, no type checker).
 * Extracts functions, call sites, imports, re-exports, DI defaults, and export mappings.
 */
export function parseFile(filePath: string): ParsedFile {
  const sourceText = fs.readFileSync(filePath, "utf-8");
  return parseSource(filePath, sourceText);
}

/**
 * Parse TypeScript source text directly (no file I/O).
 * Useful for testing with inline strings.
 */
export function parseSource(filePath: string, sourceText: string): ParsedFile {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );

  const functions: ParsedFunction[] = [];
  const imports: ImportInfo[] = [];
  const reExports: ReExportInfo[] = [];
  const exportedNames = new Map<string, string>();
  const objectPropertyBindings = new Map<string, string>();

  // Track which classes have instrumentOwnMethodsInPlace
  const instrumentedClasses = new Set<string>();

  // First pass: find instrumentOwnMethodsInPlace calls
  for (const stmt of sourceFile.statements) {
    const className = isInstrumentOwnMethodsInPlace(stmt);
    if (className) instrumentedClasses.add(className);
  }

  // Main pass
  for (const stmt of sourceFile.statements) {
    // Import declarations
    if (ts.isImportDeclaration(stmt) && stmt.moduleSpecifier) {
      const specifier = (stmt.moduleSpecifier as ts.StringLiteral).text;
      if (stmt.importClause) {
        const clause = stmt.importClause;
        // Default import
        if (clause.name) {
          imports.push({
            localName: clause.name.text,
            importedName: "default",
            moduleSpecifier: specifier,
            isNamespace: false,
          });
        }
        // Named/namespace bindings
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            imports.push({
              localName: clause.namedBindings.name.text,
              importedName: "*",
              moduleSpecifier: specifier,
              isNamespace: true,
            });
          } else if (ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) {
              imports.push({
                localName: element.name.text,
                importedName: element.propertyName ? element.propertyName.text : element.name.text,
                moduleSpecifier: specifier,
                isNamespace: false,
              });
            }
          }
        }
      }
    }

    // Export declarations (re-exports)
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.moduleSpecifier) {
        const specifier = (stmt.moduleSpecifier as ts.StringLiteral).text;
        if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
          for (const element of stmt.exportClause.elements) {
            const exportedName = element.name.text;
            const importedName = element.propertyName
              ? element.propertyName.text
              : element.name.text;
            reExports.push({
              exportedName,
              importedName,
              moduleSpecifier: specifier,
            });
            exportedNames.set(exportedName, exportedName);
          }
        } else if (!stmt.exportClause) {
          // export * from '...' — we can't resolve individual names without parsing target
          // Skip for now
        }
      } else if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        // export { x, y } — local re-exports
        for (const element of stmt.exportClause.elements) {
          const exportedName = element.name.text;
          const localName = element.propertyName ? element.propertyName.text : element.name.text;
          exportedNames.set(exportedName, localName);
        }
      }
    }

    // Function declarations
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const name = stmt.name.text;
      const isExported = hasExportModifier(stmt);
      if (isExported) exportedNames.set(name, name);
      if (isExported && hasDefaultModifier(stmt)) exportedNames.set("default", name);
      const fn = extractFunction(name, stmt, sourceFile);
      functions.push(fn);
    }

    // Variable declarations (arrow functions, instrumentFn wrappers)
    if (ts.isVariableStatement(stmt)) {
      const isExported = hasExportModifier(stmt);
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const name = decl.name.text;
        if (isExported) exportedNames.set(name, name);

        const unwrapped = unwrapVariableInitializer(decl.initializer);
        if (unwrapped) {
          const fn = extractFunctionFromExpression(
            name,
            unwrapped.innerFunction,
            unwrapped.isInstrumented,
            sourceFile,
            getJSDocDescription(stmt),
          );
          functions.push(fn);
        }

        const objectLiteral = unwrapToObjectLiteral(decl.initializer);
        if (objectLiteral) {
          processObjectLiteralProperties(
            name,
            objectLiteral,
            functions,
            objectPropertyBindings,
            sourceFile,
          );
        }
      }
    }

    // Class declarations
    if (ts.isClassDeclaration(stmt) && stmt.name) {
      const className = stmt.name.text;
      const isExported = hasExportModifier(stmt);
      if (isExported) exportedNames.set(className, className);
      if (isExported && hasDefaultModifier(stmt)) exportedNames.set("default", className);
      const isInstrumented = instrumentedClasses.has(className);

      for (const member of stmt.members) {
        if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          const methodName = member.name.text;
          const qualifiedName = `${className}.${methodName}`;
          const fn = extractFunction(qualifiedName, member, sourceFile, isInstrumented);
          functions.push(fn);
        }

        // Constructor
        if (ts.isConstructorDeclaration(member)) {
          const qualifiedName = `${className}.constructor`;
          const fn = extractFunction(qualifiedName, member, sourceFile, isInstrumented);
          functions.push(fn);
        }

        // Getters and setters
        if (
          (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) &&
          member.name &&
          ts.isIdentifier(member.name)
        ) {
          const prefix = ts.isGetAccessorDeclaration(member) ? "get " : "set ";
          const qualifiedName = `${className}.${prefix}${member.name.text}`;
          const fn = extractFunction(qualifiedName, member, sourceFile, isInstrumented);
          functions.push(fn);
        }

        // Also handle property declarations with arrow function initializers
        if (
          ts.isPropertyDeclaration(member) &&
          member.name &&
          ts.isIdentifier(member.name) &&
          member.initializer
        ) {
          const unwrapped = unwrapVariableInitializer(member.initializer);
          if (unwrapped) {
            const qualifiedName = `${className}.${member.name.text}`;
            const fn = extractFunctionFromExpression(
              qualifiedName,
              unwrapped.innerFunction,
              unwrapped.isInstrumented || isInstrumented,
              sourceFile,
              getJSDocDescription(member),
            );
            functions.push(fn);
          }
        }
      }
    }

    // Export assignment: export default function/class
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      if (ts.isIdentifier(stmt.expression)) {
        exportedNames.set("default", stmt.expression.text);
      }
    }
  }

  // Collect module-level call sites for a <module> pseudo-function.
  // This captures calls in top-level expression statements and callbacks
  // (e.g., program.action(() => { forwardBfs(...) })).
  // We only process ExpressionStatements to avoid duplicating call sites
  // already captured inside named functions from variable/function/class decls.
  const moduleLevelCallSites: CallSite[] = [];
  for (const stmt of sourceFile.statements) {
    if (ts.isExpressionStatement(stmt)) {
      extractCallSites(stmt, moduleLevelCallSites, sourceFile);
    }
  }

  if (moduleLevelCallSites.length > 0) {
    const lastLine = sourceFile.getLineAndCharacterOfPosition(sourceFile.getEnd()).line + 1;
    functions.push({
      qualifiedName: "<module>",
      line: 1,
      endLine: lastLine,
      isInstrumented: false,
      callSites: moduleLevelCallSites,
      diDefaults: [],
      description: undefined,
      signature: undefined,
    });
  }

  return {
    filePath,
    functions,
    imports,
    reExports,
    exportedNames,
    objectPropertyBindings,
  };
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function hasDefaultModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
}

/**
 * Unwrap an expression to an ObjectLiteralExpression, if it is one.
 * Handles: plain object literal, Object.freeze(obj), `as const`, `satisfies T`.
 */
function unwrapToObjectLiteral(expr: ts.Expression): ts.ObjectLiteralExpression | null {
  // Unwrap type assertions: `expr as T`, `expr satisfies T`
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) {
    return unwrapToObjectLiteral(expr.expression);
  }

  // Direct object literal
  if (ts.isObjectLiteralExpression(expr)) {
    return expr;
  }

  // Object.freeze(objLiteral)
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "Object" &&
    expr.expression.name.text === "freeze" &&
    expr.arguments.length === 1
  ) {
    return unwrapToObjectLiteral(expr.arguments[0]);
  }

  return null;
}

/**
 * Process properties of an object literal variable declaration.
 * Records bindings and parses inline function definitions.
 */
function processObjectLiteralProperties(
  varName: string,
  objLiteral: ts.ObjectLiteralExpression,
  functions: ParsedFunction[],
  bindings: Map<string, string>,
  sourceFile: ts.SourceFile,
): void {
  for (const prop of objLiteral.properties) {
    // Skip spread assignments and computed properties
    if (ts.isSpreadAssignment(prop)) continue;
    if (!prop.name || ts.isComputedPropertyName(prop.name)) continue;
    const propName = ts.isIdentifier(prop.name)
      ? prop.name.text
      : ts.isStringLiteral(prop.name)
        ? prop.name.text
        : null;
    if (!propName) continue;

    const qualifiedName = `${varName}.${propName}`;

    // Shorthand property: { fn }
    if (ts.isShorthandPropertyAssignment(prop)) {
      bindings.set(qualifiedName, propName);
      continue;
    }

    if (ts.isPropertyAssignment(prop)) {
      const init = prop.initializer;

      // Identifier value: { fn: impl }
      if (ts.isIdentifier(init)) {
        bindings.set(qualifiedName, init.text);
        continue;
      }

      // Arrow function or function expression value: { fn: () => {} }
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        const fn = extractFunctionFromExpression(
          qualifiedName,
          init,
          false,
          sourceFile,
          getJSDocDescription(prop),
        );
        functions.push(fn);
        bindings.set(qualifiedName, qualifiedName);
        continue;
      }
    }

    // Method definition: { fn() {} } or { async fn() {} }
    if (ts.isMethodDeclaration(prop)) {
      const fn = extractFunction(qualifiedName, prop, sourceFile);
      functions.push(fn);
      bindings.set(qualifiedName, qualifiedName);
      continue;
    }
  }
}

function extractFunction(
  qualifiedName: string,
  node:
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.ConstructorDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration,
  sourceFile: ts.SourceFile,
  isInstrumented: boolean = false,
): ParsedFunction {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  const callSites: CallSite[] = [];
  const diDefaults: DiDefaultMapping[] = [];
  const description = getJSDocDescription(node);
  const signature = ts.isConstructorDeclaration(node)
    ? undefined
    : getFunctionSignature(node as ts.SignatureDeclaration, sourceFile);

  // Extract DI defaults from parameters
  if (node.parameters) {
    extractDiDefaults(node.parameters, diDefaults);
  }

  // Extract call sites from body
  // Derive enclosing class name from qualifiedName (e.g. "MyClass.method" → "MyClass")
  const dotIdx = qualifiedName.indexOf(".");
  const className = dotIdx !== -1 ? qualifiedName.slice(0, dotIdx) : undefined;
  if (node.body) {
    extractCallSites(node.body, callSites, sourceFile, className);
  }

  return {
    qualifiedName,
    line,
    endLine,
    isInstrumented,
    callSites,
    diDefaults,
    description,
    signature,
  };
}

function extractFunctionFromExpression(
  qualifiedName: string,
  node: ts.FunctionExpression | ts.ArrowFunction,
  isInstrumented: boolean,
  sourceFile: ts.SourceFile,
  description?: string,
): ParsedFunction {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  const callSites: CallSite[] = [];
  const diDefaults: DiDefaultMapping[] = [];
  const signature = getFunctionSignature(node, sourceFile);

  if (node.parameters) {
    extractDiDefaults(node.parameters, diDefaults);
  }

  const dotIdx = qualifiedName.indexOf(".");
  const className = dotIdx !== -1 ? qualifiedName.slice(0, dotIdx) : undefined;
  if (node.body) {
    if (ts.isBlock(node.body)) {
      extractCallSites(node.body, callSites, sourceFile, className);
    } else {
      // Arrow function with expression body
      extractCallSitesFromExpression(node.body, callSites, sourceFile, className);
    }
  }

  return {
    qualifiedName,
    line,
    endLine,
    isInstrumented,
    callSites,
    diDefaults,
    description,
    signature,
  };
}

/**
 * Extract DI default parameter mappings from function parameters.
 * Pattern: function foo(deps = { bar: RealBar.method, baz: realBaz })
 */
function extractDiDefaults(
  params: ts.NodeArray<ts.ParameterDeclaration>,
  out: DiDefaultMapping[],
): void {
  for (const param of params) {
    if (!param.initializer || !ts.isObjectLiteralExpression(param.initializer)) continue;
    if (!ts.isIdentifier(param.name) && !ts.isObjectBindingPattern(param.name)) continue;

    const paramName = ts.isIdentifier(param.name) ? param.name.text : "<destructured>";

    for (const prop of param.initializer.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      if (!ts.isIdentifier(prop.name)) continue;
      const propName = prop.name.text;

      if (ts.isIdentifier(prop.initializer)) {
        out.push({ paramName, propName, localRef: prop.initializer.text });
      } else if (
        ts.isPropertyAccessExpression(prop.initializer) &&
        ts.isIdentifier(prop.initializer.expression)
      ) {
        out.push({
          paramName,
          propName,
          objectRef: prop.initializer.expression.text,
          methodRef: prop.initializer.name.text,
        });
      }
    }
  }
}

/**
 * Recursively extract call sites from a block/statement.
 */
function extractCallSites(
  node: ts.Node,
  out: CallSite[],
  sourceFile: ts.SourceFile,
  className?: string,
): void {
  // Don't descend into nested function/class declarations — they are separate scopes
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  ) {
    // But DO descend into arrow functions that are arguments to known higher-order functions
    // (like mapAsync, Promise.all, .map, .filter, .forEach, etc.)
    // This is handled at the CallExpression level below
    return;
  }

  if (ts.isCallExpression(node)) {
    extractCallSiteFromCallExpression(node, out, sourceFile, className);

    // Walk into arguments — specifically look for arrow/function expressions
    // that are passed as callbacks
    for (const arg of node.arguments) {
      if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
        if (arg.body) {
          if (ts.isBlock(arg.body)) {
            extractCallSites(arg.body, out, sourceFile, className);
          } else {
            extractCallSitesFromExpression(arg.body, out, sourceFile, className);
          }
        }
      } else {
        extractCallSites(arg, out, sourceFile, className);
      }
    }

    // Walk into expression side (for chained calls like foo().bar())
    extractCallSites(node.expression, out, sourceFile, className);
    return;
  }

  // new ClassName(...) → treat as a call to ClassName.constructor
  if (ts.isNewExpression(node)) {
    const expr = node.expression;
    if (ts.isIdentifier(expr)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      out.push({ objectName: expr.text, propertyName: "constructor", line });
    }

    // Walk into arguments (same as CallExpression handling)
    if (node.arguments) {
      for (const arg of node.arguments) {
        if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
          if (arg.body) {
            if (ts.isBlock(arg.body)) {
              extractCallSites(arg.body, out, sourceFile, className);
            } else {
              extractCallSitesFromExpression(arg.body, out, sourceFile, className);
            }
          }
        } else {
          extractCallSites(arg, out, sourceFile, className);
        }
      }
    }
    return;
  }

  ts.forEachChild(node, (child) => extractCallSites(child, out, sourceFile, className));
}

function extractCallSitesFromExpression(
  node: ts.Expression,
  out: CallSite[],
  sourceFile: ts.SourceFile,
  className?: string,
): void {
  extractCallSites(node, out, sourceFile, className);
}

function extractCallSiteFromCallExpression(
  node: ts.CallExpression,
  out: CallSite[],
  sourceFile: ts.SourceFile,
  className?: string,
): void {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const expr = node.expression;

  // Simple identifier call: foo(...)
  if (ts.isIdentifier(expr)) {
    out.push({ calleeName: expr.text, line });
    return;
  }

  // Property access: X.y(...) or this.y(...)
  if (ts.isPropertyAccessExpression(expr)) {
    const propName = expr.name.text;
    const obj = expr.expression;

    if (ts.isIdentifier(obj)) {
      out.push({ objectName: obj.text, propertyName: propName, line });
    } else if (obj.kind === ts.SyntaxKind.ThisKeyword && className) {
      out.push({ objectName: className, propertyName: propName, line });
    }
    // For chained calls like a.b.c(), we just capture the immediate property access
    // The deeper parts are handled by recursive traversal
    return;
  }
}
