import type { Db } from "@datahub/db";
import { ByteaStoragePort } from "../uploads/adapters.drizzle.js";
import { DrizzleDocumentRefPort } from "../dataroom/repository.drizzle.js";
import type { QaService } from "../qa/index.js";
import type { SessionUser } from "@datahub/contracts";
import type { CimDataRoomPort, QaPort } from "./ports.js";

/**
 * Publishing a rendered deck into the deal's data room.
 *
 * Reuses the uploads module's blob store and the data room's document port
 * rather than opening a second place for CIM files to live — so a published CIM
 * inherits data room access control and versioning instead of having its own.
 */
export class DrizzleCimDataRoomPort implements CimDataRoomPort {
  readonly available = true;
  private readonly storage: ByteaStoragePort;
  private readonly documents: DrizzleDocumentRefPort;

  constructor(
    db: Db,
    /** Where published CIMs land. Resolved per company at publish time. */
    private readonly resolveFolder: (companyId: string) => Promise<string | null>,
  ) {
    this.storage = new ByteaStoragePort(db);
    this.documents = new DrizzleDocumentRefPort(db);
  }

  async publishDocument(input: {
    companyId: string;
    name: string;
    bytes: Buffer;
    contentType: string;
    uploadedBy: string;
  }) {
    const folderId = await this.resolveFolder(input.companyId);
    if (!folderId) {
      throw new Error("no destination folder for the published CIM");
    }
    const upload = await this.storage.put(input.bytes, {
      fileName: input.name,
      contentType: input.contentType,
      uploadedBy: input.uploadedBy,
    });
    const document = await this.documents.create({
      companyId: input.companyId,
      folderId,
      name: input.name,
      uploadId: upload.id,
      sizeBytes: input.bytes.length,
      ext: "pdf",
      uploadedBy: input.uploadedBy,
    });
    return { uploadId: upload.id, documentId: document.id };
  }
}

/**
 * The guided-Q&A seam, over the real Q&A service.
 *
 * Everything crossing this boundary is deliberately thin: an opaque
 * `externalRef` carrying a block id, and free text. The Q&A module gains no
 * knowledge of CIMs, and this module gains none of items, threads or assignment.
 *
 * The CIM calls the Q&A *service* rather than its HTTP surface, which is the
 * module convention here — cross-module calls go through typed interfaces so the
 * boundary survives either side being extracted later.
 */
export class QaServiceAdapter implements QaPort {
  readonly available = true;

  constructor(
    private readonly qa: QaService,
    /** The identity generated items are raised under. */
    private readonly actorFor: (companyId: string, userId: string) => SessionUser,
  ) {}

  async createItems(input: Parameters<QaPort["createItems"]>[0]) {
    const actor = this.actorFor(input.companyId, input.createdBy);
    const created: Array<{ itemId: string; externalRef: string }> = [];
    for (const item of input.items) {
      const made = await this.qa.createItem(actor, input.companyId, {
        title: item.title,
        body: item.text,
        priority: "medium",
        // Provenance the Q&A module records but never interprets.
        origin: "cim_guided",
        module_tag: "CM",
        section_tag: item.sectionKey,
        external_ref: item.externalRef,
        ...(item.assigneeUserId ? { requestee_ids: [item.assigneeUserId] } : {}),
      });
      created.push({ itemId: made.id, externalRef: item.externalRef });
    }
    return created;
  }

  async listAnswers(input: { companyId: string; externalRefs: string[] }) {
    if (input.externalRefs.length === 0) return [];
    const actor = this.actorFor(input.companyId, "");
    const items = await this.qa.listItems(actor, input.companyId, {});
    const wanted = new Set(input.externalRefs);
    const out: Awaited<ReturnType<QaPort["listAnswers"]>> = [];
    for (const item of items) {
      if (!item.external_ref || !wanted.has(item.external_ref)) continue;
      const detail = await this.qa.getItem(actor, item.id);
      for (const response of detail.responses) {
        if (response.kind !== "answer" || !response.is_current) continue;
        out.push({
          itemId: item.id,
          responseId: response.id,
          externalRef: item.external_ref,
          questionText: item.body,
          answerText: response.body,
          respondentId: response.author_id,
          respondentName: response.author_name,
          submittedAt: response.posted_at,
        });
      }
    }
    return out;
  }

  async outstandingCount(input: { companyId: string; externalRefs: string[] }) {
    if (input.externalRefs.length === 0) return 0;
    const actor = this.actorFor(input.companyId, "");
    const items = await this.qa.listItems(actor, input.companyId, {});
    const wanted = new Set(input.externalRefs);
    return items.filter(
      (i) => i.external_ref && wanted.has(i.external_ref) && i.answered_at === null,
    ).length;
  }
}
