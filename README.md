# OpenShelf

[简体中文](README.zh-CN.md) · [Codex plugin](#codex-plugin) · [Claude Code plugin](#claude-code-plugin) · [Quick start](docs/getting-started.md) · [Concepts](docs/concepts.md) · [Search and evidence](docs/search-and-evidence.md) · [Tool reference](docs/tool-reference.md)

OpenShelf is a local-first MCP server for building searchable knowledge bases from local folders. It indexes text-layer PDFs into DuckDB, exposes evidence-grounded retrieval tools to agents, and separates corpus-backed answers from answers that require additional reasoning.

OpenShelf is designed for research papers, textbooks, technical documents, and local document libraries. It does not require a cloud vector database by default, does not upload source files, and keeps generated DuckDB files, PDF caches, and rendered page images out of the repository.

## Why OpenShelf

Many RAG tools blur the line between "retrieved related text" and "the corpus supports this answer." OpenShelf keeps that boundary explicit:

- Build reusable DuckDB knowledge bases from local files.
- Use explainable DuckDB-backed BM25 text retrieval by default.
- Preserve page chunks, technical-result chunks, and source-page evidence.
- Distinguish closed corpus and open research corpus boundaries.
- Label results as `supported`, `related_only`, or `not_found`.
- Share a knowledge base directly by sharing its `.duckdb` file.

## Features

| Capability | Description |
|---|---|
| Local ingestion | Index searchable PDFs into DuckDB. |
| Multiple databases | Manage isolated knowledge bases with `db_name`. |
| Existing DB registration | Register an existing OpenShelf DuckDB file with `create_db_from_exist`. |
| Text retrieval | Default `mode: "text"` uses BM25 text search. |
| Evidence labels | Return `supported`, `related_only`, or `not_found`. |
| Corpus boundary | Use profiles to distinguish closed corpus and open research corpus behavior. |
| Source inspection | Fetch chunks, page text, and rendered page images. |
| Technical index | Let users decide after ingestion whether to build theorem, lemma, definition, and proposition-oriented indexes. |

## Quick Start

```bash
npm install
npm run openshelf-mcp
```

Add the server to your Codex MCP config:

```toml
[mcp_servers.openshelf]
command = "npm"
args = ["--prefix", "/path/to/OpenShelf", "run", "--silent", "openshelf-mcp"]
```

Add a searchable PDF:

```bash
npm run create-document -- '{"pdf_path":"<path-to-book.pdf>","title":"Book Title","authors":["Author"],"tags":["book"]}'
```

See [Quick start](docs/getting-started.md) for the full flow.

## Codex Plugin

This repository is also a Codex plugin root. It contains:

```text
.codex-plugin/plugin.json  plugin manifest
.mcp.json                  OpenShelf MCP server config
skills/openshelf/          agent guidance for using OpenShelf
.agents/plugins/           local marketplace config
```

Local installation:

```bash
codex plugin marketplace add /path/to/OpenShelf
codex plugin add openshelf@openshelf-local
```

Start a new Codex thread after installation so Codex loads the OpenShelf MCP tools from the plugin.

In plugin mode, OpenShelf stores knowledge-base data under `~/.openshelf/data` by default, not inside the Codex plugin cache. Existing `.duckdb` files can be registered into that catalog with `create_db_from_exist`.

## Claude Code Plugin

This repository also supports the Claude Code plugin layout:

```text
.claude-plugin/plugin.json       Claude Code plugin manifest
.claude-plugin/marketplace.json  Claude Code local marketplace
.mcp.json                        OpenShelf MCP server loaded by Claude Code
```

Local installation:

```bash
claude plugin marketplace add /path/to/OpenShelf
claude plugin install openshelf@openshelf-local
```

Restart Claude Code or start a new session after installation. Claude Code imports the MCP server named `openshelf`. Plugin data is stored under Claude's `${CLAUDE_PLUGIN_DATA}/data` by default; existing `.duckdb` files can be registered with `create_db_from_exist`.

## Recommended Workflow

OpenShelf is designed for an LLM agent with MCP tools, not for users to manually execute every retrieval step. A typical flow is:

1. The user names a knowledge base and asks a question in natural language, such as "Use `research_corpus` to answer this."
2. The agent chooses `search`, `search_terms`, or `search_technical_results` based on the question.
3. If the result is `supported`, the agent answers directly from cited evidence.
4. If the result is `related_only` or `not_found`, the agent explains that corpus evidence is insufficient and asks whether the user allows further reasoning.
5. If the user allows further reasoning and the corpus is closed, the agent uses `check_reasonable` to audit whether the reasoning exceeds the corpus boundary. If the corpus is open research, the agent may continue, but must label what comes from the knowledge base and what is independent reasoning.
6. If theorem, definition, or proposition-level retrieval is needed, the agent can suggest calling `build_technical_index` on already ingested documents to generate technical-result chunks.

## PDF Requirements

By default, OpenShelf only accepts PDFs whose text can be extracted directly. LaTeX-generated papers and ebooks with embedded text usually work. Scanned PDFs, image-only PDFs, and PDFs whose text cannot be copied and pasted are rejected.

Default settings:

```text
ocr: "never"
require_searchable: true
```

OCR must be explicitly enabled for scanned documents. It depends on local Tesseract and may be unreliable for formulas, tables, and complex layouts.

See [Quick start: PDF requirements](docs/getting-started.md#pdf-requirements).

## Core Tools

| Tool | Purpose |
|---|---|
| `create_db` | Create a named DuckDB knowledge base, optionally ingesting PDFs. |
| `create_db_from_exist` | Register an existing OpenShelf DuckDB file without copying or re-ingesting it. |
| `list_db` | List available databases and profiles. |
| `create_document` | Add one searchable PDF, rejecting image-only PDFs by default. |
| `search` | Search chunks and return answerability metadata. |
| `search_terms` | Two-stage retrieval for technical or domain questions. |
| `build_technical_index` | Build theorem, lemma, definition, and related technical-result indexes. |
| `search_technical_results` | Search structured technical results. |
| `get_chunk` / `get_page_text` / `get_page_image` | Inspect chunks, page text, and rendered pages. |

See [Tool reference](docs/tool-reference.md) for complete schemas.

## Documentation

| Page | Content |
|---|---|
| [Quick start](docs/getting-started.md) | Installation, MCP setup, ingestion, smoke tests, and PDF requirements. |
| [Concepts](docs/concepts.md) | Knowledge bases, DuckDB files, closed/open profiles, page chunks, and technical-result chunks. |
| [Search and evidence](docs/search-and-evidence.md) | BM25, search modes, answerability, and technical-result indexing. |
| [Tool reference](docs/tool-reference.md) | MCP tool input and output schemas. |
| [Development](docs/development.md) | Local data, tests, and Git ignore policy. |

## Development

```bash
npm run typecheck
npm run test:unit
```

Runtime data stays local and is ignored by Git:

```text
data/index/        DuckDB databases and catalog
data/pdfs/         optional PDF staging area
data/rendered/     rendered page cache
data/test_outputs/ test outputs
```

Next: [Quick start](docs/getting-started.md)
