"""Run inside tests/Containerfile with /src mounted read-only and /work writable."""
import os
import pathlib
import shutil
import subprocess
import sys

work = pathlib.Path('/work/project')
shutil.copytree('/src', work,
                ignore=shutil.ignore_patterns('.git', '.work', 'dist', '__pycache__'))
# Supply a private bus address without exposing host system services to the compositor.
bus = subprocess.Popen(['dbus-daemon', '--session', '--nofork', '--print-address'],
                       stdout=subprocess.PIPE, text=True)
os.environ['DBUS_SYSTEM_BUS_ADDRESS'] = bus.stdout.readline().strip()
try:
    result = subprocess.run(['make', 'test-shell', 'test-prefs'], cwd=work, timeout=180)
finally:
    bus.terminate()
    bus.wait(timeout=5)
    bus.stdout.close()
if result.returncode:
    for log in sorted((work/'.work').rglob('*.log')):
        print(f'\n{log}:')
        print('\n'.join(log.read_text().splitlines()[-60:]))
sys.exit(result.returncode)
