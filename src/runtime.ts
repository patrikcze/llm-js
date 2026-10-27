// Refuse to run on a Node.js release with known remotely exploitable bugs.
//
// The agent downloads content chosen by the model or by web pages (web_fetch, the UI image proxy,
// provider APIs), and Node decodes compressed responses with its bundled zlib/Brotli. Node.js
// versions before the October 2026 security releases have an out-of-bounds write in the Brotli
// decoder (CVE-2026-111497) that a malicious server can use for remote code execution.

/** Oldest safe release per supported major line. Raise these with every Node.js security release. */
export const PATCHED_NODE: Readonly<Record<number, string>> = { 22: "22.23.4", 24: "24.22.1", 26: "26.12.1" };
/** Newest line in PATCHED_NODE; later majors are assumed to include the fixes. */
const NEWEST_KNOWN = Math.max(...Object.keys(PATCHED_NODE).map(Number));

const parse = (v: string) =>
  v
    .replace(/^v/, "")
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);

function older(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

/** Why this Node.js version is unsafe, or undefined when it is fine. */
export function nodeSecurityIssue(version: string = process.versions.node): string | undefined {
  const v = parse(version);
  const major = v[0] ?? 0;
  const lines = Object.values(PATCHED_NODE).join(", ");
  if (major > NEWEST_KNOWN) return undefined;
  const min = PATCHED_NODE[major];
  if (!min) return `Node.js ${version} is not a supported release line and gets no security fixes. Use one of: ${lines} or newer.`;
  if (older(v, parse(min)))
    return `Node.js ${version} has known remote code execution bugs (e.g. CVE-2026-111497 in the Brotli decoder). Upgrade to ${min} or newer.`;
  return undefined;
}

/** Exits when Node.js is unpatched, unless AGENT_ALLOW_UNPATCHED_NODE=1 (for tests of old setups only). */
export function requirePatchedNode(): void {
  const issue = nodeSecurityIssue();
  if (!issue) return;
  if (process.env.AGENT_ALLOW_UNPATCHED_NODE === "1") {
    console.warn(`WARNING: ${issue} Running anyway because AGENT_ALLOW_UNPATCHED_NODE=1.`);
    return;
  }
  console.error(`Refusing to start: ${issue}\n(Override at your own risk with AGENT_ALLOW_UNPATCHED_NODE=1.)`);
  process.exit(1);
}
