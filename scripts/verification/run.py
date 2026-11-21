#!/usr/bin/env python3
"""Execute the reviewed vendored verifier only after checking its pinned bytes."""
import hashlib
import json
from pathlib import Path
import runpy
import sys


def checked_runner(directory):
    pin = json.loads((directory / 'upstream.json').read_text())
    runner = directory / 'vendor' / 'verify.py'
    if hashlib.sha256(runner.read_bytes()).hexdigest() != pin['sha256']:
        raise ValueError('Vendored verification runner differs from reviewed pin')
    return runner


if __name__ == '__main__':
    try:
        source = checked_runner(Path(__file__).resolve().parent)
    except (OSError, ValueError, KeyError) as error:
        sys.exit(f'Verification blocked: {error}')
    runpy.run_path(str(source), run_name='__main__')
