# n8n Workflow Automation Repository

A repository of n8n workflow automations built with AI assistance using Claude Code and [n8n-mcp](https://github.com/czlonkowski/n8n-mcp).

## Overview

This project serves as:
- A **workflow library** - Reusable n8n automation workflows stored as JSON
- An **AI-assisted development environment** - Using Claude Code with MCP servers to design, build, and deploy workflows
- A **version-controlled backup** - All workflows tracked in git for history and collaboration

## Workflows

| Workflow | Description | Status |
|----------|-------------|--------|
| [Notion-Todoist Bidirectional Sync](./notion-todoist-bidirectional-sync.json) | Syncs tasks between Notion and Todoist with status mapping and deduplication | In Development |

## Project Structure

```
n8n/
├── README.md                              # This file
├── CLAUDE.md                              # AI assistant instructions
├── .mcp.json                              # MCP server config (gitignored)
├── .env                                   # Environment secrets (gitignored)
├── .gitignore                             # Git ignore rules
└── *.json                                 # Workflow files
```

## Setup

### Prerequisites

- [Claude Code](https://claude.ai/claude-code) CLI installed
- n8n instance (self-hosted or cloud)
- API credentials for services you want to automate

### Getting Started

1. **Clone the repository**
   ```bash
   git clone https://github.com/robbybarnes/n8n.git
   cd n8n
   ```

2. **Configure MCP servers**

   Create `.mcp.json` with your credentials:
   ```json
   {
     "mcpServers": {
       "n8n-mcp": {
         "type": "stdio",
         "command": "npx",
         "args": ["-y", "n8n-mcp"],
         "env": {
           "N8N_API_URL": "https://your-n8n-instance.com/",
           "N8N_API_KEY": "your-api-key"
         }
       },
       "notion": {
         "type": "stdio",
         "command": "npx",
         "args": ["-y", "@notionhq/notion-mcp-server"],
         "env": {
           "NOTION_TOKEN": "your-notion-token"
         }
       }
     }
   }
   ```

3. **Start Claude Code**
   ```bash
   claude
   ```

   MCP servers will automatically connect.

## Using Workflows

### Import a Workflow

1. Copy the workflow JSON file content
2. In n8n, go to **Workflows** > **Import from File**
3. Paste or upload the JSON
4. Configure credentials for each node
5. Test with the Manual Trigger before activating

### Deploy via API

With n8n-mcp configured, Claude can deploy workflows directly:
```
Deploy notion-todoist-bidirectional-sync.json to my n8n instance
```

## Creating New Workflows

Ask Claude to help build automations:

```
Create a workflow that:
- Triggers when a new row is added to Google Sheets
- Sends a Slack notification to #alerts channel
- Logs the event to a database
```

Claude will:
1. Search for relevant templates
2. Configure nodes with proper parameters
3. Validate the workflow
4. Save as JSON and optionally deploy

## Workflow Documentation

Each workflow JSON includes embedded documentation via sticky notes. Key information:
- Purpose and use case
- Required credentials
- Configuration steps
- Status/field mappings

## Contributing

1. Create workflows using Claude Code in this directory
2. Test thoroughly with dry run modes when available
3. Document any required setup in sticky notes
4. Commit the JSON file with a descriptive message

## Security Notes

- `.mcp.json` and `.env` are gitignored - never commit credentials
- Workflow JSONs may contain database IDs or project IDs - review before sharing publicly
- Use n8n's credential system rather than hardcoding secrets in workflows

## Resources

- [n8n Documentation](https://docs.n8n.io/)
- [n8n-mcp GitHub](https://github.com/czlonkowski/n8n-mcp)
- [n8n Workflow Templates](https://n8n.io/workflows/)
- [Claude Code Documentation](https://docs.anthropic.com/claude-code)
