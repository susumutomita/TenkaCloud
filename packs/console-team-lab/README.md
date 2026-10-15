# Team console lab

Explicitly select this catalog at `packs/console-team-lab` using a full reviewed Git commit and the existing catalog acquisition command. It is never added to the default catalog automatically.

Each team gets sibling attack, Web, private SQLite and verifier containers. Terminal attaches only to the participant build target. curl, nmap (TCP connect mode), netcat, Python and sqlmap are installed in the tool image, with no added capabilities. Internet is not needed at runtime. Build preparation downloads trusted packages; it is separate from workload egress.

The base digest and dated signed Debian snapshot pin the build inputs. Record the built OCI digest and `/usr/local/share/tenkacloud-tool-versions.txt` before deployment. ARM64/Kali execution and packet isolation require an actual compatible native runner; this reference does not claim that validation.
