#!/usr/bin/env python3
"""
Best-effort PDF decryptor for the tax-return extraction path.

Reads raw (possibly encrypted) PDF bytes from stdin and writes a DECRYPTED PDF
to stdout. This only handles PDFs that can be opened WITHOUT a real user
password — i.e. the common "owner-restricted" case where the user password is
empty but the file still carries an /Encrypt dictionary (which Gemini rejects
with "The document has no pages"). PDFs that require a real user password cannot
be decrypted here; the script exits non-zero and writes nothing, and the caller
surfaces a clear "password-protected" message to the user.

Contract (kept deliberately simple — NOT the JSON contract used by the other
Python scripts, because the output here is binary):
  stdin  -> raw PDF bytes
  stdout -> decrypted PDF bytes (only on success)
  stderr -> human-readable status/diagnostics (never parsed)
  exit 0 -> decrypted bytes written to stdout
  exit 3 -> encrypted but needs a real password (cannot decrypt)
  exit 4 -> no decryption backend available / unexpected error
"""

import sys


def _read_stdin_bytes() -> bytes:
    buf = getattr(sys.stdin, "buffer", None)
    return buf.read() if buf is not None else sys.stdin.read().encode("latin1")


def _write_stdout_bytes(data: bytes) -> None:
    out = getattr(sys.stdout, "buffer", None)
    if out is not None:
        out.write(data)
        out.flush()
    else:  # pragma: no cover
        sys.stdout.write(data.decode("latin1"))


def _try_fitz(data: bytes):
    """PyMuPDF (already in requirements.txt).
    Returns decrypted bytes on success, None if available-but-couldn't-decrypt,
    or False if the backend is not installed."""
    try:
        import fitz  # PyMuPDF
    except Exception as e:  # pragma: no cover - import guard
        sys.stderr.write(f"[decrypt_pdf] fitz unavailable: {e}\n")
        return False
    try:
        doc = fitz.open(stream=data, filetype="pdf")
    except Exception as e:
        sys.stderr.write(f"[decrypt_pdf] fitz open failed: {e}\n")
        return None
    try:
        if doc.needs_pass:
            # 0 == authentication failed (needs a real password).
            if not doc.authenticate(""):
                sys.stderr.write("[decrypt_pdf] fitz: empty password rejected\n")
                return None
        # Re-serialize with encryption stripped.
        out = doc.tobytes(encryption=fitz.PDF_ENCRYPT_NONE, deflate=True, garbage=3)
        return bytes(out) if out else None
    except Exception as e:
        sys.stderr.write(f"[decrypt_pdf] fitz decrypt failed: {e}\n")
        return None
    finally:
        try:
            doc.close()
        except Exception:
            pass


def _try_pikepdf(data: bytes):
    """pikepdf (qpdf) fallback.
    Returns decrypted bytes on success, None if available-but-couldn't-decrypt,
    or False if the backend is not installed."""
    try:
        import io
        import pikepdf
    except Exception as e:  # pragma: no cover - import guard
        sys.stderr.write(f"[decrypt_pdf] pikepdf unavailable: {e}\n")
        return False
    try:
        with pikepdf.open(io.BytesIO(data), password="") as pdf:
            out = io.BytesIO()
            pdf.save(out)  # saves WITHOUT encryption by default
            return out.getvalue()
    except pikepdf.PasswordError:
        sys.stderr.write("[decrypt_pdf] pikepdf: empty password rejected\n")
        return None
    except Exception as e:
        sys.stderr.write(f"[decrypt_pdf] pikepdf decrypt failed: {e}\n")
        return None


def main() -> int:
    data = _read_stdin_bytes()
    if not data:
        sys.stderr.write("[decrypt_pdf] empty input\n")
        return 4

    saw_backend = False
    for backend in (_try_fitz, _try_pikepdf):
        result = backend(data)
        if isinstance(result, (bytes, bytearray)) and len(result) > 0:
            _write_stdout_bytes(bytes(result))
            return 0
        if result is None:
            # Backend was available but could not decrypt (needs a real password
            # or a decrypt error) — as opposed to `False` = backend not installed.
            saw_backend = True

    return 3 if saw_backend else 4


if __name__ == "__main__":
    sys.exit(main())
