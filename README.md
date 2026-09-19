# Immich MCP Server

An MCP server for your Immich photo library with bidirectional image handling: pull photos into LLM context, push metadata and descriptions back, and manage faces and people.

## Requirements

- Node.js 20+
- A running Immich instance

## Install

```bash
git clone https://github.com/mattmaas/immich-mcp.git
cd immich-mcp
npm install
npm run build     # compiles TypeScript to dist/
npm start         # node dist/server.js
```

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

| Tool | Description |
|------|-------------|
| `immich_search_smart` | Smart (semantic) photo search |
| `immich_search_metadata` | Search by metadata |
| `immich_search_people` | Search by person |
| `immich_get_asset` | Get an asset by ID |
| `immich_get_asset_info` | Get asset metadata |
| `immich_upload_asset` | Upload a new asset |
| `immich_update_asset` | Update asset metadata |
| `immich_delete_assets` | Delete assets |
| `immich_list_albums` | List albums |
| `immich_create_album` | Create an album |
| `immich_add_to_album` | Add assets to an album |
| `immich_get_album` | Get an album's contents |
| `immich_list_people` | List detected people |
| `immich_rename_person` | Rename a person |
| `immich_merge_people` | Merge two people |
| `immich_get_statistics` | Library statistics |
| `immich_run_job` | Run a maintenance job |
| `immich_describe_photo` | Generate a description for a photo |
| `immich_bulk_update` | Bulk-update assets |
| `immich_server_info` | Server configuration info |
| `immich_random_assets` | Fetch random assets |
| `immich_get_asset_by_date` | Find assets by date |

## Usage

Ask your agent, for example:

- "Find photos of my dog" → `immich_search_smart(query="dog")`
- "Describe this photo" → `immich_describe_photo(...)`
- "Add these photos to the 'Trip' album" → `immich_add_to_album(...)`

## License

MIT
