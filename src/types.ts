/**
 * FunctionId uniquely identifies a function in the codebase.
 * Format: "absolute/path/to/file.ts::qualifiedName"
 * qualifiedName is "funcName" or "ClassName.methodName"
 */
export type FunctionId = string;

export function makeFunctionId(filePath: string, qualifiedName: string): FunctionId {
  return `${filePath}::${qualifiedName}`;
}

export function parseFunctionId(id: FunctionId): {
  filePath: string;
  qualifiedName: string;
} {
  const sep = id.indexOf("::");
  if (sep === -1) throw new Error(`Invalid FunctionId: ${id}`);
  return { filePath: id.slice(0, sep), qualifiedName: id.slice(sep + 2) };
}

export interface FunctionNode {
  id: FunctionId;
  filePath: string;
  qualifiedName: string;
  line: number;
  endLine?: number;
  isInstrumented: boolean;
  isExternal?: boolean;
  description?: string;
  signature?: string;
}

export type EdgeKind =
  | "direct"
  | "static-method"
  | "di-default"
  | "instrument-wrapper"
  | "instance-method"
  | "re-export"
  | "external";

export interface CallEdge {
  callerId: FunctionId;
  calleeId: FunctionId;
  kind: EdgeKind;
  callLine: number;
}

export interface CallGraph {
  nodes: Map<FunctionId, FunctionNode>;
  forwardEdges: Map<FunctionId, CallEdge[]>;
  reverseEdges: Map<FunctionId, CallEdge[]>;
  edges: CallEdge[];
}

export function createEmptyGraph(): CallGraph {
  return {
    nodes: new Map(),
    forwardEdges: new Map(),
    reverseEdges: new Map(),
    edges: [],
  };
}

export function addNode(graph: CallGraph, node: FunctionNode): void {
  if (!graph.nodes.has(node.id)) {
    graph.nodes.set(node.id, node);
  }
}

export function addEdge(graph: CallGraph, edge: CallEdge): void {
  graph.edges.push(edge);
  let fwd = graph.forwardEdges.get(edge.callerId);
  if (!fwd) {
    fwd = [];
    graph.forwardEdges.set(edge.callerId, fwd);
  }
  fwd.push(edge);

  let rev = graph.reverseEdges.get(edge.calleeId);
  if (!rev) {
    rev = [];
    graph.reverseEdges.set(edge.calleeId, rev);
  }
  rev.push(edge);
}

/** Compact display of a function ID: just filename::qualifiedName */
export function shortId(id: FunctionId): string {
  const { filePath, qualifiedName } = parseFunctionId(id);
  const parts = filePath.split("/");
  return `${parts[parts.length - 1]}::${qualifiedName}`;
}

/** Import info extracted from a source file */
export interface ImportInfo {
  localName: string;
  importedName: string; // 'default' for default imports, '*' for namespace
  moduleSpecifier: string;
  isNamespace: boolean;
}

/** Re-export info */
export interface ReExportInfo {
  exportedName: string;
  importedName: string;
  moduleSpecifier: string;
}

/** A call site found within a function body */
export interface CallSite {
  /** Simple call: just the function name. Property access: undefined */
  calleeName?: string;
  /** Property access call: the object part (e.g. X in X.y()) */
  objectName?: string;
  /** Property access call: the property part (e.g. y in X.y()) */
  propertyName?: string;
  /** Line number of the call */
  line: number;
}

/** Constructor field assignment: this.fieldName = source */
export interface FieldAssignment {
  fieldName: string;
  /** If assigned from param.prop (e.g. deps.streamText) */
  paramName?: string;
  propName?: string;
  /** If assigned from a simple identifier (e.g. streamText) */
  localRef?: string;
}

/** DI default parameter mapping: paramName.propName → resolved target */
export interface DiDefaultMapping {
  paramName: string;
  propName: string;
  /** If the default is an identifier, this is the local name */
  localRef?: string;
  /** If the default is a property access (Obj.method), these are set */
  objectRef?: string;
  methodRef?: string;
}

/** Parsed representation of a single function/method */
export interface ParsedFunction {
  qualifiedName: string;
  line: number;
  endLine?: number;
  isInstrumented: boolean;
  callSites: CallSite[];
  diDefaults: DiDefaultMapping[];
  fieldAssignments?: FieldAssignment[];
  description?: string;
  signature?: string;
}

/** Full parsed representation of a source file */
export interface ParsedFile {
  filePath: string;
  functions: ParsedFunction[];
  imports: ImportInfo[];
  reExports: ReExportInfo[];
  /** Map from exported name to local name (for resolving what a file exports) */
  exportedNames: Map<string, string>;
  /** Map from "ObjName.propName" to local function qualifiedName (for object-literal exports) */
  objectPropertyBindings: Map<string, string>;
  /** Map from variable name to constructor class name (e.g. "myInstance" → "MyClass") */
  instanceBindings: Map<string, string>;
}
