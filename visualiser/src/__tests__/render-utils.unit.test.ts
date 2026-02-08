import { describe, it, expect } from 'vitest';
import {
  COLORS,
  TEAM_COLORS,
  simpleHash,
  teamColor,
  edgeColor,
  edgeDasharray,
  edgeLabel,
  nodeColor,
  buildOrthogonalPath,
  computeBounds,
  fileName,
  nodeLabel,
  filterByFocus,
  filterByHidden,
} from '../render-utils.js';
import { makeLayoutNode, makeGraphNode, makeGraphEdge } from './fixtures.js';
import type { GraphData, LayoutResult } from '../types.js';

describe('edgeColor', () => {
  it('returns correct color for each kind', () => {
    expect(edgeColor('direct')).toBe(COLORS.edgeDirect);
    expect(edgeColor('static-method')).toBe(COLORS.edgeStaticMethod);
    expect(edgeColor('di-default')).toBe(COLORS.edgeDiDefault);
    expect(edgeColor('instrument-wrapper')).toBe(COLORS.edgeInstrumentWrapper);
    expect(edgeColor('re-export')).toBe(COLORS.edgeReExport);
  });

  it('returns default for unknown kind', () => {
    expect(edgeColor('something-else')).toBe(COLORS.edgeDirect);
  });
});

describe('edgeDasharray', () => {
  it('returns correct dasharray for each kind', () => {
    expect(edgeDasharray('di-default')).toBe('6,3');
    expect(edgeDasharray('instrument-wrapper')).toBe('3,3');
    expect(edgeDasharray('re-export')).toBe('3,3');
  });

  it('returns empty string for direct', () => {
    expect(edgeDasharray('direct')).toBe('');
  });

  it('returns empty string for unknown kind', () => {
    expect(edgeDasharray('unknown')).toBe('');
  });
});

describe('edgeLabel', () => {
  it('returns null for all kinds (currently disabled)', () => {
    expect(edgeLabel('direct')).toBeNull();
    expect(edgeLabel('di-default')).toBeNull();
    expect(edgeLabel('re-export')).toBeNull();
  });
});

describe('simpleHash', () => {
  it('returns consistent value for same input', () => {
    expect(simpleHash('hello')).toBe(simpleHash('hello'));
  });

  it('returns different values for different inputs', () => {
    expect(simpleHash('hello')).not.toBe(simpleHash('world'));
  });

  it('returns non-negative number', () => {
    expect(simpleHash('test')).toBeGreaterThanOrEqual(0);
    expect(simpleHash('')).toBeGreaterThanOrEqual(0);
  });
});

describe('teamColor', () => {
  it('returns a string from TEAM_COLORS', () => {
    const color = teamColor('my-team');
    expect(TEAM_COLORS).toContain(color);
  });

  it('returns consistent color for same team name', () => {
    expect(teamColor('alpha')).toBe(teamColor('alpha'));
  });

  it('may return different colors for different teams', () => {
    // Not guaranteed, but statistically likely with different names
    const colors = new Set(
      ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map(teamColor)
    );
    expect(colors.size).toBeGreaterThan(1);
  });
});

describe('nodeColor', () => {
  it('returns green for source node', () => {
    const node = makeLayoutNode({
      id: 'a',
      original: makeGraphNode({ id: 'a', isSource: true }),
    });
    expect(nodeColor(node)).toEqual({
      fill: COLORS.source,
      stroke: COLORS.source,
      textFill: '#ffffff',
    });
  });

  it('returns red for target node', () => {
    const node = makeLayoutNode({
      id: 'a',
      original: makeGraphNode({ id: 'a', isTarget: true }),
    });
    expect(nodeColor(node)).toEqual({
      fill: COLORS.target,
      stroke: COLORS.target,
      textFill: '#ffffff',
    });
  });

  it('returns yellow for instrumented node', () => {
    const node = makeLayoutNode({
      id: 'a',
      original: makeGraphNode({ id: 'a', isInstrumented: true }),
    });
    expect(nodeColor(node)).toEqual({
      fill: COLORS.instrumented,
      stroke: COLORS.instrumented,
      textFill: '#ffffff',
    });
  });

  it('returns gray for regular node', () => {
    const node = makeLayoutNode({ id: 'a' });
    expect(nodeColor(node)).toEqual({
      fill: COLORS.regularFill,
      stroke: COLORS.regularBorder,
      textFill: COLORS.text,
    });
  });

  it('returns gray when original is null', () => {
    const node = makeLayoutNode({ id: 'a', original: null });
    expect(nodeColor(node)).toEqual({
      fill: COLORS.regularFill,
      stroke: COLORS.regularBorder,
      textFill: COLORS.text,
    });
  });

  it('prioritizes source over target and instrumented', () => {
    const node = makeLayoutNode({
      id: 'a',
      original: makeGraphNode({
        id: 'a',
        isSource: true,
        isTarget: true,
        isInstrumented: true,
      }),
    });
    expect(nodeColor(node).fill).toBe(COLORS.source);
  });

  it('prioritizes target over instrumented', () => {
    const node = makeLayoutNode({
      id: 'a',
      original: makeGraphNode({
        id: 'a',
        isTarget: true,
        isInstrumented: true,
      }),
    });
    expect(nodeColor(node).fill).toBe(COLORS.target);
  });
});

describe('buildOrthogonalPath', () => {
  it('returns empty string for fewer than 2 waypoints', () => {
    expect(buildOrthogonalPath([])).toBe('');
    expect(buildOrthogonalPath([{ x: 0, y: 0 }])).toBe('');
  });

  it('returns M...L for 2 straight points', () => {
    const path = buildOrthogonalPath([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    expect(path).toBe('M 0 0 L 100 0');
  });

  it('includes Q (quadratic curve) for 3-point L-shape', () => {
    const path = buildOrthogonalPath([
      { x: 0, y: 0 },
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ]);
    expect(path).toContain('M 0 0');
    expect(path).toContain('Q');
    expect(path).toContain('L 100 50');
  });

  it('clamps corner radius for short segments', () => {
    // Very short segments — radius should be clamped
    const path = buildOrthogonalPath([
      { x: 0, y: 0 },
      { x: 0, y: 3 }, // only 3px segment
      { x: 10, y: 3 },
    ]);
    expect(path).toContain('Q');
    // Should not error out even with tiny segments
    expect(path.length).toBeGreaterThan(0);
  });
});

describe('computeBounds', () => {
  it('computes tight bounds around nodes + 40px padding', () => {
    const layout: LayoutResult = {
      nodes: [
        makeLayoutNode({ id: 'a', x: 10, y: 20, width: 100, height: 28 }),
        makeLayoutNode({ id: 'b', x: 200, y: 100, width: 80, height: 28 }),
      ],
      edges: [],
      clusters: [],
      clusterOrder: [],
    };
    const bounds = computeBounds(layout);
    expect(bounds.x).toBe(10 - 40);
    expect(bounds.y).toBe(20 - 40);
    expect(bounds.w).toBe(280 - 10 + 80);
    expect(bounds.h).toBe(128 - 20 + 80);
  });

  it('includes clusters in bounds', () => {
    const layout: LayoutResult = {
      nodes: [makeLayoutNode({ id: 'a', x: 50, y: 50, width: 50, height: 28 })],
      edges: [],
      clusters: [
        { filePath: 'f.ts', x: 0, y: 0, width: 200, height: 200 },
      ],
      clusterOrder: [],
    };
    const bounds = computeBounds(layout);
    expect(bounds.x).toBe(0 - 40);
    expect(bounds.y).toBe(0 - 40);
  });

  it('includes edge waypoints in bounds', () => {
    const layout: LayoutResult = {
      nodes: [makeLayoutNode({ id: 'a', x: 50, y: 50, width: 50, height: 28 })],
      edges: [
        {
          from: 'a',
          to: 'b',
          kind: 'direct',
          isBackedge: false,
          waypoints: [
            { x: -100, y: -100 },
            { x: 500, y: 500 },
          ],
        },
      ],
      clusters: [],
      clusterOrder: [],
    };
    const bounds = computeBounds(layout);
    expect(bounds.x).toBe(-100 - 40);
    expect(bounds.y).toBe(-100 - 40);
  });

  it('handles empty layout with defaults', () => {
    const layout: LayoutResult = { nodes: [], edges: [], clusters: [], clusterOrder: [] };
    const bounds = computeBounds(layout);
    expect(bounds.x).toBe(-40);
    expect(bounds.y).toBe(-40);
    expect(bounds.w).toBe(880);
    expect(bounds.h).toBe(680);
  });
});

describe('fileName', () => {
  it('extracts filename from path with slashes', () => {
    expect(fileName('src/utils/helper.ts')).toBe('helper.ts');
  });

  it('returns input if no slashes', () => {
    expect(fileName('file.ts')).toBe('file.ts');
  });

  it('handles trailing slash edge case', () => {
    expect(fileName('src/')).toBe('');
  });
});

describe('nodeLabel', () => {
  it('returns qualifiedName:line for normal node', () => {
    const node = makeLayoutNode({
      id: 'a',
      original: makeGraphNode({
        id: 'a',
        qualifiedName: 'MyClass.method',
        line: 42,
      }),
    });
    expect(nodeLabel(node)).toBe('MyClass.method:42');
  });

  it('returns fileName (count) for collapsed group', () => {
    const node = makeLayoutNode({
      id: '__collapsed:src/foo.ts',
      isCollapsedGroup: true,
      nodeCount: 5,
      original: makeGraphNode({
        id: '__collapsed:src/foo.ts',
        filePath: 'src/foo.ts',
      }),
    });
    expect(nodeLabel(node)).toBe('foo.ts (5)');
  });

  it('returns id for node with no original', () => {
    const node = makeLayoutNode({ id: 'dummy-node', original: null });
    expect(nodeLabel(node)).toBe('dummy-node');
  });
});

describe('filterByFocus', () => {
  const data: GraphData = {
    nodes: [
      makeGraphNode({ id: 'a' }),
      makeGraphNode({ id: 'b' }),
      makeGraphNode({ id: 'c' }),
    ],
    edges: [makeGraphEdge('a', 'b'), makeGraphEdge('b', 'c')],
  };

  it('keeps only nodes in focus set', () => {
    const result = filterByFocus(data, new Set(['a', 'b']));
    expect(result.nodes.map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('removes dangling edges', () => {
    const result = filterByFocus(data, new Set(['a', 'b']));
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].from).toBe('a');
    expect(result.edges[0].to).toBe('b');
  });

  it('preserves codeowners', () => {
    const dataWithOwners = { ...data, codeowners: { 'f.ts': ['team-a'] } };
    const result = filterByFocus(dataWithOwners, new Set(['a']));
    expect(result.codeowners).toEqual({ 'f.ts': ['team-a'] });
  });
});

describe('filterByHidden', () => {
  const data: GraphData = {
    nodes: [
      makeGraphNode({ id: 'a' }),
      makeGraphNode({ id: 'b' }),
      makeGraphNode({ id: 'c' }),
    ],
    edges: [makeGraphEdge('a', 'b'), makeGraphEdge('b', 'c')],
  };

  it('removes hidden nodes and their edges', () => {
    const result = filterByHidden(data, new Set(['b']));
    expect(result.nodes.map((n) => n.id)).toEqual(['a', 'c']);
    expect(result.edges).toHaveLength(0);
  });

  it('returns same data when hidden set is empty', () => {
    const result = filterByHidden(data, new Set());
    expect(result).toBe(data); // exact same reference
  });
});
