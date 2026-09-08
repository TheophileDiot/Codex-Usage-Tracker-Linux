#!/usr/bin/env python3
"""A real stdio process exercising the app-server client's transport contract."""

import json
import os
import pathlib
import signal
import sys
import time

home = pathlib.Path(os.environ["CODEX_HOME"])
fixture = json.loads((home / "fixture.json").read_text())
if fixture.get("mode") == "ignore-term":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
(home / "pid").write_text(str(os.getpid()))
assert sys.argv[1:] == ["app-server", "--listen", "stdio://"]
initialized = False
initializations = 0
held = None


def send(value, fragmented=False):
    data = (json.dumps(value, ensure_ascii=False) + "\n").encode()
    if fragmented:
        for offset in range(0, len(data), 7):
            sys.stdout.buffer.write(data[offset:offset + 7])
            sys.stdout.buffer.flush()
            time.sleep(0.001)
    else:
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


for line in sys.stdin:
    request = json.loads(line)
    method = request["method"]
    params = request.get("params", {})
    request_id = request.get("id")
    if method == "initialize":
        initializations += 1
        assert initializations == 1
        assert params["clientInfo"]["name"]
        assert isinstance(params["capabilities"]["experimentalApi"], bool)
        if fixture.get("mode") == "hang-init":
            time.sleep(60)
        if fixture.get("mode") == "exit-init":
            sys.exit(7)
        if fixture.get("mode") == "fail-init":
            send({"id": request_id, "error": {"code": -32600, "message": "Initialization rejected"}})
            continue
        send({"method": "test/notice", "params": {"text": "prêt 🦊"}}, fragmented=True)
        agent = f'{params["clientInfo"]["name"]}/0.153.4 (Linux 6.8.0; x86_64) Orca/1.4.197 (usage_monitor; 0.0.0)'
        send({"id": request_id, "result": {"userAgent": agent, "platformFamily": "unix", "platformOs": "linux"}}, fragmented=True)
    elif method == "initialized":
        assert request_id is None
        assert params == {}
        initialized = True
    else:
        assert initialized, "request before initialized notification"
        if method == "echo":
            send({"id": request_id, "result": params}, fragmented=True)
        elif method == "inspect":
            send({"id": request_id, "result": {"home": str(home), "path": os.environ["PATH"], "cwd": os.getcwd(), "initializations": initializations, "pid": os.getpid()}})
        elif method == "hold":
            held = request_id
        elif method == "release":
            assert held is not None
            responses = [{"id": request_id, "result": "second"}, {"method": "test/batch", "params": {}}, {"id": held, "result": "first"}]
            sys.stdout.write("".join(json.dumps(value) + "\n" for value in responses))
            sys.stdout.flush()
            held = None
        elif method == "fail":
            send({"id": request_id, "error": {"code": -32602, "message": "Invalid parameter", "data": {"private": "never log this"}}})
        elif method == "never":
            pass
        elif method == "block":
            time.sleep(60)
        elif method == "late":
            time.sleep(0.5)
            send({"id": request_id, "result": "too late"})
        elif method == "exit":
            sys.stderr.write("private stderr must never reach shell logs\n")
            sys.exit(7)
        elif method == "oversize":
            sys.stdout.write("x" * (4 * 1024 * 1024 + 1))
            sys.stdout.flush()
            time.sleep(60)
        elif method == "malformed":
            sys.stdout.write("{invalid json}\n")
            sys.stdout.flush()
        elif method == "server/request":
            send({"id": "server-owned", "method": "item/commandExecution/requestApproval", "params": {}})
            send({"id": request_id, "result": "unsolicited request sent"})
        elif method == "notices":
            sys.stdout.write('{"method":"stop-now","params":{}}\n{"method":"after-stop","params":{}}\n')
            sys.stdout.flush()
        else:
            raise AssertionError(f"Unexpected method: {method}")
