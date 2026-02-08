import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import {
  unwrapInstrumentFn,
  unwrapVariableInitializer,
  isInstrumentOwnMethodsInPlace,
} from '../wrapperUnwrap.js';

/** Helper: parse a single expression and return the AST node */
function parseExpression(code: string): ts.Expression {
  const sourceFile = ts.createSourceFile(
    'test.ts',
    code,
    ts.ScriptTarget.Latest,
    true
  );
  const stmt = sourceFile.statements[0];
  if (ts.isExpressionStatement(stmt)) return stmt.expression;
  if (ts.isVariableStatement(stmt)) {
    return stmt.declarationList.declarations[0].initializer!;
  }
  throw new Error('Unexpected statement type');
}

/** Helper: parse a statement */
function parseStatement(code: string): ts.Statement {
  const sourceFile = ts.createSourceFile(
    'test.ts',
    code,
    ts.ScriptTarget.Latest,
    true
  );
  return sourceFile.statements[0];
}

describe('unwrapInstrumentFn', () => {
  it('detects instrumentFn(async function() {}) and returns inner function', () => {
    const expr = parseExpression(
      'instrumentFn(async function doWork() { })'
    );
    expect(ts.isCallExpression(expr)).toBe(true);
    const result = unwrapInstrumentFn(expr as ts.CallExpression);
    expect(result).not.toBeNull();
    expect(ts.isFunctionExpression(result!)).toBe(true);
  });

  it('detects instrumentFn with string name arg', () => {
    const expr = parseExpression(
      'instrumentFn("doWork", async function() { })'
    );
    const result = unwrapInstrumentFn(expr as ts.CallExpression);
    expect(result).not.toBeNull();
    expect(ts.isFunctionExpression(result!)).toBe(true);
  });

  it('detects instrumentFn with options object', () => {
    const expr = parseExpression(
      'instrumentFn({ name: "doWork" }, async function() { })'
    );
    const result = unwrapInstrumentFn(expr as ts.CallExpression);
    expect(result).not.toBeNull();
  });

  it('detects instrumentFn with arrow function', () => {
    const expr = parseExpression(
      'instrumentFn(async () => { })'
    );
    const result = unwrapInstrumentFn(expr as ts.CallExpression);
    expect(result).not.toBeNull();
    expect(ts.isArrowFunction(result!)).toBe(true);
  });

  it('returns null for non-instrumentFn calls', () => {
    const expr = parseExpression('someOtherFn(async function() { })');
    const result = unwrapInstrumentFn(expr as ts.CallExpression);
    expect(result).toBeNull();
  });

  it('returns null for instrumentFn with no function argument', () => {
    const expr = parseExpression('instrumentFn("name")');
    const result = unwrapInstrumentFn(expr as ts.CallExpression);
    expect(result).toBeNull();
  });
});

describe('unwrapVariableInitializer', () => {
  it('unwraps instrumentFn wrapper and marks as instrumented', () => {
    const init = parseExpression(
      'const x = instrumentFn(async function() { })'
    );
    const result = unwrapVariableInitializer(init);
    expect(result).not.toBeNull();
    expect(result!.isInstrumented).toBe(true);
    expect(
      ts.isFunctionExpression(result!.innerFunction) ||
        ts.isArrowFunction(result!.innerFunction)
    ).toBe(true);
  });

  it('returns plain arrow function with isInstrumented false', () => {
    const init = parseExpression('const x = () => 42');
    const result = unwrapVariableInitializer(init);
    expect(result).not.toBeNull();
    expect(result!.isInstrumented).toBe(false);
    expect(ts.isArrowFunction(result!.innerFunction)).toBe(true);
  });

  it('returns plain function expression with isInstrumented false', () => {
    const init = parseExpression('const x = function() { return 1; }');
    const result = unwrapVariableInitializer(init);
    expect(result).not.toBeNull();
    expect(result!.isInstrumented).toBe(false);
  });

  it('returns null for non-function initializers', () => {
    const init = parseExpression('const x = 42');
    const result = unwrapVariableInitializer(init);
    expect(result).toBeNull();
  });
});

describe('isInstrumentOwnMethodsInPlace', () => {
  it('extracts class name from instrumentOwnMethodsInPlace(Foo)', () => {
    const stmt = parseStatement('instrumentOwnMethodsInPlace(MyClass)');
    const result = isInstrumentOwnMethodsInPlace(stmt);
    expect(result).toBe('MyClass');
  });

  it('returns null for other function calls', () => {
    const stmt = parseStatement('someOtherCall(MyClass)');
    const result = isInstrumentOwnMethodsInPlace(stmt);
    expect(result).toBeNull();
  });

  it('returns null for non-expression statements', () => {
    const stmt = parseStatement('const x = 1;');
    const result = isInstrumentOwnMethodsInPlace(stmt);
    expect(result).toBeNull();
  });

  it('returns null when argument is not an identifier', () => {
    const stmt = parseStatement('instrumentOwnMethodsInPlace("string")');
    const result = isInstrumentOwnMethodsInPlace(stmt);
    expect(result).toBeNull();
  });
});
