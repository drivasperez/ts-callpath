import ts from 'typescript';

/**
 * Check if a call expression is an instrumentFn(...) wrapper.
 * Returns the inner function expression if so, null otherwise.
 */
export function unwrapInstrumentFn(
  node: ts.CallExpression
): ts.FunctionExpression | ts.ArrowFunction | null {
  // Pattern: instrumentFn(async function name() { ... })
  // or instrumentFn("name", async function() { ... })
  // or instrumentFn({ name: "..." }, async function() { ... })
  const callee = node.expression;
  if (!ts.isIdentifier(callee)) return null;
  if (callee.text !== 'instrumentFn') return null;

  // The function is typically the first or second argument
  for (const arg of node.arguments) {
    if (ts.isFunctionExpression(arg) || ts.isArrowFunction(arg)) {
      return arg;
    }
  }

  return null;
}

/**
 * Check if a variable declaration's initializer is an instrumentFn wrapper.
 * Returns the inner function and whether it was instrumented.
 */
export function unwrapVariableInitializer(init: ts.Expression): {
  innerFunction: ts.FunctionExpression | ts.ArrowFunction;
  isInstrumented: boolean;
} | null {
  if (ts.isCallExpression(init)) {
    const inner = unwrapInstrumentFn(init);
    if (inner) {
      return { innerFunction: inner, isInstrumented: true };
    }
  }

  if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) {
    return { innerFunction: init, isInstrumented: false };
  }

  return null;
}

/**
 * Check if a statement is instrumentOwnMethodsInPlace(ClassName).
 * Returns the class name if so.
 */
export function isInstrumentOwnMethodsInPlace(
  node: ts.Statement
): string | null {
  if (!ts.isExpressionStatement(node)) return null;
  const expr = node.expression;
  if (!ts.isCallExpression(expr)) return null;
  const callee = expr.expression;
  if (!ts.isIdentifier(callee)) return null;
  if (callee.text !== 'instrumentOwnMethodsInPlace') return null;

  if (expr.arguments.length >= 1 && ts.isIdentifier(expr.arguments[0])) {
    return expr.arguments[0].text;
  }
  return null;
}
