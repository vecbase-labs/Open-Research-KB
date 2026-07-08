# Development

[Home](../README.md) · [中文](development.zh-CN.md) · Previous: [Search and evidence](search-and-evidence.md)

## Common Commands

```bash
npm run typecheck
npm run test:unit
```

Optional smoke test:

```bash
KB_MCP_SMOKE_PDF=<path-to-sample.pdf> npm run smoke:pdf
```

## Local Data

Runtime data stays local and is ignored by Git:

```text
data/index/        DuckDB databases and database catalog
data/pdfs/         optional PDF staging area
data/rendered/     cached page images
data/test_outputs/ test outputs
```

Each knowledge base is a separate DuckDB file, for example:

```text
data/index/kb_default.duckdb
```

## Ingestion Dependencies

PDF text extraction depends on Poppler:

```text
pdftotext
pdfinfo
pdftoppm
```

OCR depends on Tesseract, but it is disabled by default. Prefer PDFs with embedded text.

## Code Boundaries

Main code areas:

```text
src-ts/server.ts  MCP tool registration
src-ts/store.ts   ingestion, retrieval, DuckDB catalog, evidence checks
tests/            unit tests
scripts/          smoke tests and helper scripts
docs/             user documentation and tool reference
```

## Git Policy

Do not commit:

```text
node_modules/
data/index/*.duckdb
data/rendered/
data/test_outputs/
local logs and env files
```

To share a knowledge base, share the `.duckdb` file and register it with `create_db_from_exist`.

Previous: [Search and evidence](search-and-evidence.md) · Back to: [Home](../README.md)
