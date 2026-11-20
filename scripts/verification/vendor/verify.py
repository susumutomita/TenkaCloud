#!/usr/bin/env python3
"""Run reviewed repository checks and retain honest, commit-bound receipts."""
import argparse
import hashlib
import json
import os
import signal
from pathlib import Path
import subprocess
import tempfile
import time


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


def snapshot(root):
    return {'head': git(root, 'rev-parse', 'HEAD'),
            'dirty': bool(git(root, 'status', '--porcelain', '--untracked-files=all'))}


def load_map(path, profile):
    raw = path.read_bytes()
    data = json.loads(raw)
    if data.get('version') != 1:
        raise ValueError('Unsupported verification map version')
    checks = data['checks']
    selected = data['profiles'][profile]
    if not selected or len(selected) != len(set(selected)):
        raise ValueError('Profile must contain unique check IDs')
    for feature in data['features']:
        if not feature['id'] or not feature['paths'] or not feature['checks']:
            raise ValueError('Feature needs id, paths and checks')
        if any(check not in checks for check in feature['checks']):
            raise ValueError('Unknown feature check')
    for name in selected:
        if not name or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in name):
            raise ValueError('Unsafe check ID')
        check = checks[name]
        argv = check.get('argv')
        if not check.get('blocked_reason'):
            if not isinstance(argv, list) or not argv or not all(isinstance(x, str) and x for x in argv):
                raise ValueError('Check needs a nonempty argv array')
            timeout = check.get('timeout_seconds', 600)
            if not isinstance(timeout, int) or isinstance(timeout, bool) or not 1 <= timeout <= 7200:
                raise ValueError('Timeout must be 1..7200 seconds')
    return data, hashlib.sha256(raw).hexdigest()


def execute_check(name, check, root, output):
    result = {'id': name, 'argv': check.get('argv'), 'status': 'not-run', 'exit_code': None}
    if check.get('blocked_reason'):
        return dict(result, status='blocked', reason=check['blocked_reason'])
    logfile = output / (name + '.log')
    # IDs also become filenames. Reject paths before opening any output.
    if not name or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in name):
        raise ValueError('Unsafe check ID')
    started = time.monotonic()
    with logfile.open('wb') as log:
        try:
            process = subprocess.Popen(check['argv'], cwd=root, stdout=log, stderr=subprocess.STDOUT,
                                       start_new_session=True)
            try:
                code = process.wait(timeout=check.get('timeout_seconds', 600))
            except (subprocess.TimeoutExpired, KeyboardInterrupt):
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                raise
            result.update(exit_code=code, status='passed' if code == 0 else 'failed')
        except OSError as error:
            result.update(status='blocked', reason=str(error))
        except subprocess.TimeoutExpired:
            result.update(status='failed', reason='Check timed out')
        except KeyboardInterrupt:
            result.update(status='blocked', reason='Interrupted by operator')
    result.update(duration_seconds=round(time.monotonic() - started, 3), log=str(logfile),
                  log_sha256=hashlib.sha256(logfile.read_bytes()).hexdigest())
    return result


def run_check(name, check, root, output):
    try:
        return execute_check(name, check, root, output)
    except OSError as error:
        return {'id': name, 'argv': check.get('argv'), 'status': 'blocked',
                'exit_code': None, 'reason': f'Evidence unavailable: {error}'}


def file_digest(path):
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def verify(root, map_path, profile, output):
    root = Path(git(root, 'rev-parse', '--show-toplevel')).resolve()
    output = output.resolve()
    if output == root or root in output.parents:
        raise ValueError('Evidence directory must be outside the checkout')
    data, digest = load_map(map_path, profile)
    output.mkdir(parents=True, exist_ok=False)
    before = snapshot(root)
    runner_digest = file_digest(Path(__file__))
    results = [{'id': name, 'status': 'not-run', 'exit_code': None}
               for name in data['profiles'][profile]]
    for index, name in enumerate(data['profiles'][profile]):
        results[index] = run_check(name, data['checks'][name], root, output)
        if results[index].get('reason') == 'Interrupted by operator':
            break
    try:
        after = snapshot(root)
    except (OSError, subprocess.CalledProcessError):
        after = {'head': None, 'dirty': True}
    map_unchanged = file_digest(map_path) == digest
    runner_unchanged = runner_digest is not None and file_digest(Path(__file__)) == runner_digest
    stable = before == after and not before['dirty'] and not after['dirty'] and map_unchanged and runner_unchanged
    statuses = [result['status'] for result in results]
    status = 'failed' if 'failed' in statuses else 'blocked' if not stable or 'blocked' in statuses or 'not-run' in statuses else 'passed'
    receipt = {'version': 1, 'profile': profile, 'repository': str(root), 'before': before, 'after': after,
               'map_path': str(map_path.resolve()), 'map_sha256': digest,
               'runner_path': str(Path(__file__).resolve()),
               'runner_sha256': runner_digest, 'status': status, 'checkout_clean_unchanged': stable, 'checks': results,
               'scope': 'Selected commands only; not independent review, remote CI or release approval.'}
    if not stable:
        receipt['reason'] = 'Dirty checkout, HEAD, map or runner changed/unavailable; cannot attest an exact clean commit'
    (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('profile', choices=['fast', 'release'])
    parser.add_argument('--root', type=Path, default=Path.cwd())
    parser.add_argument('--map', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    output = args.output or Path(tempfile.mkdtemp(prefix='verification-')) / 'run'
    try:
        receipt = verify(args.root, args.map or args.root / 'verification.json', args.profile, output)
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(2, f'Verification blocked: {error}\n')
    print(f"{receipt['status']}: {output / 'receipt.json'}")
    return 0 if receipt['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
