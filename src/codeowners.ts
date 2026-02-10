import * as fs from "fs";
import * as path from "path";

export interface CodeownersRule {
  pattern: string;
  teams: string[];
}

/**
 * Load and parse the CODEOWNERS file from the repo root.
 * Returns null if not found.
 */
export function loadCodeowners(repoRoot: string): CodeownersRule[] | null {
  const filePath = path.join(repoRoot, "CODEOWNERS");
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const content = fs.readFileSync(filePath, "utf-8");
  return parseCodeowners(content);
}

/**
 * Parse CODEOWNERS file content into rules.
 */
export function parseCodeowners(content: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;

    const pattern = parts[0];
    const teams = parts.slice(1).filter((t) => t.startsWith("@"));
    if (teams.length > 0) {
      rules.push({ pattern, teams });
    }
  }
  return rules;
}

/**
 * Check if a relative file path matches a CODEOWNERS pattern.
 */
function matchesPattern(relPath: string, pattern: string): boolean {
  // Normalize: strip leading /
  const p = pattern.startsWith("/") ? pattern.slice(1) : pattern;

  // Directory pattern: "path/to/dir/" — matches anything under dir
  if (p.endsWith("/")) {
    return relPath.startsWith(p) || relPath === p.slice(0, -1);
  }

  // Recursive glob: "path/**" — matches anything under path
  if (p.endsWith("/**")) {
    const prefix = p.slice(0, -3);
    return relPath.startsWith(prefix + "/") || relPath === prefix;
  }

  // Wildcard glob: contains * but not **
  if (p.includes("*")) {
    const regex = new RegExp(
      "^" +
        p
          .replace(/\./g, "\\.")
          .replace(/\*\*/g, "__DOUBLESTAR__")
          .replace(/\*/g, "[^/]*")
          .replace(/__DOUBLESTAR__/g, ".*") +
        "$",
    );
    return regex.test(relPath);
  }

  // Exact file match
  return relPath === p;
}

/**
 * Get the owning teams for a file path.
 * Uses last-matching-rule-wins semantics (per GitHub CODEOWNERS spec).
 */
export function getFileOwners(relPath: string, rules: CodeownersRule[]): string[] {
  let lastMatch: CodeownersRule | null = null;
  for (const rule of rules) {
    if (matchesPattern(relPath, rule.pattern)) {
      lastMatch = rule;
    }
  }
  if (!lastMatch) return [];
  return lastMatch.teams;
}

/**
 * Build a map of file path → owning teams for a set of file paths.
 * Only includes entries that have owners.
 */
export function buildCodeownersMap(
  filePaths: string[],
  rules: CodeownersRule[],
): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const fp of filePaths) {
    const owners = getFileOwners(fp, rules);
    if (owners.length > 0) {
      map[fp] = owners;
    }
  }
  return map;
}
