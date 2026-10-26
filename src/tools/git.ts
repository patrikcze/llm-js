// Running git on a workspace that may be untrusted.
//
// A repository's own config can name programs that git runs: core.fsmonitor (on any index
// refresh, e.g. `git status`), clean/smudge filters, gpg.program (signature display), hooks,
// pagers and external diff tools. Read-only tools run without approval, so they must never let
// the repository launch a program: they only use subcommands that do not refresh the index,
// and they override every program-launching setting on the command line (-c beats repo config).

export const SAFE_GIT_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.pager=cat",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "log.showSignature=false",
  "-c",
  "gpg.program=false",
  "-c",
  "diff.external=",
  "--no-optional-locks",
];

/** Environment for git runs by read-only tools: no system config, no prompts, no optional locks. */
export function safeGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
  };
}

/** True when a path relative to the workspace goes into a .git directory (repository internals). */
export function insideGitDir(relativePath: string): boolean {
  return relativePath.split(/[\\/]+/).some((segment) => segment.toLowerCase() === ".git");
}
