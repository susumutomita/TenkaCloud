#!/usr/bin/env python3
"""Export the historical JAWS Yokohama 2026 diagrams from their preserved Draw.io copy.

The slide zooms into page 01 by changing the viewBox of an <svg> that shows
architecture-saas.svg, and swaps in a focused SVG that draws only one area.
Both rely on the SVG coordinates being the draw.io model coordinates, so every
export gets a transparent 1x1 cell at (0, 0) and is written with no border.

Writes landing/jaws-yokohama-2026/assets/{system-architecture.drawio,
architecture-saas.svg, architecture-<view>.svg} and prints the viewBox of each
view for the data-view-box buttons in landing/jaws-yokohama-2026/index.html.

Requires the draw.io desktop CLI (`drawio`) on PATH.
"""

import copy
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
ASSETS = REPO / "landing/jaws-yokohama-2026/assets"
# This talk describes the pinned legacy architecture, not the current cloud/local host.
SOURCE = ASSETS / "system-architecture.drawio"
PAGE = "saas-physical"
TITLE = "TenkaCloud SaaSモード AWS物理構成図"
MARGIN = 20

# Each focused view draws these cells, everything inside them and the frames around
# them, plus the edges whose two ends are both drawn. Its viewBox is their union.
VIEWS = {
    "control-plane": [
        "stack-runtime-config",
        "stack-admin-hosting",
        "stack-control-plane",
        "stack-insight",
        "stack-bootstrap",
        "stack-observability",
    ],
    "application": ["stack-tenant-template", "stack-pipeline", "s3-source"],
    "problem-runtime": ["stack-problem-deploy", "stack-challenge-payload", "external"],
}


def page_model(path):
    root = ET.parse(path).getroot()
    for diagram in root.findall("diagram"):
        if diagram.get("id") == PAGE:
            return diagram.find("mxGraphModel")
    sys.exit(f"page {PAGE} not found in {path}")


def absolute_boxes(model):
    cells = {cell.get("id"): cell for cell in model.iter("mxCell")}
    boxes = {}

    def box(cell_id):
        if cell_id in boxes:
            return boxes[cell_id]
        cell = cells[cell_id]
        geometry = cell.find("mxGeometry")
        parent = cell.get("parent")
        ox, oy = (0.0, 0.0) if parent in ("0", "1") else box(parent)[:2]
        x = ox + float(geometry.get("x", 0))
        y = oy + float(geometry.get("y", 0))
        boxes[cell_id] = (x, y, float(geometry.get("width")), float(geometry.get("height")))
        return boxes[cell_id]

    for cell_id, cell in cells.items():
        if cell.get("vertex") == "1":
            box(cell_id)
    return cells, boxes


def extent(cell, box):
    """The box of a cell, widened to the label drawn under an icon."""
    x, y, w, h = box
    if "verticalLabelPosition=bottom" not in (cell.get("style") or ""):
        return x, y, x + w, y + h
    lines = (cell.get("value") or "").split("\n")
    text = max(sum(12 if ord(c) > 0x2000 else 7 for c in line) for line in lines)
    half = max(w, text) / 2
    return x + w / 2 - half, y, x + w / 2 + half, y + h + 4 + 15 * len(lines)


def union(cells, boxes, ids):
    extents = [extent(cells[i], boxes[i]) for i in ids]
    left = min(e[0] for e in extents) - MARGIN
    top = min(e[1] for e in extents) - MARGIN
    right = max(e[2] for e in extents) + MARGIN
    bottom = max(e[3] for e in extents) + MARGIN
    return left, top, right - left, bottom - top


def ancestors(cells, cell_id):
    parent = cells[cell_id].get("parent")
    while parent not in (None, "0", "1"):
        yield parent
        parent = cells[parent].get("parent")


def members(cells, boxes, roots):
    return {cell_id for cell_id in boxes if cell_id in roots or set(ancestors(cells, cell_id)) & set(roots)}


def focused(model, roots):
    cells, boxes = absolute_boxes(model)
    keep = members(cells, boxes, roots)
    keep |= {a for cell_id in list(keep) for a in ancestors(cells, cell_id)}
    keep |= {
        cell_id
        for cell_id, cell in cells.items()
        if cell.get("edge") == "1" and cell.get("source") in keep and cell.get("target") in keep
    }
    model = copy.deepcopy(model)
    root = model.find("root")
    for cell in list(root):
        if cell.get("id") not in keep | {"0", "1"}:
            root.remove(cell)
    return model


def anchored(model):
    model = copy.deepcopy(model)
    anchor = ET.SubElement(
        model.find("root"),
        "mxCell",
        {"id": "jaws-origin", "value": "", "style": "strokeColor=none;fillColor=none;", "vertex": "1", "parent": "1"},
    )
    ET.SubElement(anchor, "mxGeometry", {"x": "0", "y": "0", "width": "1", "height": "1", "as": "geometry"})
    return model


def export_svg(model, out):
    mxfile = ET.Element("mxfile", {"host": "drawio"})
    ET.SubElement(mxfile, "diagram", {"id": PAGE, "name": PAGE}).append(model)
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "page.drawio"
        ET.ElementTree(mxfile).write(src, encoding="utf-8")
        subprocess.run(
            ["drawio", "-x", "-f", "svg", "-b", "0", "--theme", "light", "-o", str(out), str(src)],
            check=True,
            capture_output=True,
        )
    svg = out.read_text(encoding="utf-8")
    size = re.search(r'width="([\d.]+)px" height="([\d.]+)px"', svg)
    return svg, float(size.group(1)), float(size.group(2))


SWITCH = re.compile(r"(<switch><foreignObject .*?</foreignObject>)<image ([^>]*)/></switch>", re.S)


def text_fallback(match):
    """Replace the CLI's PNG rendering of a label with plain SVG text.

    The draw.io CLI falls back to a base64 PNG of every label for renderers that
    cannot draw foreignObject, which made the page-01 export 3.3 MB.
    """
    label, image = match.groups()
    box = {k: float(v) for k, v in re.findall(r'\b(x|y|width|height)="([\d.]+)"', image)}
    end = label.index("</div>")
    start = label.index(">", label.rindex("<div", 0, end)) + 1
    lines = [re.sub(r"<[^>]+>", "", line) for line in re.split(r"<br\s*/?>", label[start:end])]
    if not any(lines):
        sys.exit(f"empty label fallback at {box}")
    size = float(re.findall(r"font-size: ([\d.]+)px", label)[-1])
    align = re.search(r"text-align: (\w+); color", label).group(1)
    color = re.search(r"text-align: \w+; color: (#[0-9A-Fa-f]{3,6})", label).group(1)
    weight = ' font-weight="bold"' if "font-weight: bold" in label else ""
    anchor, x = {
        "left": ("start", box["x"]),
        "right": ("end", box["x"] + box["width"]),
    }.get(align, ("middle", box["x"] + box["width"] / 2))
    spans = "".join(
        f'<tspan x="{x:g}" dy="{size if i == 0 else size * 1.2:g}">{line}</tspan>' for i, line in enumerate(lines)
    )
    text = (
        f'<text y="{box["y"]:g}" fill="{color}" font-family="Helvetica" font-size="{size:g}px"'
        f' text-anchor="{anchor}"{weight}>{spans}</text>'
    )
    return f"{label}{text}</switch>"


def finish(svg, width, height, metadata):
    body = svg[svg.index("<svg") :]
    body = body[body.index(">") + 1 :]
    body = SWITCH.sub(text_fallback, body)
    if "data:image/png" in body:
        sys.exit("a PNG label fallback was left in the SVG")
    head = (
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'version="1.1" width="{width:g}" height="{height:g}" viewBox="0 0 {width:g} {height:g}" '
        'role="img" aria-labelledby="diagram-title" style="color-scheme:light;background:white">'
        f'<title id="diagram-title">{TITLE}</title><metadata>{metadata}</metadata>'
    )
    return head + body


def main():
    if shutil.which("drawio") is None:
        sys.exit("drawio CLI not found on PATH")
    commit = subprocess.run(
        ["git", "-C", str(REPO), "log", "-1", "--format=%h", "--", str(SOURCE)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    source = f"Source: landing/jaws-yokohama-2026/assets/system-architecture.drawio / {PAGE} at {commit}."
    note = "Draw.io CLI SVG export with no border; SVG coordinates equal the model coordinates."

    model = page_model(SOURCE)
    out = ASSETS / "architecture-saas.svg"
    svg, width, height = export_svg(anchored(model), out)
    width, height = width + MARGIN, height + MARGIN
    out.write_text(finish(svg, width, height, f"{source} {note}"), encoding="utf-8")
    print(f"full: 0 0 {width:g} {height:g}")

    cells, boxes = absolute_boxes(model)
    for name, frames in VIEWS.items():
        area = union(cells, boxes, members(cells, boxes, frames))
        out = ASSETS / f"architecture-{name}.svg"
        svg, _, _ = export_svg(anchored(focused(model, frames)), out)
        focus = (
            f"Focused view: {name}. Only cells inside this area and edges connecting them are shown. "
            "External connections remain in the full view."
        )
        out.write_text(finish(svg, width, height, f"{source} {note} {focus}"), encoding="utf-8")
        print(f"{name}: {' '.join(f'{v:g}' for v in area)}")


if __name__ == "__main__":
    main()
