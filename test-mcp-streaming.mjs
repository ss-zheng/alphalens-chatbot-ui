import ollama from 'ollama'

// Mock MCP client for testing
class MockMCPClient {
  constructor() {
    this.tools = [
      {
        name: "get_current_weather",
        description: "Get the current weather in a given location",
        inputSchema: {
          type: "object",
          properties: {
            location: {
              type: "string",
              description: "The city and state, e.g. San Francisco, CA"
            },
            format: {
              type: "string",
              enum: ["celsius", "fahrenheit"],
              description: "The temperature unit to use"
            }
          },
          required: ["location"]
        }
      }
    ]
  }

  async listTools() {
    return this.tools
  }

  async callTool({ name, arguments: args }) {
    console.log(`Mock MCP: Calling tool ${name} with args:`, args)
    
    if (name === "get_current_weather") {
      // Simulate weather API call
      return {
        location: args.location,
        temperature: 22,
        unit: args.format || "celsius",
        description: "Partly cloudy"
      }
    }
    
    throw new Error(`Unknown tool: ${name}`)
  }
}

async function testMCPStreaming() {
  try {
    console.log("🧪 Testing MCP Streaming Logic...")
    
    // Initialize mock MCP client
    const mcpClient = new MockMCPClient()
    
    // Get available tools
    const tools = await mcpClient.listTools()
    console.log("Available tools:", tools.map(t => t.name))
    
    // Convert tools to Ollama format
    const allTools = tools.map(tool => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.inputSchema || {}
      }
    }))
    
    console.log("Ollama tools:", allTools)
    
    // Initial messages
    let currentMessages = [
      { role: "user", content: "What's the weather like in Paris?" }
    ]
    
    let iteration = 0
    const maxIterations = 5
    
    console.log("\n🔄 Starting conversation loop...")
    
    while (iteration < maxIterations) {
      iteration++
      console.log(`\n--- Iteration ${iteration} ---`)
      console.log(`Messages: ${currentMessages.length}`)
      
      // Simulate streaming response (we'll collect it first for testing)
      console.log("📡 Calling Ollama...")
      const response = await ollama.chat({
        model: 'qwen3:latest',
        messages: currentMessages,
        tools: allTools.length > 0 ? allTools : undefined,
        stream: true,
        options: {
          temperature: 0.7
        }
      })
      
      // Collect the full response
      let fullMessage = ""
      console.log("📝 Streaming response:")
      for await (const part of response) {
        const content = part.message?.content || ""
        if (content) {
          fullMessage += content
          process.stdout.write(content) // Simulate streaming to console
        }
      }
      console.log("\n")
      
      // Add the complete message to our conversation
      const completeMessage = {
        role: 'assistant',
        content: fullMessage
      }
      currentMessages.push(completeMessage)
      
      // Check if there are tool calls
      console.log("🔍 Checking for tool calls...")
      const lastResponse = await ollama.chat({
        model: 'qwen3:latest',
        messages: currentMessages,
        tools: allTools.length > 0 ? allTools : undefined,
        stream: false,
        options: {
          temperature: 0.7
        }
      })
      
      const toolCalls = lastResponse.message.tool_calls || []
      console.log(`Found ${toolCalls.length} tool calls`)
      
      if (toolCalls.length === 0) {
        console.log("✅ No more tool calls, conversation complete!")
        break
      }
      
      // Execute tool calls
      console.log("🛠️ Executing tool calls...")
      for (const toolCall of toolCalls) {
        const functionCall = toolCall.function
        const functionName = functionCall.name
        
        // Handle arguments
        let parsedArgs
        const args = functionCall.arguments
        if (typeof args === 'string') {
          parsedArgs = JSON.parse(args.trim())
        } else if (typeof args === 'object' && args !== null) {
          parsedArgs = args
        } else {
          throw new Error(`Unexpected arguments type: ${typeof args}`)
        }
        
        console.log(`Calling tool: ${functionName} with args:`, parsedArgs)
        
        try {
          const result = await mcpClient.callTool({
            name: functionName,
            arguments: parsedArgs
          })
          
          // Add tool result to messages
          currentMessages.push({
            role: "tool",
            name: functionName,
            content: JSON.stringify(result)
          })
          
          console.log(`✅ Tool ${functionName} executed successfully:`, result)
        } catch (error) {
          console.error(`❌ Error calling tool ${functionName}:`, error)
          currentMessages.push({
            role: "tool",
            name: functionName,
            content: JSON.stringify({
              error: `Failed to execute tool ${functionName}: ${error.message}`
            })
          })
        }
      }
    }
    
    if (iteration >= maxIterations) {
      console.warn(`⚠️ Reached maximum iterations (${maxIterations})`)
    }
    
    console.log("\n🎉 Test completed successfully!")
    console.log("Final message count:", currentMessages.length)
    
  } catch (error) {
    console.error("❌ Test failed:", error)
  }
}

// Run the test
testMCPStreaming() 