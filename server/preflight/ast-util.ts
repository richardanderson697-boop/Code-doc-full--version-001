// Shared AST helpers for the first-party post-filters (destructive-handler,
// SSRF-taint). Mirrors the parsing approach of server/preflight/taint-path-filter.ts
// (which keeps its own copies — consolidating them is a separate cleanup).
// None of this edits the vendored engine; it re-reads source files in
// first-party code.
import { Parser } from "acorn";
import jsx from "acorn-jsx";
import * as acornLoose from "acorn-loose";

const JsxParser = Parser.extend(jsx());

export type AstNode = any;

export function parseFile(content: string, ext: string): AstNode | null {
  const isJsx = /\.(?:jsx|tsx)$/.test(ext);
  try {
    return JsxParser.parse(content, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
    });
  } catch {
    if (isJsx) return null;
    try {
      return acornLoose.parse(content, {
        ecmaVersion: "latest",
        sourceType: "module",
        locations: true,
      });
    } catch {
      return null;
    }
  }
}

// Read a chain of MemberExpression / Identifier and return the dotted name.
// Null when computed properties interrupt the chain.
export function readDottedName(node: AstNode): string | null {
  const parts: string[] = [];
  let cur = node;
  while (
    cur &&
    (cur.type === "MemberExpression" || cur.type === "Identifier" || cur.type === "ThisExpression")
  ) {
    if (cur.type === "Identifier") {
      parts.unshift(cur.name);
      break;
    }
    if (cur.type === "ThisExpression") {
      parts.unshift("this");
      break;
    }
    if (cur.computed) return null;
    if (cur.property.type !== "Identifier") return null;
    parts.unshift(cur.property.name);
    cur = cur.object;
  }
  return parts.length ? parts.join(".") : null;
}

// Source text of a node (start/end offsets). Empty string when unavailable.
export function sourceTextOf(node: AstNode, content: string): string {
  if (!node || typeof node.start !== "number" || typeof node.end !== "number") return "";
  return content.slice(node.start, node.end);
}

// Generic recursive walk. `visit` returns false to skip a subtree.
export function walkAst(node: AstNode, visit: (n: AstNode) => boolean | void): void {
  if (!node || typeof node !== "object") return;
  if (visit(node) === false) return;
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range" || key === "start" || key === "end") continue;
    const val = node[key];
    if (Array.isArray(val)) val.forEach((child) => walkAst(child, visit));
    else if (val && typeof val === "object") walkAst(val, visit);
  }
}

export const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

// Find the innermost function node containing `line`, or null for module scope.
export function findEnclosingFunction(ast: AstNode, line: number): AstNode | null {
  let best: AstNode | null = null;
  walkAst(ast, (node) => {
    if (FUNCTION_TYPES.has(node.type)) {
      const start = node.loc?.start?.line;
      const end = node.loc?.end?.line;
      if (typeof start === "number" && typeof end === "number" && line >= start && line <= end) {
        if (!best || (best.loc && node.loc && node.loc.start.line >= best.loc.start.line)) {
          best = node;
        }
      }
    }
  });
  return best;
}

// Every binding name introduced by a destructuring pattern.
export function patternNames(pattern: AstNode, out: string[] = []): string[] {
  if (!pattern || typeof pattern !== "object") return out;
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name);
      break;
    case "ObjectPattern":
      for (const prop of pattern.properties || []) {
        if (prop.type === "RestElement") patternNames(prop.argument, out);
        else patternNames(prop.value ?? prop.argument, out);
      }
      break;
    case "ArrayPattern":
      for (const el of pattern.elements || []) if (el) patternNames(el, out);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left, out);
      break;
    case "RestElement":
      patternNames(pattern.argument, out);
      break;
    default:
      break;
  }
  return out;
}

// The name a function node goes by, if it has one: a declaration name, a
// variable it is assigned to, or an object/class property key. Null for
// anonymous/inline functions.
export function functionName(node: AstNode): string | null {
  if (!node) return null;
  if (node.type === "FunctionDeclaration" && node.id?.type === "Identifier") {
    return node.id.name;
  }
  return null;
}
