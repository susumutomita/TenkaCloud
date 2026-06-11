#!/usr/bin/env python3
"""Remove a flat green chroma-key background from generated PNG assets.

This intentionally avoids third-party dependencies so the pitch asset pipeline
can run in the repository environment without installing Pillow.
"""

from __future__ import annotations

import argparse
import struct
import zlib
from pathlib import Path

PNG_SIG = b"\x89PNG\r\n\x1a\n"


def read_png(path: Path) -> tuple[int, int, list[list[list[int]]]]:
    data = path.read_bytes()
    if not data.startswith(PNG_SIG):
        raise ValueError(f"{path} is not a PNG")

    pos = len(PNG_SIG)
    width = height = None
    color_type = None
    bit_depth = None
    compressed = bytearray()

    while pos < len(data):
        length = struct.unpack(">I", data[pos : pos + 4])[0]
        pos += 4
        chunk_type = data[pos : pos + 4]
        pos += 4
        chunk = data[pos : pos + length]
        pos += length + 4

        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type, compression, filter_method, interlace = struct.unpack(
                ">IIBBBBB", chunk
            )
            if bit_depth != 8 or compression != 0 or filter_method != 0 or interlace != 0:
                raise ValueError("Only non-interlaced 8-bit PNGs are supported")
            if color_type not in (2, 6):
                raise ValueError("Only RGB/RGBA PNGs are supported")
        elif chunk_type == b"IDAT":
            compressed.extend(chunk)
        elif chunk_type == b"IEND":
            break

    if width is None or height is None or color_type is None or bit_depth is None:
        raise ValueError("Missing PNG header")

    channels = 4 if color_type == 6 else 3
    stride = width * channels
    raw = zlib.decompress(bytes(compressed))
    rows: list[list[list[int]]] = []
    offset = 0
    prev = [0] * stride

    for _ in range(height):
        filter_type = raw[offset]
        offset += 1
        row = list(raw[offset : offset + stride])
        offset += stride
        recon = unfilter(row, prev, channels, filter_type)
        prev = recon
        pixels = []
        for x in range(width):
            base = x * channels
            if channels == 4:
                pixels.append(recon[base : base + 4])
            else:
                pixels.append(recon[base : base + 3] + [255])
        rows.append(pixels)

    return width, height, rows


def unfilter(row: list[int], prev: list[int], bpp: int, filter_type: int) -> list[int]:
    out = row[:]
    if filter_type == 0:
        return out
    if filter_type == 1:
        for i in range(len(out)):
            out[i] = (out[i] + (out[i - bpp] if i >= bpp else 0)) & 255
    elif filter_type == 2:
        for i in range(len(out)):
            out[i] = (out[i] + prev[i]) & 255
    elif filter_type == 3:
        for i in range(len(out)):
            left = out[i - bpp] if i >= bpp else 0
            up = prev[i]
            out[i] = (out[i] + ((left + up) // 2)) & 255
    elif filter_type == 4:
        for i in range(len(out)):
            left = out[i - bpp] if i >= bpp else 0
            up = prev[i]
            upper_left = prev[i - bpp] if i >= bpp else 0
            out[i] = (out[i] + paeth(left, up, upper_left)) & 255
    else:
        raise ValueError(f"Unsupported PNG filter {filter_type}")
    return out


def paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def write_png(path: Path, width: int, height: int, rows: list[list[list[int]]]) -> None:
    raw = bytearray()
    for row in rows:
        raw.append(0)
        for r, g, b, a in row:
            raw.extend([r, g, b, a])

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )

    payload = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = PNG_SIG + chunk(b"IHDR", payload) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    path.write_bytes(png)


def keyed_alpha(
    pixel: list[int],
    key: tuple[int, int, int],
    threshold: int,
    feather: int,
    dominance_threshold: int,
    dominance_feather: int,
) -> int:
    r, g, b, _ = pixel
    dist = ((r - key[0]) ** 2 + (g - key[1]) ** 2 + (b - key[2]) ** 2) ** 0.5
    if dist <= threshold:
        dist_alpha = 0
    elif dist >= threshold + feather:
        dist_alpha = 255
    else:
        dist_alpha = round(255 * (dist - threshold) / max(feather, 1))

    if key == (0, 255, 0):
        dominance = g - max(r, b)
        if dominance >= dominance_threshold + dominance_feather:
            dominance_alpha = 0
        elif dominance <= dominance_threshold:
            dominance_alpha = 255
        else:
            dominance_alpha = round(
                255
                * (dominance_threshold + dominance_feather - dominance)
                / max(dominance_feather, 1)
            )
        return min(dist_alpha, dominance_alpha)

    return dist_alpha


def remove_bg(
    rows: list[list[list[int]]],
    key: tuple[int, int, int],
    threshold: int,
    feather: int,
    dominance_threshold: int,
    dominance_feather: int,
) -> None:
    for row in rows:
        for pixel in row:
            alpha = keyed_alpha(pixel, key, threshold, feather, dominance_threshold, dominance_feather)
            pixel[3] = min(pixel[3], alpha)
            if key == (0, 255, 0) and pixel[1] > max(pixel[0], pixel[2]):
                # Simple despill against green key, including opaque antialiased edges.
                pixel[1] = min(pixel[1], max(pixel[0], pixel[2]))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--key", default="#00ff00")
    parser.add_argument("--threshold", type=int, default=34)
    parser.add_argument("--feather", type=int, default=42)
    parser.add_argument("--dominance-threshold", type=int, default=42)
    parser.add_argument("--dominance-feather", type=int, default=54)
    args = parser.parse_args()

    key = args.key.lstrip("#")
    if len(key) != 6:
        raise ValueError("--key must be in #rrggbb format")
    key_rgb = tuple(int(key[i : i + 2], 16) for i in (0, 2, 4))
    width, height, rows = read_png(args.input)
    remove_bg(rows, key_rgb, args.threshold, args.feather, args.dominance_threshold, args.dominance_feather)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    write_png(args.out, width, height, rows)


if __name__ == "__main__":
    main()
