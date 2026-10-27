"""Command runner for llm-agent in an OpenShell sandbox: the sandbox's entry point.

OpenShell allows a network rule for a program *or any of its parent processes*, and matches programs by
exact path. So commands that the agent server starts itself would inherit the server's allowlist, and a
command could also run the server's own node binary. This runner closes both:

  1. It starts the server (the private node copy /opt/llm-agent/node, the only path the policy allows)
     as its child, so the server is not an ancestor of any command.
  2. A forked executor process forbids itself, and so every command it starts, to execute anything
     outside a few directories (Landlock). /opt is not one of them: commands can run
     /usr/local/bin/node, but not the server's copy, and no rule matches them or their parents (sh,
     python). The server runs with --disable-sigusr1 and without NODE_OPTIONS, so a command cannot
     open Node's inspector in it (SIGUSR1 would, and the inspector runs code with the server's network
     access); ptrace and /proc/<pid>/mem of other processes are refused in OpenShell sandboxes. On
     Landlock ABI 6+ the executor also asks the kernel to stop commands signalling processes outside
     its domain; under OpenShell on Docker Desktop (kernel 7.0) that did not take effect, so commands
     can still kill the server (which stops the agent, but gives no network). If a command kills the
     executor, the supervisor starts a new one.
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
import time

# Directories commands may execute from. Anything else, notably /opt/llm-agent, is off limits.
EXEC_DIRS = ["/bin", "/sbin", "/lib", "/lib64", "/usr", "/app", "/workspace", "/tmp", "/home", "/config"]

# Landlock syscalls are numbered the same on every architecture (they are newer than the split).
SYS_LANDLOCK_CREATE_RULESET, SYS_LANDLOCK_ADD_RULE, SYS_LANDLOCK_RESTRICT_SELF = 444, 445, 446
LANDLOCK_ACCESS_FS_EXECUTE = 1
LANDLOCK_RULE_PATH_BENEATH = 1
LANDLOCK_CREATE_RULESET_VERSION = 1
LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET, LANDLOCK_SCOPE_SIGNAL = 1, 2
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

    abi = libc.syscall(SYS_LANDLOCK_CREATE_RULESET, None, ctypes.c_size_t(0), ctypes.c_uint32(LANDLOCK_CREATE_RULESET_VERSION))
    if abi >= 6:
        # struct landlock_ruleset_attr { handled_access_fs; handled_access_net; scoped }
        scoped = LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET | LANDLOCK_SCOPE_SIGNAL
        data = struct.pack("=QQQ", LANDLOCK_ACCESS_FS_EXECUTE, 0, scoped)
    else:
        data = struct.pack("=Q", LANDLOCK_ACCESS_FS_EXECUTE)
    attr = ctypes.create_string_buffer(data, len(data))  # exact size, no trailing NUL
    ruleset = check(libc.syscall(SYS_LANDLOCK_CREATE_RULESET, attr, ctypes.c_size_t(len(data)), ctypes.c_uint32(0)), "landlock_create_ruleset")
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

    def serve_commands():
        """Executor: restricts itself, then runs commands. Must not have started any thread yet."""
        refusal = None
        if landlock:
            try:
                restrict_exec(EXEC_DIRS)
            except OSError as e:
                refusal = f"commands are disabled: the sandbox could not keep them away from the network ({e})"
                print(f"llm-agent runner: {refusal}", file=sys.stderr, flush=True)
        while True:
            conn, _ = listener.accept()
            threading.Thread(target=Command(conn, refusal).serve, daemon=True).start()

    if not server_cmd:
        print(path, flush=True)
        serve_commands()
        return 0

    # The server must never open Node's inspector: commands could then run code inside it, with its
    # network access. SIGUSR1 would open it, and NODE_OPTIONS could ask for it.
    if os.path.basename(server_cmd[0]).startswith("node") and "--disable-sigusr1" not in server_cmd:
        server_cmd = [server_cmd[0], "--disable-sigusr1", *server_cmd[1:]]
    env = {k: v for k, v in os.environ.items() if k != "NODE_OPTIONS"}
    server = subprocess.Popen(server_cmd, env={**env, "AGENT_COMMAND_SOCKET": path})

    def start_executor():
        pid = os.fork()
        if pid == 0:
            try:
                serve_commands()
            finally:
                os._exit(1)
        return pid

    # Supervisor: outside the executor's Landlock domain, so (on ABI 6+) commands cannot signal it or
    # the server. It forwards stop signals to the server and replaces an executor that dies.
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda s, _f: server.send_signal(s))
    executor = start_executor()
    while True:
        try:
            pid, status = os.wait()
        except ChildProcessError:
            return 1
        except InterruptedError:
            continue
        if pid == server.pid:
            server.returncode = os.waitstatus_to_exitcode(status)
            try:
                os.kill(executor, signal.SIGKILL)
            except OSError:
                pass
            code = server.returncode
            return 128 - code if code < 0 else code
        if pid == executor:
            print("llm-agent runner: command executor exited; starting a new one", file=sys.stderr, flush=True)
            time.sleep(0.2)
            executor = start_executor()

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
