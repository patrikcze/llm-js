/** The Node.js version gate: the agent refuses releases with known remote code execution bugs. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nodeSecurityIssue, PATCHED_NODE } from "../src/runtime.ts";

describe("Node.js security gate", () => {
  it("accepts patched releases and newer majors", () => {
    for (const v of ["22.23.4", "22.24.0", "24.22.1", "24.23.0", "26.12.1", "26.13.0", "28.0.0"])
      assert.equal(nodeSecurityIssue(v), undefined, v);
  });

  it("rejects releases before the CVE-2026-111497 fix and unsupported lines", () => {
    for (const v of ["22.23.3", "22.18.0", "24.22.0", "24.15.0", "26.11.1", "26.0.0"])
      assert.match(nodeSecurityIssue(v) ?? "", /CVE-2026-111497.*Upgrade to \d+\.\d+\.\d+/, v);
    for (const v of ["20.19.0", "23.11.0", "25.9.0"]) assert.match(nodeSecurityIssue(v) ?? "", /not a supported release line/, v);
  });

  it("this test run itself uses a patched Node.js", () => {
    assert.equal(nodeSecurityIssue(), undefined, `Node.js ${process.versions.node}; patched: ${Object.values(PATCHED_NODE).join(", ")}`);
  });
});
