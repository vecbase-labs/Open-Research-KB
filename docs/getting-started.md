# Quick Start

[Home](../README.md) · [中文](getting-started.zh-CN.md) · Next: [Concepts](concepts.md)

This page shows how to start OpenShelf locally, connect it to Codex MCP, create a knowledge base, and ingest the first PDF.

## 1. Install Dependencies

```bash
npm install
```

Install Poppler before ingesting PDFs:

```text
pdftotext
pdfinfo
pdftoppm
```

Install Tesseract as well if OCR is needed. OCR is not enabled automatically.

## 2. Start the MCP Server

```bash
npm run openshelf-mcp
```

This starts the MCP server over stdio for Codex or another MCP client.

## 3. Configure Codex MCP

Add the following to your Codex MCP config and replace `/path/to/OpenShelf` with your local repository path:

```toml
[mcp_servers.openshelf]
command = "npm"
args = ["--prefix", "/path/to/OpenShelf", "run", "--silent", "openshelf-mcp"]
```

A fresh install starts with the default knowledge base:

```text
db_name: default
duckdb_path: data/index/kb_default.duckdb
```

## 4. Install as a Codex Plugin

OpenShelf can also be installed as a Codex plugin. The plugin manifest is `.codex-plugin/plugin.json`, and the MCP server config is `.mcp.json`.

Local installation:

```bash
codex plugin marketplace add /path/to/OpenShelf
codex plugin add openshelf@openshelf-local
```

Start a new Codex thread after installation so Codex reloads the plugin skill and MCP tools.

Plugin mode uses this data directory by default:

```text
~/.openshelf/data
```

This avoids writing knowledge bases into the Codex plugin cache. If you already have an OpenShelf `.duckdb` file, ask the agent to register it with `create_db_from_exist` in a new conversation.

## 5. Install as a Claude Code Plugin

OpenShelf also supports Claude Code plugins. Claude Code uses `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, and the root `.mcp.json`.

Local installation:

```bash
claude plugin marketplace add /path/to/OpenShelf
claude plugin install openshelf@openshelf-local
```

Restart Claude Code or start a new session after installation. Claude Code imports the MCP server named `openshelf`.

## 6. Create or Register a Knowledge Base

Create a new knowledge base:

```json
{
  "db_name": "research_corpus",
  "path": "/path/to/pdf-folder",
  "tags": ["research"]
}
```

Register an existing OpenShelf DuckDB file:

```json
{
  "db_name": "shared_corpus",
  "duckdb_path": "/path/to/kb_shared_corpus.duckdb"
}
```

`create_db_from_exist` only updates the catalog. It does not copy the DuckDB file or re-ingest PDFs.

## 7. Add a PDF

Command line:

```bash
npm run create-document -- '{"pdf_path":"<path-to-book.pdf>","title":"Book Title","authors":["Author"],"tags":["book"]}'
```

MCP tool input:

```json
{
  "pdf_path": "/path/to/book.pdf",
  "title": "Book Title",
  "authors": ["Author"],
  "tags": ["book"]
}
```

If multiple databases exist, pass `db_name` explicitly when ingesting or searching.

## 8. Run the Smoke Test

Use any searchable text PDF:

```bash
KB_MCP_SMOKE_PDF=<path-to-sample.pdf> npm run smoke:pdf
```

## PDF Requirements

OpenShelf accepts PDFs whose text can be extracted directly by default. LaTeX-generated papers and ebooks with embedded text usually work. Scanned PDFs, image-only PDFs, and PDFs whose text cannot be copied and pasted are rejected.

Rejected documents return:

```json
{
  "status": "rejected",
  "index_status": "not_indexed",
  "rejection_reason": "no_searchable_text"
}
```

Default settings:

```text
ocr: "never"
require_searchable: true
```

For scanned documents, explicitly set:

```json
{
  "ocr": "auto"
}
```

Previous: [Home](../README.md) · Next: [Concepts](concepts.md)
