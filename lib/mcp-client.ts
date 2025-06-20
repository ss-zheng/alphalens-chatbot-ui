import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import fs from "fs/promises"
import path from "path"
import ollama from "ollama"
import { ChatSettings } from "@/types"

interface MCPServer {
  type: "sse" | "stdio"
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
}

interface MCPConfig {
  mcpServers: Record<string, MCPServer>
}

export class MCPClient {
  private clients: Map<string, Client> = new Map()
  private connectedServers: string[] = []
  private mcpToolMap = new Map<
    string,
    { name: string; description: string; inputSchema: any; serverName: string }
  >()

  constructor() {
    // We'll create client instances per server
  }

  async initialize(): Promise<void> {
    // Load mcp.json configuration
    const cfgPath = path.resolve(process.cwd(), "mcp.json")
    const raw = await fs.readFile(cfgPath, "utf-8")
    const cfg: MCPConfig = JSON.parse(raw)
    const mcpServers = cfg.mcpServers

    // Connect to MCP servers
    for (const [name, serverInfo] of Object.entries(mcpServers) as [
      string,
      MCPServer
    ][]) {
      const client = new Client({
        name: "alphalens-mcp-client" + name,
        version: "1.0.0"
      })
      try {
        if (serverInfo.type === "sse") {
          if (!serverInfo.url) {
            throw new Error(`URL is required for SSE server: ${name}`)
          }

          console.log(`Connecting to MCP server: ${name} at ${serverInfo.url}`)
          const transport = new SSEClientTransport(new URL(serverInfo.url))
          await client.connect(transport)
          this.clients.set(name, client)
          this.connectedServers.push(name)
          console.log(`✅ Connected to MCP server: ${name}`)
        } else if (serverInfo.type === "stdio") {
          if (!serverInfo.command || !serverInfo.args) {
            throw new Error(
              `Command and args are required for stdio server: ${name}`
            )
          }

          console.log(
            `Connecting to MCP server: ${name} with command: ${serverInfo.command} and args: ${serverInfo.args.join(", ")}`
          )
          const transport = new StdioClientTransport({
            command: serverInfo.command,
            args: serverInfo.args,
            env: serverInfo.env
          })
          await client.connect(transport)
          this.clients.set(name, client)
          this.connectedServers.push(name)
          console.log(`✅ Connected to MCP server: ${name}`)
        } else {
          throw new Error(`Unsupported server type: ${serverInfo.type}`)
        }
      } catch (error) {
        console.error(`Failed to connect to MCP server ${name}:`, error)
        throw new Error(
          `Failed to connect to MCP server ${name}: ${(error as Error).message}`
        )
      }
    }

    console.log(`Total connected servers: ${this.connectedServers.length}`)
    if (this.connectedServers.length === 0) {
      throw new Error("No MCP servers were successfully connected")
    }

    // Initialize tool map
    await this.initializeTools()
  }

  private async initializeTools(): Promise<void> {
    try {
      // Collect tools from all connected servers
      for (const [serverName, client] of this.clients.entries()) {
        console.log(`Listing tools from server: ${serverName}`)
        const tools = await client.listTools()
        console.log(`Tools from ${serverName} type:`, typeof tools)
        console.log(`Tools from ${serverName} is array:`, Array.isArray(tools))

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
          console.warn(`Unexpected tools format from ${serverName}:`, tools)
          toolsArray = []
        }

        // Process tools for Ollama format
        for (const tool of toolsArray) {
          if (tool && typeof tool === "object" && tool.name) {
            this.mcpToolMap.set(tool.name, {
              name: tool.name,
              description: tool.description || "",
              inputSchema: tool.inputSchema,
              serverName: serverName
            })
          }
        }
      }

      console.log("Processed tools count:", this.mcpToolMap.size)
      console.log("Available tools:", Array.from(this.mcpToolMap.keys()))
    } catch (error) {
      console.error("Failed to list MCP tools:", error)
      throw new Error(`Failed to list MCP tools: ${(error as Error).message}`)
    }
  }

  private getOllamaTools(): any[] {
    const allTools: any[] = []

    for (const [name, tool] of this.mcpToolMap.entries()) {
      const ollamaTool = {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema
        }
      }
      allTools.push(ollamaTool)
    }

    return allTools
  }

  private async executeToolCalls(
    toolCalls: any[],
    messages: any[],
    controller?: ReadableStreamDefaultController<Uint8Array>
  ): Promise<void> {
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
      const mcpTool = this.mcpToolMap.get(functionName)
      if (!mcpTool) {
        throw new Error(`MCP tool ${functionName} not found`)
      }

      try {
        // Get the client for this tool's server
        const client = this.clients.get(mcpTool.serverName)
        if (!client) {
          throw new Error(`Client for server ${mcpTool.serverName} not found`)
        }

        // Call the MCP tool
        const result = await client.callTool({
          name: functionName,
          arguments: parsedArgs
        })

        // Stream tool result to the user
        if (controller) {
          const toolResult = `**Tool Result (${functionName}):**\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n\n`
          controller.enqueue(new TextEncoder().encode(toolResult))
        }

        messages.push({
          role: "tool",
          name: functionName,
          content: JSON.stringify(result)
        })
      } catch (error) {
        console.error(`Error calling MCP tool ${functionName}:`, error)

        // Stream error to the user
        if (controller) {
          const errorResult = `**Tool Error (${functionName}):**\n\`\`\`json\n${JSON.stringify(
            {
              error: `Failed to execute tool ${functionName}: ${(error as Error).message}`
            },
            null,
            2
          )}\n\`\`\`\n\n`
          controller.enqueue(new TextEncoder().encode(errorResult))
        }

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

  async chat(
    chatSettings: ChatSettings,
    messages: any[]
  ): Promise<ReadableStream<Uint8Array>> {
    console.log(
      "MCP Client received messages:",
      JSON.stringify(messages, null, 2)
    )
    console.log("Number of messages received:", messages.length)

    const allTools = this.getOllamaTools()
    const self = this // Capture the context

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          let currentMessages = [...messages]
          console.log(
            "Current messages at start:",
            JSON.stringify(currentMessages, null, 2)
          )
          let iterationCount = 0
          const maxIterations = 10 // Prevent infinite loops

          while (iterationCount < maxIterations) {
            iterationCount++
            console.log(`Chat iteration ${iterationCount}`)
            console.log(
              `Messages being sent to Ollama:`,
              JSON.stringify(currentMessages, null, 2)
            )

            // Call Ollama to get response and potential tool calls
            const response = await ollama.chat({
              model: chatSettings.model,
              messages: currentMessages,
              tools: allTools.length > 0 ? allTools : undefined,
              stream: true,
              think: true,
              keep_alive: "1.5h",
              options: {
                temperature: chatSettings.temperature
              }
            })

            let message: any = { content: "", tool_calls: [] }
            // Stream the response chunks
            for await (const part of response) {
              if (part.message?.content) {
                const content = part.message.content
                controller.enqueue(new TextEncoder().encode(content))
                message.content += content
              }
              if (part.message?.tool_calls) {
                message.tool_calls = part.message.tool_calls
              }
            }

            currentMessages.push(message)
            const toolCalls = message.tool_calls || []

            // If no tool calls, we're done streaming and can break
            if (toolCalls.length === 0) {
              break
            }

            // Stream tool call information to the user
            const toolCallInfo = `\n\n**Tool Calls:**\n\`\`\`json\n${JSON.stringify(toolCalls, null, 2)}\n\`\`\`\n\n`
            controller.enqueue(new TextEncoder().encode(toolCallInfo))
            message.content += toolCallInfo

            // Execute tool calls
            await self.executeToolCalls(toolCalls, currentMessages, controller)
          }

          controller.close()
        } catch (error) {
          console.error("Error in chat streaming:", error)
          controller.error(error)
        }
      }
    })
  }

  getConnectedServers(): string[] {
    return [...this.connectedServers]
  }

  getToolCount(): number {
    return this.mcpToolMap.size
  }
}

// Singleton instance
let mcpClientInstance: MCPClient | null = null

export async function getMCPClient(): Promise<MCPClient> {
  if (!mcpClientInstance) {
    mcpClientInstance = new MCPClient()
    await mcpClientInstance.initialize()
  }
  return mcpClientInstance
}
