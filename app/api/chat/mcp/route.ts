// import { checkApiKey, getServerProfile } from "@/lib/server/server-chat-helpers"
import { ChatSettings } from "@/types"
import { StreamingTextResponse } from "ai"
import { ServerRuntime } from "next"
import { getMCPClient } from "@/lib/mcp-client"

export const runtime: ServerRuntime = "nodejs"

interface MCPRequest {
  chatSettings: ChatSettings
  messages: any[]
}

export async function POST(request: Request) {
  const json = await request.json()
  const { chatSettings, messages } = json as MCPRequest

  try {
    // TODO: augment this function to use different LLM client based on chatSettings.model
    // const profile = await getServerProfile()

    // Note: Ollama doesn't require API keys for local usage
    // If you need to connect to a remote Ollama instance, you can configure it here

    // Get the MCP client instance
    const mcpClient = await getMCPClient()

    // Use the MCP client to handle the chat with streaming
    const stream = await mcpClient.chat(chatSettings, messages)

    return new StreamingTextResponse(stream)
  } catch (error: any) {
    console.error(error)
    const errorMessage =
      error.error?.message || error.message || "An unexpected error occurred"
    const errorCode = error.status || 500
    return new Response(JSON.stringify({ message: errorMessage }), {
      status: errorCode
    })
  }
}
