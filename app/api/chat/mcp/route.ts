// import { checkApiKey, getServerProfile } from "@/lib/server/server-chat-helpers"
import { ChatSettings } from "@/types"
import { StreamingTextResponse } from "ai"
import { ServerRuntime } from "next"
import ollama from "ollama"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import fs from "fs/promises"
import path from "path"

export const runtime: ServerRuntime = "nodejs"

// Load mcp.json configuration server-side
const cfgPath = path.resolve(process.cwd(), "mcp.json")
const raw = await fs.readFile(cfgPath, "utf-8")
const cfg = JSON.parse(raw)
const mcpServers = cfg.mcpServers

interface MCPServer {
  type: "sse"
  url: string
}

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

    // Create MCP client
    const mcpClient = new Client({
      name: "alphalens-chatbot-ui",
      version: "1.0.0"
    })

    // Connect to MCP servers (only SSE supported in Edge Runtime)
    const connectedServers: string[] = []
    for (const [name, serverInfo] of Object.entries(mcpServers) as [
      string,
      MCPServer
    ][]) {
      try {
        if (serverInfo.type !== "sse") {
          throw new Error(
            `Only SSE transport is supported in Edge Runtime. Server ${name} uses ${serverInfo.type}`
          )
        }

        if (!serverInfo.url) {
          throw new Error(`URL is required for SSE server: ${name}`)
        }

        console.log(`Connecting to MCP server: ${name} at ${serverInfo.url}`)
        const transport = new SSEClientTransport(new URL(serverInfo.url))
        await mcpClient.connect(transport)
        connectedServers.push(name)
        console.log(`✅ Connected to MCP server: ${name}`)
      } catch (error) {
        console.error(`Failed to connect to MCP server ${name}:`, error)
        throw new Error(
          `Failed to connect to MCP server ${name}: ${(error as Error).message}`
        )
      }
    }

    console.log(`Total connected servers: ${connectedServers.length}`)
    if (connectedServers.length === 0) {
      throw new Error("No MCP servers were successfully connected")
    }

    // Get available tools from all connected MCP servers
    let allTools: any[] = []
    const mcpToolMap = new Map<
      string,
      { name: string; description: string; inputSchema: any }
    >()

    try {
      const tools = await mcpClient.listTools()
      //   console.log("MCP tools response:", tools)
      console.log("Tools type:", typeof tools)
      console.log("Tools is array:", Array.isArray(tools))

      // Handle different possible return types
      let toolsArray: any[] = []

      if (Array.isArray(tools)) {
        toolsArray = tools
      } else if (tools && typeof tools === "object") {
        // If it's an object, try to extract tools from it
        if (tools.tools && Array.isArray(tools.tools)) {
          toolsArray = tools.tools
        } else if (tools.result && Array.isArray(tools.result)) {
          toolsArray = tools.result
        } else {
          // Try to convert object to array
          toolsArray = Object.values(tools)
        }
      } else {
        console.warn("Unexpected tools format:", tools)
        toolsArray = []
      }

      // ollama tools need to be passed using its own format
      for (const tool of toolsArray) {
        // console.log("Processing tool:", tool)

        if (tool && typeof tool === "object" && tool.name) {
          const ollamaTool = {
            type: "function",
            function: {
              name: tool.name,
              description: tool.description || "",
              parameters: tool.inputSchema || {}
            }
          }

          allTools.push(ollamaTool)
          mcpToolMap.set(tool.name, {
            name: tool.name,
            description: tool.description || "",
            inputSchema: tool.inputSchema
          })
        }
      }

      console.log("Processed tools count:", allTools.length)
    } catch (error) {
      console.error("Failed to list MCP tools:", error)
      throw new Error(`Failed to list MCP tools: ${(error as Error).message}`)
    }

    // First Ollama call to get tool calls
    console.log("First call messages", messages)
    const firstResponse = await ollama.chat({
      model: chatSettings.model,
      messages,
      tools: allTools.length > 0 ? allTools : undefined,
      stream: false,
      options: {
        temperature: chatSettings.temperature
      }
    })

    console.log("P1", firstResponse)
    const message = firstResponse.message
    messages.push(message)
    const toolCalls = message.tool_calls || []

    if (toolCalls.length === 0) {
      return new Response(message.content, {
        headers: {
          "Content-Type": "application/json"
        }
      })
    }

    console.log("P2")
    // Execute tool calls
    if (toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        const functionCall = toolCall.function
        const functionName = functionCall.name

        // Handle arguments that could be either a string or an object
        let parsedArgs: any
        const args = functionCall.arguments as any
        if (typeof args === "string") {
          // Arguments is a JSON string, parse it
          parsedArgs = JSON.parse(args.trim())
        } else if (typeof args === "object" && args !== null) {
          // Arguments is already an object, use it directly
          parsedArgs = args
        } else {
          throw new Error(`Unexpected arguments type: ${typeof args}`)
        }

        console.log(`Calling tool ${functionName} with args:`, parsedArgs)

        // Check if the tool exists in our MCP tool map
        const mcpTool = mcpToolMap.get(functionName)
        if (!mcpTool) {
          throw new Error(`MCP tool ${functionName} not found`)
        }

        try {
          // Call the MCP tool
          const result = await mcpClient.callTool({
            name: functionName,
            arguments: parsedArgs
          })

          messages.push({
            role: "tool",
            name: functionName,
            content: JSON.stringify(result)
          })
        } catch (error) {
          console.error(`Error calling MCP tool ${functionName}:`, error)
          messages.push({
            role: "tool",
            name: functionName,
            content: JSON.stringify({
              error: `Failed to execute tool ${functionName}: ${(error as Error).message}`
            })
          })
        }
      }
    }
    console.log("P3")

    // Second Ollama call with tool results - streaming
    console.log("Second call messages", messages)
    const secondResponse = await ollama.chat({
      model: chatSettings.model,
      messages,
      stream: true,
      options: {
        temperature: chatSettings.temperature
      }
    })

    // Create a ReadableStream from Ollama's AsyncGenerator
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const part of secondResponse) {
            // Extract content from the part
            const content = part.message?.content || ""

            if (content) {
              controller.enqueue(new TextEncoder().encode(content))
            }
          }
          controller.close()
        } catch (error) {
          console.error("Error in streaming:", error)
          controller.error(error)
        }
      }
    })

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
