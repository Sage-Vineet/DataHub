import type { GatewayEnv } from "./env.js";

/**
 * The subset of the flag set the SPA needs to decide what to render.
 *
 * Only the greenfield capabilities appear. The cutover flags are invisible to the
 * client on purpose: whether `/companies` is served in-process or proxied to
 * legacy is an operational detail the SPA must not be able to observe, let alone
 * branch on — the whole point of the parity work is that both answer identically.
 * A greenfield flag is different in kind: off means the feature does not exist,
 * and the interface has to say so by omission.
 *
 * Keys are lowercase feature names rather than the env-var spelling, so the SPA
 * reads `useFeature("qa")` rather than repeating a deployment concern.
 */
export function clientFeatures(flags: GatewayEnv["flags"]): Record<string, boolean> {
  return {
    dataroom: flags.DATAROOM_MODULE_ENABLED,
    dataroomVersions: flags.DATAROOM_MODULE_ENABLED && flags.DATAROOM_VERSIONS_ENABLED,
    dataroomComments: flags.DATAROOM_MODULE_ENABLED && flags.DATAROOM_COMMENTS_ENABLED,
    dataroomChunkedUpload: flags.DATAROOM_MODULE_ENABLED && flags.DATAROOM_CHUNKED_UPLOAD_ENABLED,
    qa: flags.QA_MODULE_ENABLED,
    qaPresentation: flags.QA_MODULE_ENABLED && flags.QA_PRESENTATION_ENABLED,
    qaNominations: flags.QA_MODULE_ENABLED && flags.QA_NOMINATIONS_ENABLED,
    cim: flags.CIM_MODULE_ENABLED,
  };
}
