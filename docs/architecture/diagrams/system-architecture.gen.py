"""Generate current, explicitly scoped architecture pages using Draw.io XML.

This source describes the unreleased integration candidate. It deliberately does
not reproduce the retired SaaS architecture; that is available at the fixed
legacy source linked in docs/architecture/README.md. No external tools required.
"""
from pathlib import Path
import xml.etree.ElementTree as ET

HERE = Path(__file__).parent
STYLE = "rounded=1;whiteSpace=wrap;html=0;fillColor=#eaf2ff;strokeColor=#405a78;fontSize=16;"
EDGE = "edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=block;html=0;strokeColor=#405a78;fontSize=13;"


def diagram(doc, identity, title, nodes, edges):
    page = ET.SubElement(doc, "diagram", id=identity, name=title)
    model = ET.SubElement(page, "mxGraphModel", dx="1200", dy="800", grid="1", gridSize="10", page="1", pageWidth="1200", pageHeight="800")
    root = ET.SubElement(model, "root")
    ET.SubElement(root, "mxCell", id="0")
    ET.SubElement(root, "mxCell", id="1", parent="0")
    for name, text, x, y, width, height in nodes:
        cell = ET.SubElement(root, "mxCell", id=name, value=text, style=STYLE, vertex="1", parent="1")
        ET.SubElement(cell, "mxGeometry", x=str(x), y=str(y), width=str(width), height=str(height), **{"as": "geometry"})
    for index, (source, target, label) in enumerate(edges):
        cell = ET.SubElement(root, "mxCell", id=f"edge-{index}", value=label, style=EDGE, edge="1", parent="1", source=source, target=target)
        ET.SubElement(cell, "mxGeometry", relative="1", **{"as": "geometry"})


def main():
    doc = ET.Element("mxfile", host="app.diagrams.net", type="device")
    diagram(doc, "community-local", "01 Local competition candidate", [
        ("title", "Unreleased candidate: one event/team competition system", 60, 30, 1080, 50),
        ("organizer", "Organizer browser\nAdmin / Operator / Viewer", 60, 150, 250, 80),
        ("participant", "Participant browser\nEvent-owned team key", 60, 350, 250, 80),
        ("host", "Single Bun process\nHTTP authorization, events, scoring, ownership", 430, 235, 330, 110),
        ("db", "Local SQLite + original private keys\nDurable state and recovery", 880, 150, 260, 100),
        ("runtime", "On-demand Compose / workbench\n512 dormant jobs; team 3 / host 12 active\n4096 MiB cap budget; 40 active gateways", 880, 360, 260, 100),
        ("lifecycle", "make down stops owned Docker; make local waits for participant resume\nWritable layers and volumes survive, not RAM; no automatic eviction or reset\nExisting events keep legacy lifecycle; AWS stacks and event clock remain", 210, 540, 780, 90),
        ("coverage", "106 entries are not full playability proof; synthetic 100 jobs / 105 ports is not a benchmark\nReal Docker/browser: SQL access, PostgreSQL terminal, isolation and state-preserving resume verified", 210, 655, 780, 80),
    ], [("organizer", "host", "Organizer authentication"), ("participant", "host", "Team authentication"), ("host", "db", "Transactional state"), ("host", "runtime", "Owned lifecycle / private verifier")])
    diagram(doc, "exercise-aws", "02 Cloud-only AWS exercises", [
        ("title", "AWS exercises are separate from cloud platform deployment", 60, 30, 1080, 50),
        ("host", "Cloud event service (restoration pending)\nScoped execution role", 60, 200, 250, 100),
        ("deploy", "Competitor deployment role\nRequired persisted host ExternalId", 430, 120, 320, 100),
        ("viewer", "Saved participant viewer role\nDeployment ExternalId", 430, 360, 320, 100),
        ("stack", "Owned CloudFormation stack\nhello-world / hello-world-battle", 870, 120, 280, 100),
        ("player", "Authorized team\nShort-lived Console / CLI access", 870, 360, 280, 100),
        ("note", "Participant credentials never use the deployment role\nNew issuance checks event/team state; existing AWS sessions can outlive event end\nLive AWS rehearsal needs separate authorization and may incur charges", 160, 550, 880, 120),
    ], [("host", "deploy", "AssumeRole"), ("deploy", "stack", "Create / observe / teardown"), ("host", "viewer", "AssumeRole"), ("viewer", "player", "Temporary access"), ("player", "stack", "Problem-specific permissions")])
    diagram(doc, "cloud-status", "03 Cloud platform: incomplete", [
        ("title", "Cloud platform integration is in progress", 60, 30, 1080, 50),
        ("commands", "make deploy / make destroy\nCurrently exit unimplemented\nNo resource changes", 80, 180, 360, 150),
        ("requirements", "Required deployment contract\nAPI Gateway / Lambda + DynamoDB\nCognito + private S3 / CloudFront\nDurable deployment and scoring coordination", 710, 150, 400, 230),
        ("gates", "Not established by a container build or a driver experiment\nInitial permissions, lifecycle, non-AWS runner, billing and full participant route still need evidence", 170, 510, 860, 120),
    ], [("commands", "requirements", "Implementation and verification required")])
    ET.indent(doc, space="  ")
    ET.ElementTree(doc).write(HERE / "system-architecture.drawio", encoding="utf-8", xml_declaration=True)


if __name__ == "__main__":
    main()
