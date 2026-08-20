import { describe, expect, it } from "vitest";
import {
  MAX_CHUNK_BYTES,
  MIN_CHUNK_BYTES,
  commentCreate,
  commentVisibility,
  uploadSessionCreate,
} from "./dataroom.js";

const FOLDER = "11111111-1111-4111-8111-111111111111";
const DOC = "22222222-2222-4222-8222-222222222222";

describe("comment visibility", () => {
  it("defaults to internal, the side that cannot be un-shared", () => {
    // Asymmetric failure: an internal note wrongly shown to a counterparty cannot
    // be taken back; a shared note wrongly kept private is one click from fixed.
    const parsed = commentCreate.parse({ body: "for our side only" });
    expect(parsed.visibility).toBe("internal");
  });

  it("accepts an explicit shared comment", () => {
    expect(commentCreate.parse({ body: "hi", visibility: "shared" }).visibility).toBe("shared");
  });

  it("rejects any visibility the query predicate would not understand", () => {
    expect(() => commentVisibility.parse("public")).toThrow();
    expect(() => commentCreate.parse({ body: "hi", visibility: "everyone" })).toThrow();
  });

  it("refuses an empty comment rather than storing whitespace", () => {
    expect(() => commentCreate.parse({ body: "   " })).toThrow();
  });
});

describe("upload session", () => {
  const base = {
    folder_id: FOLDER,
    file_name: "big.bin",
    total_bytes: 50 * 1024 * 1024,
    chunk_size: 5 * 1024 * 1024,
  };

  it("accepts a well-formed session and defaults the content type", () => {
    const parsed = uploadSessionCreate.parse(base);
    expect(parsed.content_type).toBe("application/octet-stream");
    expect(parsed.document_id).toBeUndefined();
  });

  it("carries document_id when the upload is a new version of an existing document", () => {
    // Naming the document is what turns a same-name re-upload into a version
    // without the client deciding.
    expect(uploadSessionCreate.parse({ ...base, document_id: DOC }).document_id).toBe(DOC);
  });

  it("clamps chunk size at both ends, in the schema rather than the handler", () => {
    expect(() => uploadSessionCreate.parse({ ...base, chunk_size: MIN_CHUNK_BYTES - 1 })).toThrow();
    expect(() => uploadSessionCreate.parse({ ...base, chunk_size: MAX_CHUNK_BYTES + 1 })).toThrow();
    expect(uploadSessionCreate.parse({ ...base, chunk_size: MAX_CHUNK_BYTES }).chunk_size).toBe(
      MAX_CHUNK_BYTES,
    );
  });

  it("refuses a chunk count that would mean tens of thousands of round trips", () => {
    expect(() =>
      uploadSessionCreate.parse({
        ...base,
        total_bytes: 200 * 1024 * 1024 * 1024,
        chunk_size: MIN_CHUNK_BYTES,
      }),
    ).toThrow(/chunk size/i);
  });

  it("rejects a zero-byte or negative file", () => {
    expect(() => uploadSessionCreate.parse({ ...base, total_bytes: 0 })).toThrow();
    expect(() => uploadSessionCreate.parse({ ...base, total_bytes: -1 })).toThrow();
  });

  it("requires a destination folder", () => {
    const { folder_id: _omitted, ...withoutFolder } = base;
    expect(() => uploadSessionCreate.parse(withoutFolder)).toThrow();
  });
});
