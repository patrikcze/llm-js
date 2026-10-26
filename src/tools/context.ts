import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SAFE_GIT_ARGS, safeGitEnv } from "./git.ts";
import { type Tool, ToolError } from "./types.ts";

const run = promisify(execFile);

/** Runs a program without a shell; returns trimmed stdout, or "" on any failure. */
async function quiet(file: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await run(file, args, { cwd, env, timeout: 3000, maxBuffer: 1_000_000, windowsHide: true });
    return stdout.trim();
  } catch {
    return "";
  }
}

const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");

export function timeInfo(now = new Date()) {
  const opts = Intl.DateTimeFormat().resolvedOptions();
  const offMin = -now.getTimezoneOffset();
  const offset = `${offMin >= 0 ? "+" : "-"}${pad(offMin / 60)}:${pad(offMin % 60)}`;
  const localIso =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offset}`;
  return {
    local: localIso,
    utc: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    human: now.toLocaleString("en-US", { dateStyle: "full", timeStyle: "long", timeZone: opts.timeZone }),
    weekday: now.toLocaleDateString("en-US", { weekday: "long" }),
    timeZone: opts.timeZone,
    utcOffset: `UTC${offset}`,
    locale: opts.locale,
    unix: Math.floor(now.getTime() / 1000),
  };
}

async function osName(): Promise<string> {
  if (process.platform === "darwin") {
    const [name, version] = await Promise.all([quiet("sw_vers", ["-productName"]), quiet("sw_vers", ["-productVersion"])]);
    if (version) return `${name || "macOS"} ${version}`;
  }
  if (process.platform === "linux") {
    const release = await readFile("/etc/os-release", "utf8").catch(() => "");
    const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(release)?.[1];
    if (pretty) return pretty;
  }
  return `${os.type()} ${os.release()}`;
}

/**
 * Memory the system could give to programs right now. os.freemem() counts only unused pages,
 * which on macOS and Linux is a small fraction of what is really available (caches are reclaimable).
 */
async function availableMemory(): Promise<number> {
  if (process.platform === "darwin") {
    const vm = await quiet("vm_stat", []);
    const pageSize = Number(/page size of (\d+) bytes/.exec(vm)?.[1] ?? 4096);
    const pages = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(vm)?.[1] ?? 0);
    const total = (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable")) * pageSize;
    if (total > 0) return total;
  }
  if (process.platform === "linux") {
    const kb = /^MemAvailable:\s+(\d+) kB/m.exec(await readFile("/proc/meminfo", "utf8").catch(() => ""))?.[1];
    if (kb) return Number(kb) * 1024;
  }
  return os.freemem();
}

// Command-line tools worth knowing about before calling run_command.
const PROBES = [
  "bash",
  "zsh",
  "git",
  "node",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "python3",
  "pip3",
  "uv",
  "go",
  "cargo",
  "java",
  "docker",
  "make",
  "curl",
  "wget",
  "jq",
  "rg",
  "fd",
  "brew",
  "apt-get",
  "apk",
  "ffmpeg",
  "fastfetch",
  "neofetch",
];

async function availableCommands(): Promise<string[]> {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const found = await Promise.all(
    PROBES.map(async (name) => {
      for (const dir of dirs) {
        const candidates = process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`] : [name];
        for (const c of candidates) {
          if (
            await access(path.join(dir, c), constants.X_OK).then(
              () => true,
              () => false,
            )
          )
            return name;
        }
      }
      return "";
    }),
  );
  return found.filter(Boolean);
}

async function workspaceInfo(dir: string): Promise<string[]> {
  const lines = [`Path: ${dir}`];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  lines.push(`Top level: ${entries.filter((e) => e.isDirectory()).length} directories, ${entries.filter((e) => e.isFile()).length} files`);

  // Only git subcommands that never refresh the index (no `status`: it runs core.fsmonitor and
  // filter programs from the repository's config), with program-launching settings overridden.
  const git = (...args: string[]) => quiet("git", [...SAFE_GIT_ARGS, "-C", dir, ...args], undefined, safeGitEnv());
  const inGit = (await git("rev-parse", "--is-inside-work-tree")) === "true";
  if (inGit) {
    const [branch, last, remote] = await Promise.all([
      git("branch", "--show-current"),
      git("log", "-1", "--no-show-signature", "--format=%h %s (%cr)"),
      git("remote", "get-url", "origin"),
    ]);
    lines.push(
      `Git: branch ${branch || "(detached)"} · ${last || "no commits yet"}` +
        (remote ? ` · origin ${remote.replace(/\/\/[^@/]+@/, "//")}` : "") +
        " · local changes: run `git status` with run_command",
    );
  } else {
    lines.push("Git: not a repository");
  }

  const markers = [
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "Gemfile",
    "composer.json",
    "Makefile",
    "Dockerfile",
    "docker-compose.yml",
    "AGENTS.md",
    "README.md",
  ].filter((f) => existsSync(path.join(dir, f)));
  lines.push(`Project files: ${markers.join(", ") || "none detected"}`);

  if (markers.includes("package.json")) {
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
      const scripts = Object.keys(pkg.scripts ?? {});
      lines.push(
        `package.json: ${pkg.name ?? "(unnamed)"}${pkg.version ? `@${pkg.version}` : ""}` +
          (scripts.length ? ` · scripts: ${scripts.slice(0, 20).join(", ")}` : ""),
      );
    } catch {
      lines.push("package.json: unreadable");
    }
  }
  return lines;
}

export const localContextTool: Tool<Record<string, never>, string> = {
  name: "local_context",
  risk: "read",
  description:
    "Get the current local date, time and time zone, facts about this computer (OS, CPU, memory, shell, user, " +
    "container or not, which command-line tools are installed) and the workspace (git branch and status, project " +
    "files, package scripts). Call it whenever you need the current time/date or information about the environment.",
  parameters: { type: "object", properties: {} },
  async run(_args, ctx) {
    if (ctx.signal.aborted) throw new ToolError("Cancelled");
    const t = timeInfo();
    const [osLabel, commands, workspace, memAvailable] = await Promise.all([
      osName(),
      availableCommands(),
      workspaceInfo(ctx.workspace),
      availableMemory(),
    ]);
    const cpus = os.cpus();
    const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    const container = existsSync("/.dockerenv") || existsSync("/run/.containerenv");
    let user = "";
    try {
      user = os.userInfo().username;
    } catch {}

    return [
      "# Date and time",
      `Local: ${t.local} (${t.human})`,
      `UTC: ${t.utc} · Unix: ${t.unix}`,
      `Time zone: ${t.timeZone} (${t.utcOffset}) · Locale: ${t.locale}`,
      "",
      "# System",
      `OS: ${osLabel} · ${process.platform}/${os.arch()}${container ? " · inside a container" : ""}`,
      `Host: ${os.hostname()} · User: ${user || "unknown"} · Shell: ${process.env.SHELL ?? (process.platform === "win32" ? "cmd.exe" : "/bin/sh")}`,
      `CPU: ${cpus[0]?.model?.trim() ?? "unknown"} × ${cpus.length} · Memory: ${gb(memAvailable)} available of ${gb(os.totalmem())}`,
      `Uptime: ${(os.uptime() / 3600).toFixed(1)} h${
        process.platform !== "win32"
          ? ` · Load: ${os
              .loadavg()
              .map((l) => l.toFixed(2))
              .join(" ")}`
          : ""
      }`,
      `Node.js: ${process.version}`,
      `Commands on PATH: ${commands.join(", ") || "none of the common ones"}`,
      "",
      "# Workspace",
      ...workspace,
    ].join("\n");
  },
};
