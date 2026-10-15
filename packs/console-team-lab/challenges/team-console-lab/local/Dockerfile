# Debian multi-platform base already pinned by the platform's catalog fixtures.
FROM debian:bookworm-slim@sha256:60eac759739651111db372c07be67863818726f754804b8707c90979bda511df AS tools
# Signed, dated package archives keep the tool dependency graph fixed for review.
RUN rm -f /etc/apt/sources.list.d/* && printf '%s\n' 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260801T000000Z bookworm main' > /etc/apt/sources.list \
 && apt-get -o Acquire::Check-Valid-Until=false -o APT::Update::Error-Mode=any update \
 && apt-get install -y --no-install-recommends ca-certificates curl nmap netcat-openbsd python3 sqlmap \
 && dpkg-query -W > /usr/local/share/tenkacloud-tool-versions.txt \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --create-home player
FROM tools AS participant
ENV HOME=/tmp
USER 10001
WORKDIR /tmp
CMD ["sleep", "infinity"]
FROM tools AS web
COPY service.py /opt/service.py
USER 10001
CMD ["python3", "/opt/service.py", "web"]
FROM tools AS db
COPY service.py /opt/service.py
USER 10001
CMD ["python3", "/opt/service.py", "db"]
FROM tools AS verifier
COPY service.py /opt/service.py
USER 10001
CMD ["python3", "/opt/service.py", "verifier"]
