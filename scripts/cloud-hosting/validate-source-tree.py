"""Reject symlinks in selected archive inputs without ever reading their targets."""
import fnmatch
import os
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
patterns = [] if "--all" in sys.argv[2:] else [
    "node_modules", "cdk.out*", "dist", "coverage", ".cache", ".git", ".env*", ".DS_Store"
]


def ignored(name):
    return any(fnmatch.fnmatch(name, pattern) for pattern in patterns)


def fail(error):
    raise error


if root.is_symlink():
    raise SystemExit(f"Source symlinks are not supported: {root}")
for directory, directories, files in os.walk(root, followlinks=False, onerror=fail):
    directories[:] = [name for name in directories if not ignored(name)]
    for name in directories + [name for name in files if not ignored(name)]:
        path = pathlib.Path(directory, name)
        if path.is_symlink():
            raise SystemExit(f"Source symlinks are not supported: {path}")
