import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { z } from "zod"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { translateToOpenAI } from "../src/routes/messages/non-stream-translation"

const messageSchema = z.object({
  role: z.enum([
    "system",
    "user",
    "assistant",
    "tool",
    "function",
    "developer",
  ]),
  content: z.union([z.string(), z.object({}), z.array(z.any())]),
  name: z.string().optional(),
  tool_calls: z.array(z.any()).optional(),
  tool_call_id: z.string().optional(),
})

const chatCompletionRequestSchema = z.object({
  messages: z.array(messageSchema).min(1, "Messages array cannot be empty."),
  model: z.string(),
  frequency_penalty: z.number().min(-2).max(2).optional().nullable(),
  logit_bias: z.record(z.string(), z.number()).optional().nullable(),
  logprobs: z.boolean().optional().nullable(),
  top_logprobs: z.number().int().min(0).max(20).optional().nullable(),
  max_tokens: z.number().int().optional().nullable(),
  n: z.number().int().min(1).max(128).optional().nullable(),
  presence_penalty: z.number().min(-2).max(2).optional().nullable(),
  response_format: z
    .object({
      type: z.enum(["text", "json_object", "json_schema"]),
      json_schema: z.object({}).optional(),
    })
    .optional(),
  seed: z.number().int().optional().nullable(),
  stop: z.union([z.string(), z.array(z.string())]).optional().nullable(),
  stream: z.boolean().optional().nullable(),
  temperature: z.number().min(0).max(2).optional().nullable(),
  top_p: z.number().min(0).max(1).optional().nullable(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.union([z.string(), z.object({})]).optional(),
  user: z.string().optional(),
})

function isValidChatCompletionRequest(payload: unknown): boolean {
  const result = chatCompletionRequestSchema.safeParse(payload)
  return result.success
}

describe("Anthropic to OpenAI translation logic", () => {
  it("should translate minimal Anthropic payload to valid OpenAI payload", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      max_tokens: 0,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)
    assert.equal(isValidChatCompletionRequest(openAIPayload), true)
  })

  it("should translate comprehensive Anthropic payload to valid OpenAI payload", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      system: "You are a helpful assistant.",
      messages: [
        { role: "user", content: "What is the weather like in Boston?" },
        {
          role: "assistant",
          content: "The weather in Boston is sunny and 75°F.",
        },
      ],
      temperature: 0.7,
      max_tokens: 150,
      top_p: 1,
      stream: false,
      metadata: { user_id: "user-123" },
      tools: [
        {
          name: "getWeather",
          description: "Gets weather info",
          input_schema: { location: { type: "string" } },
        },
      ],
      tool_choice: { type: "auto" },
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    assert.equal(isValidChatCompletionRequest(openAIPayload), true)
  })

  it("should handle missing fields gracefully", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      max_tokens: 0,
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    assert.equal(isValidChatCompletionRequest(openAIPayload), true)
  })

  it("should handle invalid types in Anthropic payload", () => {
    const anthropicPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      temperature: "hot",
    }
    const openAIPayload = translateToOpenAI(
      anthropicPayload as unknown as AnthropicMessagesPayload,
    )
    assert.equal(isValidChatCompletionRequest(openAIPayload), false)
  })

  it("should handle thinking blocks in assistant messages", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        { role: "user", content: "What is 2+2?" },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Let me think about this simple math problem...",
            },
            { type: "text", text: "2+2 equals 4." },
          ],
        },
      ],
      max_tokens: 100,
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    assert.equal(isValidChatCompletionRequest(openAIPayload), true)

    const assistantMessage = openAIPayload.messages.find(
      (m) => m.role === "assistant",
    )
    assert.ok(typeof assistantMessage?.content === "string")
    assert.match(
      assistantMessage.content,
      /Let me think about this simple math problem.../,
    )
    assert.match(assistantMessage.content, /2\+2 equals 4\./)
  })

  it("should handle thinking blocks with tool calls", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking:
                "I need to call the weather API to get current weather information.",
            },
            { type: "text", text: "I'll check the weather for you." },
            {
              type: "tool_use",
              id: "call_123",
              name: "get_weather",
              input: { location: "New York" },
            },
          ],
        },
      ],
      max_tokens: 100,
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    assert.equal(isValidChatCompletionRequest(openAIPayload), true)

    const assistantMessage = openAIPayload.messages.find(
      (m) => m.role === "assistant",
    )
    assert.ok(typeof assistantMessage?.content === "string")
    assert.match(assistantMessage.content, /I need to call the weather API/)
    assert.match(assistantMessage.content, /I'll check the weather for you\./)
    assert.equal(assistantMessage?.tool_calls?.length, 1)
    assert.equal(assistantMessage?.tool_calls?.[0].function.name, "get_weather")
  })
})

describe("OpenAI Chat Completion v1 Request Payload Validation with Zod", () => {
  it("should return true for a minimal valid request payload", () => {
    const validPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
    }
    assert.equal(isValidChatCompletionRequest(validPayload), true)
  })

  it("should return true for a comprehensive valid request payload", () => {
    const validPayload = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "What is the weather like in Boston?" },
      ],
      temperature: 0.7,
      max_tokens: 150,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      stream: false,
      n: 1,
    }
    assert.equal(isValidChatCompletionRequest(validPayload), true)
  })

  it('should return false if the "model" field is missing', () => {
    const invalidPayload = {
      messages: [{ role: "user", content: "Hello!" }],
    }
    assert.equal(isValidChatCompletionRequest(invalidPayload), false)
  })

  it('should return false if the "messages" field is missing', () => {
    const invalidPayload = {
      model: "gpt-4o",
    }
    assert.equal(isValidChatCompletionRequest(invalidPayload), false)
  })

  it('should return false if the "messages" array is empty', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [],
    }
    assert.equal(isValidChatCompletionRequest(invalidPayload), false)
  })

  it('should return false if "model" is not a string', () => {
    const invalidPayload = {
      model: 12345,
      messages: [{ role: "user", content: "Hello!" }],
    }
    assert.equal(isValidChatCompletionRequest(invalidPayload), false)
  })

  it('should return false if "messages" is not an array', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: { role: "user", content: "Hello!" },
    }
    assert.equal(isValidChatCompletionRequest(invalidPayload), false)
  })

  it('should return false if a message in the "messages" array is missing a "role"', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [{ content: "Hello!" }],
    }
    assert.equal(isValidChatCompletionRequest(invalidPayload), false)
  })

  it('should return false if a message in the "messages" array is missing "content"', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [{ role: "user" }],
    }
    const result = chatCompletionRequestSchema.safeParse(invalidPayload)
    assert.equal(result.success, false)
  })

  it('should return false if a message has an invalid "role"', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [{ role: "customer", content: "Hello!" }],
    }
    assert.equal(isValidChatCompletionRequest(invalidPayload), false)
  })

  it("should return false if an optional field has an incorrect type", () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      temperature: "hot",
    }
    assert.equal(isValidChatCompletionRequest(invalidPayload), false)
  })

  it("should return false for a completely empty object", () => {
    const invalidPayload = {}
    assert.equal(isValidChatCompletionRequest(invalidPayload), false)
  })

  it("should return false for null or non-object payloads", () => {
    assert.equal(isValidChatCompletionRequest(null), false)
    assert.equal(isValidChatCompletionRequest(undefined), false)
    assert.equal(isValidChatCompletionRequest("a string"), false)
    assert.equal(isValidChatCompletionRequest(123), false)
  })
})
