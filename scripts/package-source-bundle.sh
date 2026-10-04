#!/usr/bin/env bash
# Build the source.zip consumed by CodeBuild without installing dependencies or
# touching AWS. Only the two host applications' built distributions are included.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SOURCE_BUNDLE_ROOT="${SOURCE_BUNDLE_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
export SOURCE_BUNDLE_WORK_DIR="${SOURCE_BUNDLE_WORK_DIR:-${SOURCE_BUNDLE_ROOT}/.cache/source-bundle}"
export SOURCE_BUNDLE_ARCHIVE_PATH="${SOURCE_BUNDLE_ARCHIVE_PATH:-${SOURCE_BUNDLE_WORK_DIR}/source.zip}"

python3 - <<'PY'
import fnmatch
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import zipfile


def fail(message):
    sys.exit('[package-source-bundle] ERROR: ' + message)


def checked_path(raw, description):
    path = Path(raw)
    if not path.is_absolute():
        fail(description + ' must be absolute')
    if '..' in path.parts:
        fail(description + ' must not contain parent traversal')
    for item in (path, *path.parents):
        if item.is_symlink():
            fail(description + ' must not contain a symlink')
    return path.resolve()


root = checked_path(os.environ['SOURCE_BUNDLE_ROOT'], 'SOURCE_BUNDLE_ROOT')
work = checked_path(os.environ['SOURCE_BUNDLE_WORK_DIR'], 'SOURCE_BUNDLE_WORK_DIR')
archive = checked_path(os.environ['SOURCE_BUNDLE_ARCHIVE_PATH'], 'archive path')
if work == root or work in root.parents or work == Path('/'):
    fail('unsafe SOURCE_BUNDLE_WORK_DIR')
if root in work.parents and root / '.cache' not in work.parents:
    fail('repository work directory must be inside .cache')
if work not in archive.parents:
    fail('archive path must stay inside work directory')
staging = work / 'staging'
if archive == staging or staging in archive.parents:
    fail('archive path must be outside staging directory')
marker = work / '.tenkacloud-source-bundle'
if archive == marker:
    fail('archive path must not overwrite the work directory marker')
if work.exists() and not work.is_dir():
    fail('SOURCE_BUNDLE_WORK_DIR must be a directory')
# Never clear an arbitrary existing directory, even if a caller chooses it.
if work.exists() and any(work.iterdir()) and not marker.is_file():
    fail('nonempty work directory is not owned by source-bundle packaging')
if marker.is_symlink() or (marker.exists() and marker.read_text() != str(root)):
    fail('work directory marker does not match SOURCE_BUNDLE_ROOT')


def limit(name, default):
    raw = os.environ.get(name, str(default))
    if not raw.isdecimal() or int(raw) < 1:
        fail(name + ' must be a positive integer')
    return int(raw) * 1024 * 1024


max_staging = limit('SOURCE_BUNDLE_MAX_STAGING_MB', 256)
max_archive = limit('SOURCE_BUNDLE_MAX_ARCHIVE_MB', 128)
# Used by preparation to validate cleanup targets before setting an EXIT trap.
if os.environ.get('SOURCE_BUNDLE_VALIDATE_ONLY') == '1':
    sys.exit(0)
if os.environ.get('SOURCE_BUNDLE_CLEANUP_ONLY') == '1':
    if marker.exists():
        shutil.rmtree(work)
    sys.exit(0)

excluded = (
    'node_modules', 'cdk.out*', 'dist', 'coverage', '.cache', '.git', '.env*',
    '.DS_Store', '.aws', '.ssh', '.npmrc', '.netrc', 'credentials',
    '*.pem', '*.key', '*.p12', '*.pfx',
)


def is_excluded(name):
    return any(fnmatch.fnmatch(name, pattern) for pattern in excluded)


def require_regular(source):
    if source.is_symlink() or not source.is_file():
        fail('source must be a regular file, not a symlink: ' + str(source.relative_to(root)))


def copy_tree(relative, target):
    source = root / relative
    checked_path(str(source), 'source directory')
    if not source.is_dir():
        fail('required directory missing: ' + relative)
    for directory, dirs, files in os.walk(source, followlinks=False):
        dirs[:] = sorted(name for name in dirs if not is_excluded(name))
        for name in dirs:
            if (Path(directory) / name).is_symlink():
                fail('source directory must not contain a symlink: ' + str(Path(directory) / name))
        destination = staging / target / Path(directory).relative_to(source)
        destination.mkdir(parents=True, exist_ok=True)
        for name in sorted(files):
            if not is_excluded(name):
                item = Path(directory) / name
                require_regular(item)
                shutil.copy2(item, destination / name)


work.mkdir(parents=True, exist_ok=True)
marker.write_text(str(root))
if staging.is_symlink():
    fail('staging directory must not be a symlink')
if staging.exists():
    shutil.rmtree(staging)
if archive.exists():
    archive.unlink()
try:
    for source, target in [('infrastructure', 'cdk'), ('scripts', 'scripts'),
                           ('problems', 'problems'), ('packages', 'packages')]:
        copy_tree(source, target)
    if not any((staging / 'problems').rglob('metadata.json')):
        fail('problem catalog submodule is not checked out; run git submodule update --init --recursive')
    pack_store = root / '.tenkacloud' / 'pack-store'
    if pack_store.exists() or pack_store.is_symlink():
        copy_tree('.tenkacloud/pack-store', '.tenkacloud/pack-store')
    else:
        print('[package-source-bundle] no .tenkacloud/pack-store found, skipping (packs are optional)')
    for name in ['.nvmrc', 'package.json']:
        require_regular(root / name)
        shutil.copy2(root / name, staging / name)
    package_path = staging / 'package.json'
    package = json.loads(package_path.read_text())
    package['workspaces'] = [item if item != 'infrastructure' else 'cdk'
                             for item in package.get('workspaces', [])]
    package_path.write_text(json.dumps(package, indent=2) + '\n')
    for app in ['application-admin-console', 'participant-portal']:
        copy_tree('apps/' + app + '/dist', 'apps/' + app + '/dist')
    files = sorted(item for item in staging.rglob('*') if item.is_file())
    size = sum(item.stat().st_size for item in files)
    if size > max_staging:
        fail('staged bundle exceeds limit before archive creation')
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
        for item in files:
            info = zipfile.ZipInfo(item.relative_to(staging).as_posix())
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (stat.S_IFREG | stat.S_IMODE(item.stat().st_mode)) << 16
            bundle.writestr(info, item.read_bytes())
    if archive.stat().st_size > max_archive:
        fail('archive exceeds upload limit')
    print('[package-source-bundle] archive ready at ' + str(archive))
except BaseException:
    if archive.is_file():
        archive.unlink()
    raise
finally:
    if staging.is_dir():
        shutil.rmtree(staging)
PY
