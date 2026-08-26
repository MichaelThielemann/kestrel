import type { PipelineDef } from '@michaelthielemann/kestrel-core'
import { buildMediaAssetPipelines } from './media-assets.js'
import { buildMediaOpPipelines } from './media-ops.js'
import { buildMediaReadPipelines } from './media-reads.js'
import { buildMediaUploadPipeline } from './media-upload.js'

/** The whole `/api/media/**` surface beyond the generic CRUD ops the engine already composes for every
 *  collection (`readMany`, `readOne`, …).
 * @public
 */
export function buildMediaPipelines(): PipelineDef[] {
  return [
    ...buildMediaReadPipelines(),
    buildMediaUploadPipeline(),
    ...buildMediaAssetPipelines(),
    ...buildMediaOpPipelines(),
  ]
}
