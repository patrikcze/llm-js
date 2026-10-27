"""Command runner for llm-agent in an OpenShell sandbox: the sandbox's entry point.

OpenShell allows a network rule for a program *or any of its parent processes*, and matches programs by
exact path. So commands that the agent server starts itself would inherit the server's allowlist, and a
command could also run the server's own node binary. This runner closes both:

  1. It starts the server (the private node copy /opt/llm-agent/node, the only path the policy allows)
     as its child, so the server is not an ancestor of any command.
  2. It then forbids itself, and so every command it starts, to execute anything outside a few
     directories (Landlock). /opt is not one of them: commands can run /usr/local/bin/node, but not the
     server's copy, and no rule matches them or their parents (sh, python).
  3. The server sends run_command requests over a Unix socket (AGENT_COMMAND_SOCKET), one connection per
     command, newline-delimited JSON:
       server -> runner  {"command", "cwd", "env", "stdin"}, then optionally {"kill": "SIGTERM"}
       runner -> server  {"pid"}, {"out": base64}..., {"exit": code, "signal": name}, {"eof": true}
                         or {"error": message} when the command cannot be started.
     Closing the connection kills the command's whole process group. Timeouts, output limits, the
     secret-free environment and the blocklist stay in the server (src/tools/shell.ts).

If Landlock is unavailable the runner fails closed: every request is answered with an error.

Usage: python3 -I runner.py [--no-landlock] [--socket PATH] [-- server command...]
Without a server command it serves until stopped (used by the tests, with --no-landlock).
"""

import base64
import ctypes
import json
import os
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading

# Directories commands may execute from. Anything else, notably /opt/llm-agent, is off limits.
EXEC_DIRS = ["/bin", "/sbin", "/lib", "/lib64", "/usr", "/app", "/workspace", "/tmp", "/home", "/config"]

# Landlock syscalls are numbered the same on every architecture (they are newer than the split).
SYS_LANDLOCK_CREATE_RULESET, SYS_LANDLOCK_ADD_RULE, SYS_LANDLOCK_RESTRICT_SELF = 444, 445, 446
LANDLOCK_ACCESS_FS_EXECUTE = 1
LANDLOCK_RULE_PATH_BENEATH = 1
PR_SET_NO_NEW_PRIVS = 38


def restrict_exec(dirs):
    """Allows the calling thread and its future children to execute files beneath `dirs` only."""
    if not sys.platform.startswith("linux"):
        raise OSError("Landlock needs Linux")
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long

    def check(result, what):
        if result < 0:
            err = ctypes.get_errno()
            raise OSError(err, f"{what}: {os.strerror(err)}")
        return result

    attr = ctypes.create_string_buffer(struct.pack("=Q", LANDLOCK_ACCESS_FS_EXECUTE))
    ruleset = check(libc.syscall(SYS_LANDLOCK_CREATE_RULESET, attr, ctypes.c_size_t(8), ctypes.c_uint32(0)), "landlock_create_ruleset")
    try:
        for d in dirs:
            try:
                fd = os.open(d, os.O_PATH | os.O_CLOEXEC)
            except OSError:
                continue  # not in this image
            try:
                rule = ctypes.create_string_buffer(struct.pack("=Qi", LANDLOCK_ACCESS_FS_EXECUTE, fd))
                check(libc.syscall(SYS_LANDLOCK_ADD_RULE, ruleset, LANDLOCK_RULE_PATH_BENEATH, rule, ctypes.c_uint32(0)), "landlock_add_rule")
            finally:
                os.close(fd)
        check(libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), "prctl(NO_NEW_PRIVS)")
        check(libc.syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset, ctypes.c_uint32(0)), "landlock_restrict_self")
    finally:
        os.close(ruleset)


class Command:
    """One connection: runs one command and streams its output back."""

    def __init__(self, conn, refusal):
        self.conn = conn
        self.refusal = refusal
        self.lock = threading.Lock()
        self.proc = None

    def send(self, msg):
        with self.lock:
            try:
                self.conn.sendall(json.dumps(msg).encode() + b"\n")
            except OSError:
                pass  # the server went away; closing the connection stops the command

    def kill(self, sig):
        if self.proc is None:
            return
        try:
            os.killpg(self.proc.pid, sig)
        except OSError:
            pass  # already gone

    def serve(self):
        lines = self.conn.makefile("rb")
        try:
            first = lines.readline()
            if not first:
                return
            if self.refusal:
                return self.send({"error": self.refusal})
            req = json.loads(first)
            try:
                self.proc = subprocess.Popen(
                    ["/bin/sh", "-c", f"exec 2>&1\n{req['command']}"],
                    cwd=req.get("cwd") or None,
                    env=req.get("env") or {},
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    # Own process group, so a timeout can stop the command and everything it started.
                    start_new_session=True,
                )
            except OSError as e:
                return self.send({"error": e.strerror or str(e)})
            self.send({"pid": self.proc.pid})
            threading.Thread(target=self.feed, args=(req.get("stdin") or "",), daemon=True).start()
            threading.Thread(target=self.pump, daemon=True).start()
            threading.Thread(target=self.wait, daemon=True).start()
            for line in lines:
                sig = json.loads(line).get("kill")
                if sig in ("SIGTERM", "SIGKILL", "SIGINT"):
                    self.kill(getattr(signal, sig))
        except (OSError, ValueError, KeyError):
            pass
        finally:
            # The server hung up: nothing the command started may outlive it.
            self.kill(signal.SIGKILL)
            if self.proc is not None:
                self.proc.wait()
            self.conn.close()

    def feed(self, text):
        try:
            if text:
                self.proc.stdin.write(text.encode())
            self.proc.stdin.close()
        except OSError:
            pass  # the command may exit without reading stdin

    def pump(self):
        fd = self.proc.stdout.fileno()
        while chunk := os.read(fd, 65536):
            self.send({"out": base64.b64encode(chunk).decode()})
        self.send({"eof": True})

    def wait(self):
        code = self.proc.wait()
        if code < 0:
            self.send({"exit": None, "signal": signal.Signals(-code).name})
        else:
            self.send({"exit": code, "signal": None})


def main(argv):
    landlock = "--no-landlock" not in argv
    server_cmd = argv[argv.index("--") + 1 :] if "--" in argv else []
    opts = argv[: argv.index("--")] if "--" in argv else argv
    if "--socket" in opts:
        path = opts[opts.index("--socket") + 1]
    else:
        path = os.path.join(tempfile.mkdtemp(prefix="llm-agent-runner-"), "sock")

    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(path)
    os.chmod(path, 0o600)
    listener.listen(16)

    server = None
    if server_cmd:
        server = subprocess.Popen(server_cmd, env={**os.environ, "AGENT_COMMAND_SOCKET": path})
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, lambda s, _f: server.send_signal(s))

    # Restrict before starting any thread: Landlock applies to the calling thread and its children.
    refusal = None
    if landlock:
        try:
            restrict_exec(EXEC_DIRS)
        except OSError as e:
            refusal = f"commands are disabled: the sandbox could not keep them away from the network ({e})"
            print(f"llm-agent runner: {refusal}", file=sys.stderr, flush=True)

    def accept():
        while True:
            conn, _ = listener.accept()
            threading.Thread(target=Command(conn, refusal).serve, daemon=True).start()

    if server is None:
        print(path, flush=True)
        accept()
        return 0
    threading.Thread(target=accept, daemon=True).start()
    code = server.wait()
    return 128 - code if code < 0 else code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
