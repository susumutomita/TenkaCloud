# Downloaded problem catalogs

The platform no longer tracks `problems/` as a Git submodule. Organizers explicitly
select repositories in a source file, then acquire and validate their contents:

```json
{
  "schemaVersion": 1,
  "sources": [
    { "url": "https://github.com/example/pack-a.git", "ref": "v1.0.0" },
    { "url": "https://github.com/example/pack-b.git", "ref": "main", "subdir": "catalog" }
  ]
}
```

```sh
make install_ci
make catalog-download CATALOG_SOURCES=my-catalogs.json
make catalog-prepare
make validate-problems
make local
```

`catalog-sources.json` retains the complete existing TenkaCloudChallenge catalog at
its previous immutable revision. It is an explicit default selection, not a core
catalog added to other selections. A custom file selects only its listed packs.
The InterviewCatalog used by Passport remains a separate contract.

A fresh checkout has no downloaded selection yet. `make local` requires explicit
acquisition; it does not download sources or create an empty `selected.json`.
Review `catalog-sources.json`, then run `make catalog-download` to acquire that
selection, or pass `CATALOG_SOURCES=my-catalogs.json` for your own reviewed file.
Run `make local` again to prepare the catalog and build the matching interfaces.
`--no-build` additionally requires an existing matching host build. Preserve any
old submodule checkout or manually maintained `problems/` before catalog preparation.

`bun run build:pages` explicitly acquires `CATALOG_SOURCES` (defaulting to the
committed `catalog-sources.json`) and prepares it before building the website demos.
This also works in a clean Pages checkout without submodules or a preexisting
snapshot store. A failed acquisition stops the build; it does not select another catalog.

Acquisition resolves branches or tags once, downloads the resulting full commit
with the existing HTTPS Git transport, validates metadata and bilingual README
files, and records each repository, ref, resolved commit, subdirectory and content
digest in `.tenkacloud/catalog-store/selected.json`. Ambiguous refs, conflicting
problem IDs, invalid metadata and altered snapshots fail visibly. A failed
acquisition preserves the previous selection. Revisions downloaded before a later
failure may remain as unselected snapshots; they are not runtime catalog entries.

Acquisition never installs pack dependencies, executes pack scripts, loads plugins,
starts containers or deploys resources. Standard packs use `tenkacloud-pack.json`;
existing catalog repositories may expose `challenges/` and `battles/` at their
root. The platform owns the acquisition schema. Runtime support remains the
existing Docker verifier contracts and reviewed native/AWS adapters; downloading
a valid metadata entry does not add an unsupported runtime adapter.

Immutable sources are stored by their full-file digest under
`.tenkacloud/catalog-store/snapshots/`. Hidden runtime files are included and links
are refused. `problems/` is an ignored generated build view. Keep the snapshot
store, retained browser builds and the host data directory; do not edit snapshots
or remove old revisions while their events remain needed. The store currently
lives beside the platform checkout, so preserve its path for saved Docker jobs.

New events save their public catalog projection and runtime definitions. Docker
jobs retain their snapshot directory and digest, including shared pack files;
native jobs retain their server bundle and version-specific browser slot paths.
Browser builds include explicitly allowlisted native modules from retained
snapshots, while catalog listings use only the selected revisions. Thus selecting
B does not replace the definitions, scores or native UI edition of an event made
with A. Stop/restart retains SQLite state and does not select a new remote ref.

To update, stop the host, edit the source file, run `catalog-download`, then rebuild
and restart with `make local`. Use `--no-build` only when the built selection
matches the selected lock. Retained events are not upgraded. Legacy events made
before this change lack a saved public catalog projection; preserve their original
interfaces and original source checkout rather than assigning a new edition to
them. Preserve any old submodule checkout and local edits outside the generated
view before preparing catalogs; the preparation command refuses to overwrite it.

Cloud source preparation consumes the same explicit selection and includes its
immutable store in the private source archive. Existing event source/catalog pins
and source ZIP version retention remain in effect. This work does not deploy or
certify live AWS/Turso operation. The unpublished host candidate records a catalog
lock containing all repository commits and digests, replacing its single gitlink
commit. Historical published release manifests are preserved.

The selected catalogs supply the problem content; the platform does not exclude
problems by their IDs or teaching-topic tags. Runtime support and reviewed native
code boundaries still apply. Saved event definitions and native UI modules remain
available for scoring and recovery. Public source files are
normalized to readable build inputs (0644, or 0755 for executable files); no file
is executed by acquisition. Private host state and credentials keep their existing
permissions.

Cloud synthesis preserves each source repository layout, including shared build
inputs, and uses commit/digest-specific artifact prefixes. Accepted older editions
remain addressable; updating the selection does not overwrite historical core
artifact keys. Participant views project metadata from the saved execution catalog,
which separately retains bilingual task instructions. The authenticated backend
releases that fixed text only after the event starts and the problem is unlocked;
the public catalog remains free of instructions and author-only answers.
Ordinary Cloud portal builds also include retained native UI editions. A legacy
catalog without a saved public projection supplies an empty public catalog and retains its
history; it does not borrow the current selection.

Acquisition seals executable intent in a platform-owned file within the digested
snapshot. Each read restores those declared source permissions, so a filesystem
restore cannot change script behavior or make non-root problem containers unable
to read their inputs. Changes to executable intent create a distinct snapshot.
