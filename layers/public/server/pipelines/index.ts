import type { PipelineDef } from '@michaelthielemann/kestrel-core'
import {
  buildPublishPipelines,
  buildPublishRunsPipelines,
  buildLinkPipelines,
  buildPreviewPipelines,
  buildRoutePipelines,
} from '@michaelthielemann/kestrel-publishing'
import { buildDeliveryLivePipelines } from '@michaelthielemann/kestrel-delivery-live'

/** The public layer's own API surface: the render entry, the preview ticket pair, the publish action and
 *  its status read, the orchestrator's admin progress read, the editor's link resolver, and the
 *  delivery-live read API. All collection-less, so each lives at `/api/<name>`. */
export function buildPublicPipelines(): PipelineDef[] {
  return [
    ...buildRoutePipelines(),
    ...buildPreviewPipelines(),
    ...buildPublishPipelines(),
    ...buildPublishRunsPipelines(),
    ...buildLinkPipelines(),
    ...buildDeliveryLivePipelines(),
  ]
}
