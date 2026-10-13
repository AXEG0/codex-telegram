"""Test a genuine local PTY after leaving the Codex process ancestry.

The owner-only guard remains enabled. The fixture runs under a transient user service,
as a separately opened local shell would, and never operates the host session.
"""
import fcntl
import struct
import termios
import os
import pty
import select
import signal
import sys
import time

child, terminal = pty.fork()
if not child:
    os.execvp(sys.argv[1], sys.argv[1:])
fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
deadline = time.monotonic() + 180
try:
    while time.monotonic() < deadline:
        readable, _, _ = select.select([terminal, 0], [], [], 0.2)
        if terminal in readable:
            try:
                data = os.read(terminal, 65536)
            except OSError:
                break
            if not data:
                break
            os.write(1, data)
            if b'\x1b[6n' in data:
                os.write(terminal, b'\x1b[1;1R')
        if 0 in readable:
            data = os.read(0, 65536)
            if not data:
                break
            os.write(terminal, data)
finally:
    try:
        os.killpg(child, signal.SIGTERM)
    except ProcessLookupError:
        pass
    os.close(terminal)
    os.waitpid(child, 0)
