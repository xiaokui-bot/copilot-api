import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createResponses,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"

export async function handleResponses(c: Context) {
  await checkRateLimit(state)

  const payload = await c.req.json<ResponsesPayload>()
  consola.debug("Responses API payload:", JSON.stringify(payload).slice(0, 400))

  if (state.manualApprove) await awaitApproval()

  const response = await createResponses(payload)

  if (!payload.stream) {
    return c.json(response)
  }

  return streamSSE(c, async (stream) => {
    for await (const chunk of response as AsyncIterable<{ event?: string; data?: string }>) {
      consola.debug("Responses streaming chunk:", JSON.stringify(chunk))
      await stream.writeSSE({
        event: chunk.event,
        data: chunk.data ?? "",
      })
    }
  })
}
