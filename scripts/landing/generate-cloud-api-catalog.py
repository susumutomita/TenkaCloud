"""Generate static, compressed AWS API request templates. Reads public models only."""
import argparse
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path
import urllib.request
import zipfile

VERSION = "1.43.118"
URL = "https://files.pythonhosted.org/packages/9c/ce/61b39a8e7a69af5ea43c1c3e1b0065a4866b42ccddf107e16686a3143614/botocore-1.43.118-py3-none-any.whl"
SHA256 = "a45d7ae570674161e4a3542d8c68633bf7503f92d1de781ef7361b79488eda6f"
ROOT = Path(__file__).resolve().parents[2]

def generate(data):
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise ValueError("Pinned wheel SHA-256 mismatch")
    wheel = zipfile.ZipFile(io.BytesIO(data))
    latest = {}
    older = []
    for name in wheel.namelist():
        if not name.endswith("/service-2.json.gz"):
            continue
        _, _, service, date, _ = name.split("/")
        if service not in latest or date > latest[service][0]:
            if service in latest:
                older.append(latest[service][1])
            latest[service] = (date, name)
        else:
            older.append(name)
    services = []
    excluded = []
    for service, (date, path) in sorted(latest.items()):
        model = json.loads(gzip.decompress(wheel.read(path)))
        meta = model["metadata"]
        operations = []
        for name, operation in sorted(model["operations"].items()):
            http = operation.get("http")
            if not http or not http.get("method") or not http.get("requestUri"):
                excluded.append({"service": service, "operation": name, "reason": "missing HTTP template"})
                continue
            operations.append([name, http["method"], http["requestUri"]])
        services.append({"id": service, "name": meta.get("serviceId", service), "protocol": meta["protocol"], "version": date,
                         "prefix": meta.get("endpointPrefix"), "target": meta.get("targetPrefix"), "operations": operations})
    plain = json.dumps(services, separators=(",", ":"), ensure_ascii=True).encode()
    packed = gzip.compress(plain, mtime=0)
    output = ROOT / "landing/cloud-master"
    (output / "api-catalog.js").write_text('''// Generated from pinned AWS-maintained botocore models; see api-catalog-manifest.json.
const packed = "''' + base64.b64encode(packed).decode() + '''";
export async function loadCatalog() {
  const bytes = Uint8Array.from(atob(packed), (character) => character.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}
''')
    manifest = {"source": "https://github.com/boto/botocore", "package": "botocore", "version": VERSION,
                "wheelUrl": URL, "wheelSha256": SHA256, "plainSha256": hashlib.sha256(plain).hexdigest(),
                "serviceModels": len(services), "operations": sum(len(s["operations"]) for s in services),
                "excludedOperations": excluded, "excludedOlderApiVersions": sorted(older),
                "services": [{"id": s["id"], "name": s["name"], "apiVersion": s["version"], "operations": len(s["operations"])} for s in services],
                "scope": "Latest API version per SDK service model in this pinned package; not all AWS marketing services or GuardDuty coverage.",
                "requestFormat": "HTTP method/path and protocol metadata are model templates. Authentication and required arguments are omitted. No request is sent."}
    (output / "api-catalog-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    license_name = next(n for n in wheel.namelist() if n.endswith("/LICENSE.txt"))
    (output / "api-catalog-LICENSE.txt").write_bytes(wheel.read(license_name))
    notice_name = next(n for n in wheel.namelist() if n.endswith(".dist-info/NOTICE"))
    (output / "api-catalog-NOTICE.txt").write_bytes(wheel.read(notice_name))
    print(json.dumps({"serviceModels": len(services), "operations": manifest["operations"], "excluded": len(excluded), "olderVersions": len(older), "gzipBytes": len(packed)}))

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--wheel", type=Path)
    args = parser.parse_args()
    generate(args.wheel.read_bytes() if args.wheel else urllib.request.urlopen(URL).read())
