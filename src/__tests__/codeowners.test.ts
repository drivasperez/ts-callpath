import { describe, it, expect } from "vitest";
import {
  parseCodeowners,
  getFileOwners,
  buildCodeownersMap,
  loadCodeowners,
} from "../codeowners.js";

import type { CodeownersRule } from "../codeowners.js";

describe("parseCodeowners", () => {
  it("parses rules from content", () => {
    const content = `
# This is a comment
py/jobs/ @watershed-climate/calcprint
workspaces/app-dashboard/ @watershed-climate/frontend @watershed-climate/infra
    `;
    const rules = parseCodeowners(content);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({
      pattern: "py/jobs/",
      teams: ["@watershed-climate/calcprint"],
    });
    expect(rules[1]).toEqual({
      pattern: "workspaces/app-dashboard/",
      teams: ["@watershed-climate/frontend", "@watershed-climate/infra"],
    });
  });

  it("skips blank lines and comments", () => {
    const content = `
# comment

   # another comment

`;
    const rules = parseCodeowners(content);
    expect(rules).toHaveLength(0);
  });

  it("skips lines without team owners", () => {
    const content = `some/path notat`;
    const rules = parseCodeowners(content);
    expect(rules).toHaveLength(0);
  });
});

describe("getFileOwners", () => {
  const rules: CodeownersRule[] = [
    { pattern: "*.ts", teams: ["@org/ts-team"] },
    { pattern: "py/jobs/", teams: ["@org/backend"] },
    { pattern: "py/jobs/special/", teams: ["@org/special"] },
    { pattern: "workspaces/domain/**", teams: ["@org/domain"] },
    { pattern: "src/file.ts", teams: ["@org/specific"] },
  ];

  it("uses last-match-wins semantics", () => {
    // py/jobs/special/foo.py matches both py/jobs/ and py/jobs/special/
    // Last match (py/jobs/special/) wins
    const owners = getFileOwners("py/jobs/special/foo.py", rules);
    expect(owners).toEqual(["special"]);
  });

  it("matches directory prefix patterns", () => {
    const owners = getFileOwners("py/jobs/transform.py", rules);
    expect(owners).toEqual(["backend"]);
  });

  it("matches recursive glob patterns", () => {
    const owners = getFileOwners("workspaces/domain/service/BartService.ts", rules);
    expect(owners).toEqual(["domain"]);
  });

  it("matches exact file patterns", () => {
    const owners = getFileOwners("src/file.ts", rules);
    expect(owners).toEqual(["specific"]);
  });

  it("strips @org/ prefix from team names", () => {
    const owners = getFileOwners("py/jobs/foo.py", rules);
    expect(owners).toEqual(["backend"]);
  });

  it("returns empty array when no rules match", () => {
    const owners = getFileOwners("unmatched/path/file.go", [
      { pattern: "other/", teams: ["@org/other"] },
    ]);
    expect(owners).toEqual([]);
  });

  it("handles patterns with leading slash", () => {
    const rules: CodeownersRule[] = [{ pattern: "/src/config.ts", teams: ["@org/infra"] }];
    const owners = getFileOwners("src/config.ts", rules);
    expect(owners).toEqual(["infra"]);
  });

  it("handles multiple team owners", () => {
    const rules: CodeownersRule[] = [{ pattern: "shared/", teams: ["@org/team-a", "@org/team-b"] }];
    const owners = getFileOwners("shared/utils.ts", rules);
    expect(owners).toEqual(["team-a", "team-b"]);
  });
});

describe("buildCodeownersMap", () => {
  it("builds map with only matched files", () => {
    const rules: CodeownersRule[] = [{ pattern: "src/", teams: ["@org/frontend"] }];
    const map = buildCodeownersMap(["src/app.ts", "src/utils.ts", "lib/other.ts"], rules);
    expect(map).toEqual({
      "src/app.ts": ["frontend"],
      "src/utils.ts": ["frontend"],
    });
    expect(map["lib/other.ts"]).toBeUndefined();
  });
});

describe("loadCodeowners", () => {
  it("returns null for non-existent CODEOWNERS file", () => {
    const result = loadCodeowners("/non/existent/path");
    expect(result).toBeNull();
  });
});
