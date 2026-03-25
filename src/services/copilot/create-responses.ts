import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export interface ResponsesPayload {
  model: string
  input: unknown
  instructions?: string
  max_output_tokens?: number | null
  temperature?: number | null
  top_p?: number | null
  stream?: boolean | null
  [key: string]: unknown
}

function isAgentInitiated(input: unknown): boolean {
  if (!Array.isArray(input)) return false
  return input.some(
    (item: unknown) =>
      (typeof item === "object"
        && item !== null
        && "role" in item
        && (item as { role?: string }).role === "assistant")
      || (item as { role?: string }).role === "tool"
      || (item as { role?: string }).role === "function_call_output",
  )
}

export const createResponses = async (payload: ResponsesPayload) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const headers: Record<string, string> = {
    ...copilotHeaders(state, false),
    "X-Initiator": isAgentInitiated(payload.input) ? "agent" : "user",
  }

  const url = `${copilotBaseUrl(state)}/responses`
  consola.debug(`Calling upstream responses API: ${url}`)

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    consola.error(
      "Failed to create responses",
      response.status,
      response.statusText,
    )
    throw new HTTPError("Failed to create responses", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return await response.json()
}
