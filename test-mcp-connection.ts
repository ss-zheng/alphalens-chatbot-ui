import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from 'fs/promises';
import path from 'path';

async function testMCPConnection() {
    // 1. Load mcp.json from your project root
    const cfgPath = path.resolve(process.cwd(), 'mcp.json');
    const raw = await fs.readFile(cfgPath, 'utf-8');
    const cfg = JSON.parse(raw);

    console.log(cfg);

    // 2. Create an MCP client instance
    const client = new Client({
        name: 'my-mcp-client',
        version: '1.0.0',
    });

    // 3. For each server entry, connect using setup info
    try {
        for (const [name, serverInfo] of Object.entries(cfg.mcpServers) as [string, any][]) {
            console.log(name, serverInfo);
            let transport;
            if (serverInfo.type === 'stdio') {
                transport = new StdioClientTransport({
                    command: serverInfo.command,
                    args: serverInfo.args,
                    env: serverInfo.env,
                });
            // } else if (serverInfo.type === 'http') {
            //     transport = new StreamableHTTPClientTransport({
            //         url: serverInfo.url,
            //     });
            } else if (serverInfo.type === 'sse') {
                transport = new SSEClientTransport(new URL(serverInfo.url));
            } else {
                console.warn(`Skipping unsupported transport type ${serverInfo.type}`);
                continue;
            }

            await client.connect(transport);
            console.log(`Connected to MCP server: ${name}`);
        }
    } catch (error) {
        console.log("❌ MCP server connection failed:", (error as Error).message);
        return;
    }

    // Test listing available tools
    try {
        console.log("\n🔧 Listing available tools...");
        const tools = await client.listTools();
        console.log("Available tools:", JSON.stringify(tools, null, 2));
    } catch (error) {
        console.log("❌ Failed to list tools:", (error as Error).message);
    }

    // Try calling one of the tools
    try {
        console.log("\n🧪 Testing a tool...");
        const result = await client.callTool({
            name: "sec_edgar_mcp_get_today_date",
            arguments: {}
        });
        console.log("Tool result:", JSON.stringify(result, null, 2));
    } catch (error) {
        console.log("❌ Tool test failed:", (error as Error).message);
    }
    console.log("\n🏁 MCP connection test completed");
}

// Run the test
testMCPConnection().catch(console.error); 