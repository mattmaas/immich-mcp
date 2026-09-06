# Immich MCP Server

An MCP server that exposes 22 tools for your Immich photo library. It supports bidirectional image handling: pull photos into LLM context and push metadata and descriptions back, plus face and people management.

## Requirements

- Node.js 20+
- A running Immich instance

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `IMMICH_URL` | yes | Base URL of your Immich server, e.g. `http://localhost:2283` |
| `IMMICH_API_KEY` | yes | API key from Immich settings |

## MCP Client Configuration

Add this server to your MCP client's config:

```json
{
  "mcpServers": {
    "immich": {
      "command": "node",
      "args": ["<path>/immich-mcp/dist/server.js"],
      "env": {
        "IMMICH_URL": "http://localhost:2283",
        "IMMICH_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Tools

22 tools cover photo search, album management, face and people management, metadata edits, and description push/pull.

## License

MIT
