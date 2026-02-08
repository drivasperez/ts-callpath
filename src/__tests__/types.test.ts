import { describe, it, expect } from 'vitest';
import {
  makeFunctionId,
  parseFunctionId,
  shortId,
  createEmptyGraph,
  addNode,
  addEdge,
} from '../types.js';
import type { FunctionNode, CallEdge } from '../types.js';

describe('makeFunctionId / parseFunctionId', () => {
  it('round-trips a simple function id', () => {
    const id = makeFunctionId('/src/foo.ts', 'myFunc');
    const parsed = parseFunctionId(id);
    expect(parsed.filePath).toBe('/src/foo.ts');
    expect(parsed.qualifiedName).toBe('myFunc');
  });

  it('round-trips a class method id', () => {
    const id = makeFunctionId('/src/bar.ts', 'MyClass.doStuff');
    const parsed = parseFunctionId(id);
    expect(parsed.filePath).toBe('/src/bar.ts');
    expect(parsed.qualifiedName).toBe('MyClass.doStuff');
  });

  it('handles paths with colons (Windows-style)', () => {
    const id = makeFunctionId('C:/Users/dev/foo.ts', 'fn');
    const parsed = parseFunctionId(id);
    expect(parsed.filePath).toBe('C:/Users/dev/foo.ts');
    expect(parsed.qualifiedName).toBe('fn');
  });
});

describe('parseFunctionId error handling', () => {
  it('throws on input missing `::`', () => {
    expect(() => parseFunctionId('no-separator-here')).toThrow(
      'Invalid FunctionId'
    );
  });

  it('throws on empty string', () => {
    expect(() => parseFunctionId('')).toThrow('Invalid FunctionId');
  });
});

describe('shortId', () => {
  it('extracts filename and qualifiedName', () => {
    const id = makeFunctionId('/long/path/to/file.ts', 'hello');
    expect(shortId(id)).toBe('file.ts::hello');
  });

  it('works with class method ids', () => {
    const id = makeFunctionId('/a/b/c.ts', 'Foo.bar');
    expect(shortId(id)).toBe('c.ts::Foo.bar');
  });
});

describe('addNode', () => {
  it('adds a node to an empty graph', () => {
    const graph = createEmptyGraph();
    const node: FunctionNode = {
      id: 'f.ts::fn',
      filePath: 'f.ts',
      qualifiedName: 'fn',
      line: 1,
      isInstrumented: false,
    };
    addNode(graph, node);
    expect(graph.nodes.size).toBe(1);
    expect(graph.nodes.get('f.ts::fn')).toBe(node);
  });

  it('deduplicates: adding same id twice keeps first', () => {
    const graph = createEmptyGraph();
    const node1: FunctionNode = {
      id: 'f.ts::fn',
      filePath: 'f.ts',
      qualifiedName: 'fn',
      line: 1,
      isInstrumented: false,
    };
    const node2: FunctionNode = {
      id: 'f.ts::fn',
      filePath: 'f.ts',
      qualifiedName: 'fn',
      line: 99,
      isInstrumented: true,
    };
    addNode(graph, node1);
    addNode(graph, node2);
    expect(graph.nodes.size).toBe(1);
    expect(graph.nodes.get('f.ts::fn')!.line).toBe(1);
  });
});

describe('addEdge', () => {
  it('populates edges, forwardEdges, and reverseEdges', () => {
    const graph = createEmptyGraph();
    const edge: CallEdge = {
      callerId: 'a.ts::fn1',
      calleeId: 'b.ts::fn2',
      kind: 'direct',
      callLine: 10,
    };
    addEdge(graph, edge);

    expect(graph.edges).toHaveLength(1);
    expect(graph.forwardEdges.get('a.ts::fn1')).toEqual([edge]);
    expect(graph.reverseEdges.get('b.ts::fn2')).toEqual([edge]);
  });

  it('appends multiple edges from the same caller', () => {
    const graph = createEmptyGraph();
    const edge1: CallEdge = {
      callerId: 'a.ts::fn1',
      calleeId: 'b.ts::fn2',
      kind: 'direct',
      callLine: 10,
    };
    const edge2: CallEdge = {
      callerId: 'a.ts::fn1',
      calleeId: 'c.ts::fn3',
      kind: 'static-method',
      callLine: 20,
    };
    addEdge(graph, edge1);
    addEdge(graph, edge2);

    expect(graph.edges).toHaveLength(2);
    expect(graph.forwardEdges.get('a.ts::fn1')).toHaveLength(2);
    expect(graph.reverseEdges.get('b.ts::fn2')).toHaveLength(1);
    expect(graph.reverseEdges.get('c.ts::fn3')).toHaveLength(1);
  });
});
