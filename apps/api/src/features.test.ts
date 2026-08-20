import { describe, expect, it } from "vitest";
import { MODULE_FLAGS, type ModuleFlag } from "./env.js";
import { clientFeatures } from "./features.js";

/** Every flag off, as a starting point for "turn on exactly one". */
const ALL_OFF = Object.fromEntries(MODULE_FLAGS.map((f) => [f, false])) as Record<
  ModuleFlag,
  boolean
>;

const flags = (overrides: Partial<Record<ModuleFlag, boolean>>) => ({ ...ALL_OFF, ...overrides });

describe("clientFeatures", () => {
  it("reports nothing enabled when every flag is off", () => {
    expect(Object.values(clientFeatures(flags({})))).toEqual(
      Object.values(clientFeatures(flags({}))).map(() => false),
    );
  });

  it("exposes only the greenfield capabilities, never the cutover flags", () => {
    // Whether /companies is served in-process or proxied to legacy is an
    // operational detail the SPA must not be able to observe, let alone branch
    // on — parity means both answer identically. A greenfield flag is different
    // in kind: off means the feature does not exist.
    const keys = Object.keys(clientFeatures(flags({ COMPANIES_MODULE_ENABLED: true })));

    expect(keys).toEqual([
      "dataroom",
      "dataroomVersions",
      "dataroomComments",
      "dataroomChunkedUpload",
      "qa",
      "qaPresentation",
      "qaNominations",
      "cim",
      "qoe",
    ]);
  });

  it("does not leak a cutover flag's value into any feature", () => {
    const everyCutoverOn = clientFeatures(
      flags({
        BETTER_AUTH_ENABLED: true,
        AUTH_MODULE_ENABLED: true,
        COMPANIES_MODULE_ENABLED: true,
        USERS_MODULE_ENABLED: true,
        FOLDERS_MODULE_ENABLED: true,
        UPLOADS_MODULE_ENABLED: true,
        REQUESTS_MODULE_ENABLED: true,
        MESSAGES_MODULE_ENABLED: true,
        REPORTS_MODULE_ENABLED: true,
        ACTIVITY_LOG_ENABLED: true,
      }),
    );

    expect(Object.values(everyCutoverOn).every((v) => v === false)).toBe(true);
  });

  it("declares QoE, because legacy defines nothing at its prefix", () => {
    // QoE was classified with the cutover flags, which is only safe when both
    // paths answer identically. They do not: legacy serves /ebitda-adjustments
    // and nothing at /qoe, so with the module off the SPA's requests fall
    // through the catch-all proxy to a backend that has no such route. The
    // client has to be told, or it renders a bridge it cannot populate.
    expect(clientFeatures(flags({ QOE_MODULE_ENABLED: true })).qoe).toBe(true);
    expect(clientFeatures(flags({})).qoe).toBe(false);
  });

  it("reports a sub-feature only when its module is also on", () => {
    // A sub-flag left true while its module is switched off would otherwise
    // render a panel inside a feature that no longer exists.
    const orphaned = clientFeatures(
      flags({ DATAROOM_VERSIONS_ENABLED: true, QA_PRESENTATION_ENABLED: true }),
    );

    expect(orphaned.dataroomVersions).toBe(false);
    expect(orphaned.qaPresentation).toBe(false);
  });

  it("reports a sub-feature when both it and its module are on", () => {
    const on = clientFeatures(
      flags({ DATAROOM_MODULE_ENABLED: true, DATAROOM_VERSIONS_ENABLED: true }),
    );

    expect(on).toMatchObject({ dataroom: true, dataroomVersions: true });
  });

  it("lets a module ship with one of its sub-features switched off", () => {
    // This is the commitment the demo rests on: kill one unfinished thing at
    // T-48h without losing the module around it.
    const partial = clientFeatures(
      flags({
        DATAROOM_MODULE_ENABLED: true,
        DATAROOM_VERSIONS_ENABLED: true,
        DATAROOM_CHUNKED_UPLOAD_ENABLED: false,
      }),
    );

    expect(partial).toMatchObject({
      dataroom: true,
      dataroomVersions: true,
      dataroomChunkedUpload: false,
    });
  });
});
