# OpenShelf

[中文说明](README.zh-CN.md)

OpenShelf is a local-first MCP server for building and querying PDF knowledge bases. It indexes PDFs into DuckDB, exposes evidence-grounded retrieval tools, and helps agents separate corpus-backed answers from independent reasoning.

## Features

- Ingest PDFs with an embedded text layer into local DuckDB knowledge bases.
- Manage multiple named databases with `db_name`.
- Use DuckDB-backed BM25 text search by default.
- Search chunks with conservative answerability labels: `supported`, `related_only`, and `not_found`.
- Retrieve source chunks, page text, and rendered page images for citation checks.
- Audit independent reasoning against closed-corpus profiles with `check_reasonable`.
- Keep PDFs and generated indexes local; repository data directories are ignored by default.

## Quick Start

Install dependencies:

```bash
npm install
```

Run the MCP server over stdio:

```bash
npm run openshelf-mcp
```

Add a PDF:

```bash
npm run create-document -- '{"pdf_path":"<path-to-book.pdf>","title":"Book Title","authors":["Author"],"tags":["book"]}'
```

Run the optional smoke test with any searchable sample PDF:

```bash
KB_MCP_SMOKE_PDF=<path-to-sample.pdf> npm run smoke:pdf
```

## Codex MCP Setup

Add the server to your Codex MCP config:

```toml
[mcp_servers.openshelf]
command = "npm"
args = ["--prefix", "/path/to/OpenShelf", "run", "--silent", "openshelf-mcp"]
```

A fresh install starts with a default database named `default`, stored at `data/index/kb_default.duckdb`. Use `create_db` if you want additional databases such as `research_corpus` or `textbook_corpus`.

## Common Workflow

1. Add PDFs with `create_document` or `ingest_pdf`.
2. Search the corpus with `search` or `search_terms`.
3. Inspect source evidence with `get_chunk`, `get_page_text`, or `get_page_image`.
4. Answer from the corpus only when `answerability.status` is `supported`.
5. If evidence is weak or missing, label any independent reasoning clearly and use `check_reasonable` when a closed corpus profile should constrain the answer.

## PDF Ingestion Requirements

By default, the system only accepts PDFs whose text can be extracted directly. LaTeX-generated papers and ebooks with an embedded text layer usually work. Scanned PDFs, image-only PDFs, and PDFs whose text cannot be copied and pasted are rejected with:

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

If you need to process scanned PDFs, explicitly enable OCR:

```json
{
  "ocr": "auto"
}
```

OCR depends on local Tesseract, and results may be unreliable for formulas, tables, and complex layouts.

## Tools

| Tool | Purpose |
|---|---|
| `create_db` | Create a named DuckDB knowledge base, optionally ingesting a PDF file or directory. |
| `list_db` | List available databases and their profiles. |
| `set_active_db` | Set the session default database. |
| `create_document` | Add one searchable PDF with stricter defaults for user-facing ingestion. |
| `ingest_pdf` | Ingest a local PDF into a selected database. |
| `list_documents` | List indexed documents with optional title/path/tag filters. |
| `search` | Search chunks and return answerability metadata. |
| `search_terms` | Two-stage search workflow for technical/domain natural-language questions. |
| `check_reasonable` | Check whether independent reasoning stays within a selected corpus scope. |
| `build_technical_index` | Preview or build extracted technical-term results. |
| `search_technical_results` | Search extracted technical-term results and nearby definitions. |
| `get_chunk` | Fetch one chunk with optional neighbors and page image. |
| `get_page_text` | Return extracted text for one PDF page. |
| `get_page_image` | Render or fetch a cached page image. |

See [docs/tool-reference.md](docs/tool-reference.md) for full input and output schemas.

## Search Modes

`search` defaults to:

```json
{
  "mode": "text"
}
```

This means DuckDB-backed BM25 text retrieval. Supported modes:

| Mode | Meaning |
|---|---|
| `text` | BM25 text retrieval. This is the current default. |
| `overlap` | Exploratory term-overlap retrieval. |
| `hybrid` | BM25 plus term-overlap retrieval. This is not standard BM25 + vector hybrid retrieval. |
| `semantic` | Reserved for a future LanceDB vector side index; it only participates after embeddings have been built. |
| `vector` | Deprecated alias for `semantic`. |

The stable path today is `text`. Semantic vector search and reranking are future advanced features, not default behavior.

## Evidence Policy

OpenShelf is intentionally conservative. A lexical hit is not automatically enough to answer a question.

| Status | Meaning | Recommended agent behavior |
|---|---|---|
| `supported` | Direct textual evidence was found. | Answer from cited evidence. |
| `related_only` | Weakly related material was found, but it is not enough to support the answer. | Report the limitation before independent reasoning. |
| `not_found` | No usable evidence was found. | Ask before using independent reasoning. |

## Term / Technical Result Index

Regular ingestion creates:

```text
documents
pages
chunks
chunk_terms
embedding_jobs
```

If you need structured retrieval over theorem, lemma, definition, proposition, and related result objects, call `build_technical_index` separately. It creates:

```text
technical_results
technical_result_links
```

This index is designed for theorem, definition, proposition, and proof-oriented retrieval. It should not be evaluated only with ordinary RAG gold-answer recall.

## Storage

Runtime data is local and ignored by Git:

```text
data/index/      DuckDB databases and database catalog
data/pdfs/       optional local PDF staging area
data/rendered/   cached page images
data/test_outputs/
```

Each database is a separate DuckDB file, for example `data/index/kb_default.duckdb`. The original PDFs are not copied into the repository during ingestion; their source paths are stored in the database metadata. Page images are generated on demand and cached under `data/rendered`.

Install Poppler before ingestion:

```text
pdftotext
pdfinfo
pdftoppm
```

If OCR is needed, install and configure Tesseract as well.

## Development

```bash
npm run typecheck
npm run test:unit
```

The repository intentionally excludes generated PDFs, images, DuckDB files, rendered pages, logs, local environments, and `node_modules`.
