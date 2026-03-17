import assert from "node:assert/strict"
import { beforeEach, describe, it, mock } from "node:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { state } from "../src/lib/state"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

const fetchMock = mock.fn(
  async (_url: string, opts: { headers: Record<string, string> }) => ({
    ok: true,
    json: async () => ({ id: "123", object: "chat.completion", choices: [] }),
    headers: opts.headers,
  }),
)

;(globalThis as unknown as { fetch: typeof fetch }).fetch =
  fetchMock as unknown as typeof fetch

describe("createChatCompletions", () => {
  beforeEach(() => {
    fetchMock.mock.resetCalls()
  })

  it("sets X-Initiator to agent if tool/assistant present", async () => {
    const payload: ChatCompletionsPayload = {
      messages: [
        { role: "user", content: "hi" },
        { role: "tool", content: "tool call" },
      ],
      model: "gpt-test",
    }

    await createChatCompletions(payload)

    assert.equal(fetchMock.mock.callCount(), 1)
    const headers = fetchMock.mock.calls[0].arguments[1].headers
    assert.equal(headers["X-Initiator"], "agent")
  })

  it("sets X-Initiator to user if only user present", async () => {
    const payload: ChatCompletionsPayload = {
      messages: [
        { role: "user", content: "hi" },
        { role: "user", content: "hello again" },
      ],
      model: "gpt-test",
    }

    await createChatCompletions(payload)

    assert.equal(fetchMock.mock.callCount(), 1)
    const headers = fetchMock.mock.calls[0].arguments[1].headers
    assert.equal(headers["X-Initiator"], "user")
  })
})
