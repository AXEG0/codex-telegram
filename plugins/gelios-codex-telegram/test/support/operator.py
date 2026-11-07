"""Test a genuine local PTY after leaving the Codex process ancestry.

The owner-only guard remains enabled. Callers can use a transient user service
when ancestry isolation is required; this PTY never operates the host session.
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
# The child closed its terminal: it is exiting, or has exited. Linux reads that
# as EIO and Darwin as an empty read.
hung_up = False
try:
    while time.monotonic() < deadline:
        readable, _, _ = select.select([terminal, 0], [], [], 0.2)
        if terminal in readable:
            try:
                data = os.read(terminal, 65536)
            except OSError:
                hung_up = True
                break
            if not data:
                hung_up = True
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
    def reaped_within(seconds):
        """Reap the child, waiting up to `seconds` for it to exit."""
        bound = time.monotonic() + seconds
        while not os.waitpid(child, os.WNOHANG)[0]:
            if time.monotonic() >= bound:
                return False
            time.sleep(0.02)
        return True

    def signal_group(signum):
        """Signal the child's group; True when the child was reaped instead."""
        try:
            os.killpg(child, signum)
        except ProcessLookupError:
            pass
        except PermissionError:
            # Darwin answers a signal to a group with no member it can signal
            # with EPERM, not ESRCH: a group holding only the exited child, or
            # a child still exiting. The child's own exit decides, within the
            # bound; a child still running then is killed by its pid, and the
            # run fails.
            if reaped_within(3):
                return True
            try:
                os.kill(child, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(child, 0)
            sys.exit(f'operator.py: the signal to process group {child} was refused and '
                     f'child {child} was not reaped within 3 s, so it was killed by its pid')
        return False

    # A child that closed its terminal gets the bound to exit before any signal;
    # otherwise one reap of a child that has already exited, then the signals.
    reaped = reaped_within(3 if hung_up else 0)
    if not reaped:
        reaped = signal_group(signal.SIGTERM)
    os.close(terminal)
    if not reaped and not reaped_within(3) and not signal_group(signal.SIGKILL):
        os.waitpid(child, 0)
