import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { HTTPError } from "~/lib/error"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { isNullish } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

const MAX_RETRIES = 10
const RETRY_DELAY_MS = 3000

// 不可重试的错误码（客户端问题，重试无意义）
const NON_RETRYABLE_CODES = new Set([
  "model_max_prompt_tokens_exceeded",
  "content_filter",
  "invalid_request",
])

function isRetryable(error: unknown): boolean {
  if (error instanceof HTTPError) {
    // 4xx 客户端错误通常不重试，除非是 429（限流）
    const status = error.response.status
    if (status === 429) return true
    if (status >= 400 && status < 500) return false
    return true
  }
  // 网络错误（fetch failed、TLS 断开等）可重试
  return true
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function createChatCompletionsWithRetry(
  payload: ChatCompletionsPayload,
): ReturnType<typeof createChatCompletions> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await createChatCompletions(payload)
    } catch (error) {
      lastError = error

      // 检查是否为不可重试的已知错误码
      if (error instanceof HTTPError) {
        const errorBody = (await error.response.clone().json()) as {
          error?: { code?: string }
        }
        const code = errorBody.error?.code ?? ""
        if (NON_RETRYABLE_CODES.has(code)) {
          consola.warn(`不可重试错误 (${code})，直接返回`)
          throw error
        }
      }

      if (!isRetryable(error)) {
        consola.warn("不可重试错误，跳过重试")
        throw error
      }

      if (attempt < MAX_RETRIES) {
        consola.warn(
          `请求失败（第 ${attempt}/${MAX_RETRIES} 次），${RETRY_DELAY_MS / 1000}s 后重试...`,
          error,
        )
        await sleep(RETRY_DELAY_MS)
      } else {
        consola.error(`已重试 ${MAX_RETRIES} 次，全部失败，放弃。`)
      }
    }
  }
  throw lastError
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()
  consola.debug("Request payload:", JSON.stringify(payload).slice(-400))

  // Find the selected model
  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  // Calculate and display token count
  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      consola.info("Current token count:", tokenCount)
    } else {
      consola.warn("No model selected, skipping token count calculation")
    }
  } catch (error) {
    consola.warn("Failed to calculate token count:", error)
  }

  if (state.manualApprove) await awaitApproval()

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    consola.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens))
  }

  const response = await createChatCompletionsWithRetry(payload)

  if (isNonStreaming(response)) {
    consola.debug("Non-streaming response:", JSON.stringify(response))
    return c.json(response)
  }

  consola.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    for await (const chunk of response) {
      consola.debug("Streaming chunk:", JSON.stringify(chunk))
      await stream.writeSSE(chunk as SSEMessage)
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
