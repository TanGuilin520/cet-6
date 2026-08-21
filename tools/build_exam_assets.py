#!/usr/bin/env python3
"""Build browser-ready page images and a selectable text manifest from a PDF."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path


XHTML = {"x": "http://www.w3.org/1999/xhtml"}


def parse_bbox(path: Path) -> list[dict[str, object]]:
    root = ET.parse(path).getroot()
    pages: list[dict[str, object]] = []
    for page_number, page in enumerate(root.findall(".//x:page", XHTML), start=1):
        width = float(page.attrib["width"])
        height = float(page.attrib["height"])
        words: list[dict[str, object]] = []
        word_index = 0
        for line_index, line in enumerate(page.findall(".//x:line", XHTML)):
            for word in line.findall("x:word", XHTML):
                text = "".join(word.itertext()).strip()
                if not text:
                    continue
                x_min = float(word.attrib["xMin"])
                y_min = float(word.attrib["yMin"])
                x_max = float(word.attrib["xMax"])
                y_max = float(word.attrib["yMax"])
                words.append(
                    {
                        "id": word_index,
                        "line": line_index,
                        "text": text,
                        "x": round(x_min, 3),
                        "y": round(y_min, 3),
                        "width": round(x_max - x_min, 3),
                        "height": round(y_max - y_min, 3),
                    }
                )
                word_index += 1
        pages.append(
            {
                "number": page_number,
                "width": round(width, 3),
                "height": round(height, 3),
                "image": f"pages/page-{page_number}.jpg",
                "words": words,
            }
        )
    return pages


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--id", required=True, dest="paper_id")
    parser.add_argument("--title", required=True)
    parser.add_argument("--dpi", type=int, default=144)
    args = parser.parse_args()

    pdf = args.pdf.resolve()
    output = args.output.resolve()
    pages_dir = output / "pages"
    if not pdf.is_file():
        parser.error(f"PDF does not exist: {pdf}")
    pages_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="exam-assets-") as temp_directory:
        bbox_path = Path(temp_directory) / "text.xhtml"
        subprocess.run(
            ["pdftotext", "-bbox-layout", str(pdf), str(bbox_path)],
            check=True,
        )
        pages = parse_bbox(bbox_path)

    subprocess.run(
        [
            "pdftoppm",
            "-jpeg",
            "-r",
            str(args.dpi),
            "-jpegopt",
            "quality=84,progressive=y,optimize=y",
            str(pdf),
            str(pages_dir / "page"),
        ],
        check=True,
    )

    shutil.copy2(pdf, output / "source.pdf")
    manifest = {
        "id": args.paper_id,
        "title": args.title,
        "pageCount": len(pages),
        "source": "source.pdf",
        "pages": pages,
    }
    (output / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"Built {len(pages)} pages in {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
