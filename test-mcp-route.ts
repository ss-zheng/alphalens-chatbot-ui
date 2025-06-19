import fs from 'fs/promises';
import path from 'path';

async function testMCPRoute() {
    try {
        // Load mcp.json configuration
        const cfgPath = path.resolve(process.cwd(), 'mcp.json');
        const raw = await fs.readFile(cfgPath, 'utf-8');
        const cfg = JSON.parse(raw);

        // Test data for the MCP route with Ollama model
        const testData = {
            chatSettings: {
                model: "qwen3:latest", // Using Ollama model instead of OpenAI
                temperature: 0.7,
                maxTokens: 1000
            },
            messages: [
                {
                    role: "user",
                    content: "What tools are available from the SEC EDGAR MCP server?"
                }
            ],
            mcpServers: cfg.mcpServers
        };

        console.log("🧪 Testing MCP route with Ollama:", JSON.stringify(testData, null, 2));

        // Make a request to the MCP route
        const response = await fetch('http://localhost:3000/api/chat/mcp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(testData)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("❌ MCP route test failed:", response.status, errorText);
            return;
        }

        console.log("✅ MCP route test successful!");
        console.log("Response status:", response.status);
        
        // Read the streaming response
        const reader = response.body?.getReader();
        if (reader) {
            const decoder = new TextDecoder();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value);
                console.log("Stream chunk:", chunk);
            }
        }

    } catch (error) {
        console.error("❌ MCP route test failed:", (error as Error).message);
    }
}

// Run the test
testMCPRoute().catch(console.error); 