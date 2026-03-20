import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { HTTPError } from "~/lib/error"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 30000

// 不可重试的错误码
const NON_RETRYABLE_CODES = new Set([
  "model_max_prompt_tokens_exceeded",
  "content_filter",
  "invalid_request",
])

function isRetryable(error: unknown): boolean {
  if (error instanceof HTTPError) {
    const status = error.response.status
    if (status === 429) return true
    if (status >= 400 && status < 500) return false
    return true
  }
  return true
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface RetryContext {
  retryCount: number
  hitRateLimit: boolean
  retryAfterSeconds?: number
}

async function handleHttpRetryError(opts: {
  error: HTTPError
  attempt: number
  model: string
  ctx: RetryContext
}): Promise<void> {
  const { error, attempt, model, ctx } = opts
  const errorBody = (await error.response
    .clone()
    .json()
    .catch(() => ({}))) as {
    error?: { code?: string }
  }
  const code = errorBody.error?.code ?? ""
  if (NON_RETRYABLE_CODES.has(code)) {
    consola.warn(`不可重试错误 (${code})，直接返回`)
    throw error
  }

  if (error.response.status === 429) {
    ctx.hitRateLimit = true
    ctx.retryCount = attempt
    const retryAfter = error.response.headers.get("retry-after")
    if (retryAfter) {
      ctx.retryAfterSeconds = Number.parseInt(retryAfter, 10) || undefined
    }
    consola.warn(
      `⚠️ 上游返回 429 限流（第 ${attempt}/${MAX_RETRIES} 次）`
        + (ctx.retryAfterSeconds ?
          `，Retry-After: ${ctx.retryAfterSeconds}s`
        : "")
        + `，模型: ${model}`,
    )
  }
}

async function createChatCompletionsWithRetry(
  payload: ChatCompletionsPayload,
  ctx: RetryContext = { retryCount: 0, hitRateLimit: false },
): ReturnType<typeof createChatCompletions> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await createChatCompletions(payload)
    } catch (error) {
      lastError = error

      if (error instanceof HTTPError) {
        await handleHttpRetryError({
          error,
          attempt,
          model: payload.model,
          ctx,
        })
      }

      if (!isRetryable(error)) {
        consola.warn("不可重试错误，跳过重试")
        throw error
      }

      if (attempt < MAX_RETRIES) {
        const waitMs =
          ctx.retryAfterSeconds ? ctx.retryAfterSeconds * 1000 : RETRY_DELAY_MS
        consola.warn(
          `请求失败（第 ${attempt}/${MAX_RETRIES} 次），${waitMs / 1000}s 后重试...`,
          error,
        )
        await sleep(waitMs)
      } else {
        consola.error(`已重试 ${MAX_RETRIES} 次，全部失败，放弃。`)
      }
    }
  }
  throw lastError
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  const openAIPayload = translateToOpenAI(anthropicPayload)
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  if (state.manualApprove) {
    await awaitApproval()
  }

  const retryCtx: RetryContext = { retryCount: 0, hitRateLimit: false }

  let response: Awaited<ReturnType<typeof createChatCompletions>>
  try {
    response = await createChatCompletionsWithRetry(openAIPayload, retryCtx)
  } catch (error) {
    if (error instanceof HTTPError && error.response.status === 429) {
      const errorBody = await error.response
        .clone()
        .text()
        .catch(() => "")
      consola.error(
        `🚫 模型 ${openAIPayload.model} 频率受限，重试 ${retryCtx.retryCount} 次后仍失败。`
          + ` 上游响应: ${errorBody}`,
      )
      return c.json(
        {
          type: "error",
          error: {
            type: "rate_limit_error",
            message: `Rate limited by upstream (model: ${openAIPayload.model}). Retried ${retryCtx.retryCount} times over ~${retryCtx.retryCount * (retryCtx.retryAfterSeconds || RETRY_DELAY_MS / 1000)}s. Please wait and try again.`,
          },
        },
        429,
      )
    }
    throw error
  }

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
    const anthropicResponse = translateToAnthropic(response)
    consola.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  consola.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    for await (const rawEvent of response) {
      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        consola.debug("Translated Anthropic event:", JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
