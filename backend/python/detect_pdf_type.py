#!/usr/bin/env python3
"""
Detect whether a PDF has a readable text layer or is image-only (scanned).

Protocol:
  stdin  : raw PDF bytes
  stdout : JSON { pdf_type: "text"|"scanned"|"mixed", pages: N, text_pages: N, text_chars: N, image_pages: N }
  exit 0 : success (even for scanned - that is not an error)
  exit 1 : cannot open PDF at all
"""

import sys
import json
import io

TEXT_CHAR_THRESHOLD = 100
MIN_CHARS_PER_PAGE = 50


def _emit(result):
    print(json.dumps(result), flush=True)


def _detect_with_pdfplumber(raw):
    try:
        import pdfplumber
    except ImportError:
        return None

    try:
        text_chars = 0
        text_pages = 0
        image_pages = 0
        total_pages = 0

        with pdfplumber.open(io.BytesIO(raw)) as pdf:
            total_pages = len(pdf.pages)
            for page in pdf.pages:
                text = page.extract_text() or ""
                text_chars += len(text)
                if len(text.strip()) >= MIN_CHARS_PER_PAGE:
                    text_pages += 1
                if len(getattr(page, "images", []) or []):
                    image_pages += 1

        pdf_type = "mixed" if text_chars > TEXT_CHAR_THRESHOLD and image_pages > 0 else ("text" if text_chars > TEXT_CHAR_THRESHOLD else "scanned")
        print(
            f"[detect_pdf_type] pages={total_pages} text_pages={text_pages} text_chars={text_chars} image_pages={image_pages} pdf_type={pdf_type}",
            file=sys.stderr,
            flush=True,
        )
        return {
            "pdf_type": pdf_type,
            "pages": total_pages,
            "text_pages": text_pages,
            "text_chars": text_chars,
            "image_pages": image_pages,
        }
    except Exception as exc:
        return {
            "error": str(exc),
        }


def _detect_with_pymupdf(raw):
    try:
        import fitz
    except ImportError:
        return {
            "pdf_type": "text",
            "pages": 0,
            "text_pages": 0,
            "text_chars": 0,
            "image_pages": 0,
            "warning": "PyMuPDF not installed - assuming text-layer PDF",
        }

    try:
        doc = fitz.open(stream=raw, filetype="pdf")
    except Exception as exc:
        return {
            "error": str(exc),
            "pdf_type": "scanned",
            "pages": 0,
            "text_pages": 0,
            "text_chars": 0,
            "image_pages": 0,
        }

    total_pages = len(doc)
    text_pages = 0
    text_chars = 0
    image_pages = 0

    for page in doc:
        text = page.get_text() or ""
        text_chars += len(text)
        if len(text.strip()) >= MIN_CHARS_PER_PAGE:
            text_pages += 1
        try:
            if page.get_images():
                image_pages += 1
        except Exception:
            pass

    doc.close()

    pdf_type = "mixed" if text_chars > TEXT_CHAR_THRESHOLD and image_pages > 0 else ("text" if text_chars > TEXT_CHAR_THRESHOLD else "scanned")
    print(
        f"[detect_pdf_type] pages={total_pages} text_pages={text_pages} text_chars={text_chars} image_pages={image_pages} pdf_type={pdf_type}",
        file=sys.stderr,
        flush=True,
    )
    return {
        "pdf_type": pdf_type,
        "pages": total_pages,
        "text_pages": text_pages,
        "text_chars": text_chars,
        "image_pages": image_pages,
    }


def main():
    raw = sys.stdin.buffer.read()
    if not raw:
        _emit({"error": "No PDF data on stdin", "pdf_type": "scanned", "pages": 0, "text_pages": 0, "text_chars": 0, "image_pages": 0})
        sys.exit(1)

    result = _detect_with_pdfplumber(raw)
    if result is None or result.get("error"):
        fallback = _detect_with_pymupdf(raw)
        if fallback is None:
            _emit({"error": "Unable to detect PDF type", "pdf_type": "scanned", "pages": 0, "text_pages": 0, "text_chars": 0, "image_pages": 0})
            sys.exit(1)
        if fallback.get("error"):
            _emit(fallback)
            sys.exit(1)
        result = fallback

    _emit(result)


if __name__ == "__main__":
    main()
