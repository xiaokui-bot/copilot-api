import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { HTTPError } from "~/lib/error"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createResponses,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 30000

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

async function createResponsesWithRetry(
  payload: ResponsesPayload,
  ctx: RetryContext = { retryCount: 0, hitRateLimit: false },
): ReturnType<typeof createResponses> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await createResponses(payload)
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

export async function handleResponses(c: Context) {
  await checkRateLimit(state)

  const payload = await c.req.json<ResponsesPayload>()
  consola.debug("Responses API payload:", JSON.stringify(payload).slice(0, 400))

  if (state.manualApprove) await awaitApproval()

  const retryCtx: RetryContext = { retryCount: 0, hitRateLimit: false }

  let response: Awaited<ReturnType<typeof createResponses>>
  try {
    response = await createResponsesWithRetry(payload, retryCtx)
  } catch (error) {
    if (error instanceof HTTPError && error.response.status === 429) {
      const errorBody = await error.response
        .clone()
        .text()
        .catch(() => "")
      consola.error(
        `🚫 模型 ${payload.model} 频率受限，重试 ${retryCtx.retryCount} 次后仍失败。`
          + ` 上游响应: ${errorBody}`,
      )
      return c.json(
        {
          error: {
            message: `Rate limited by upstream (model: ${payload.model}). Retried ${retryCtx.retryCount} times over ~${retryCtx.retryCount * (retryCtx.retryAfterSeconds || RETRY_DELAY_MS / 1000)}s. Please wait and try again.`,
            type: "rate_limit_error",
            code: "rate_limit_exceeded",
            param: payload.model,
          },
        },
        429,
      )
    }
    throw error
  }

  if (!payload.stream) {
    return c.json(response)
  }

  return streamSSE(c, async (stream) => {
    for await (const chunk of response as AsyncIterable<{
      event?: string
      data?: string
    }>) {
      consola.debug("Responses streaming chunk:", JSON.stringify(chunk))
      await stream.writeSSE({
        event: chunk.event,
        data: chunk.data ?? "",
      })
    }
  })
}
