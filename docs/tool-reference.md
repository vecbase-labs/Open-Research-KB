# Tool Reference

[Home](../README.md) · [中文首页](../README.zh-CN.md) · [Quick start](getting-started.md) · [Concepts](concepts.md) · [Search and evidence](search-and-evidence.md)

## Tool Contracts

The server follows the official TypeScript SDK `McpServer.registerTool(...)` format from the npm dependency `@modelcontextprotocol/server`: each tool receives the fields below directly as its input schema.

All outputs are JSON text content containing the objects shown below.

Every tool output includes the physical knowledge-base identity:

```json
{
  "knowledge_base": {
    "name": "default",
    "duckdb_path": "<path-to-data>/index/kb_default.duckdb"
  }
}
```

This MCP server manages multiple physical DuckDB knowledge bases through `db_name`. Use `create_db` to create a new database, `create_db_from_exist` to register an existing OpenShelf DuckDB file, and `list_db` to inspect the available databases. When more than one database exists, search/read tools return `status: "db_selection_required"` unless `db_name` is specified.

`openshelf` is the MCP server name and is reserved; do not use `openshelf` as a `db_name`. A fresh install starts with a default database named `default`, stored at `data/index/kb_default.duckdb`. You can create additional databases such as `research_corpus` or `textbook_corpus` with `create_db`, or register an existing OpenShelf DuckDB file with `create_db_from_exist`.

```json
{
  "db_name": "textbook_corpus",
  "query": "quadratic function vertex form",
  "strict": true
}
```

```json
{
  "status": "db_selection_required",
  "must_specify_db_name": true,
  "can_set_active_db": true,
  "message": "More than one knowledge base is available. Select a db_name before searching or reading documents, or call set_active_db for this session.",
  "selection_ui": {
    "type": "single_select",
    "options": [
      { "index": 1, "label": "research_corpus", "value": "research_corpus" },
      { "index": 2, "label": "textbook_corpus", "value": "textbook_corpus" }
    ]
  },
  "available_databases": [
    { "name": "research_corpus", "duckdb_path": "/.../kb_research_corpus.duckdb" },
    { "name": "textbook_corpus", "duckdb_path": "/.../kb_textbook_corpus.duckdb" }
  ]
}
```

There is no implicit union search. If cross-database search is needed, call each `db_name` separately and report the results separately.

### `create_db`

Create a named DuckDB knowledge base. If `path` is null, the DB is empty. If `path` is a PDF file or directory containing PDFs, the tool creates the DB and ingests those documents.

Input:

```json
{
  "db_name": "textbook_corpus",
  "path": "<path-to-pdf-directory-or-file>",
  "tags": ["textbook"],
  "ocr": "never",
  "ocr_language": "eng",
  "ocr_dpi": 220,
  "ocr_max_pages": null,
  "chunk_size": 1200,
  "chunk_overlap": 180
}
```

Output includes `status: "created"`, the `db` record, the inferred knowledge-base `profile`, and per-document ingest results when `path` is provided. The profile is inferred from the concrete database name, source path, and tags; users do not need to provide allowed or forbidden methods.

The profile records the usage boundary for this database. For example, a textbook corpus may be inferred as `scope_policy: "closed_corpus"` with `method_boundary: "corpus_internal"`, meaning agents should treat the selected corpus itself as the boundary and should first look for corpus-internal method evidence before using external reasoning. A research corpus such as `research_corpus` may be inferred as `scope_policy: "open_research"`, where independent reasoning is allowed only when clearly labeled and separated from cited corpus evidence.

### `create_db_from_exist`

Register an existing OpenShelf DuckDB file as a named knowledge base. This tool only updates the catalog: it does not copy the DuckDB file, does not ingest PDFs, and does not mutate the source database. The file must already contain the OpenShelf knowledge-base tables.

Input:

```json
{
  "db_name": "shared_corpus",
  "duckdb_path": "/absolute/path/to/kb_shared_corpus.duckdb",
  "source_path": "/optional/original/corpus/folder",
  "tags": ["research"]
}
```

`db_name` is optional. If omitted, OpenShelf infers it from the DuckDB filename, stripping a leading `kb_` or `kb-` prefix.

Output includes `status: "registered"`, the catalog `db` record, document/page/chunk counts, schema validation details, and a `mutation_policy` confirming that the DuckDB file was not copied and documents were not ingested.

### `list_db`

List the physical DuckDB knowledge bases currently managed by this MCP server.

Input:

```json
{}
```

Output:

```json
{
  "databases": [
    {
      "name": "default",
      "duckdb_path": "<path-to-data>/index/kb_default.duckdb",
      "profile": {
        "scope_policy": "open_research",
        "method_boundary": "open_with_citations",
        "must_label_independent_reasoning": true
      },
      "counts": { "documents": 21, "pages": 3513, "chunks": 9712 }
    }
  ],
  "total": 1,
  "active_db_name": null,
  "requires_db_name_for_search": false
}
```

### `set_active_db`

Set the default database for this MCP server process/session. Use this when the user says "use this knowledge base for this conversation." Passing `null` clears the active database.

Input:

```json
{
  "db_name": "textbook_corpus"
}
```

### `create_document`

Recommended tool for adding a new local PDF to the knowledge base. It accepts searchable text PDFs, creates document metadata, page text records, chunk records, lexical term index rows, and embedding job rows in DuckDB. By default OCR is off, so scanned/image-only PDFs without an embedded text layer are rejected instead of silently indexed as empty documents.

`ocr` options:

| Value | Meaning |
|---|---|
| `never` | Only use embedded PDF text. |
| `auto` | Use embedded PDF text first; if a page has no text, try local OCR if available. |
| `required` | Fail if OCR is needed but unavailable. |

If a PDF produces no searchable text chunks, `create_document` rejects it and does not add it to the knowledge base. This usually means the PDF is scanned/image-only and needs a working OCR pipeline before ingestion.

The input and output schema is the same as `ingest_pdf`, with `ocr` defaulting to `never` and `require_searchable` defaulting to `true`.

### `ingest_pdf`

Ingest a local PDF into the knowledge base. The server does not copy the PDF into this repository. It stores the original absolute `source_path` plus a standard `canonical_pdf_name` (`<slugified-doc-id>-<sha256-first-8>.pdf`) in `data/index/kb.duckdb`, extracts page text with Poppler `pdftotext`, chunks the text, and writes DuckDB tables for documents, pages, chunks, chunk terms, and embedding job status. Each ingest gets its own temporary extraction directory, so concurrent ingests do not share page text temp files.

Input:

```json
{
  "pdf_path": "data/raw/book.pdf",
  "doc_id": null,
  "title": null,
  "authors": [],
  "tags": [],
  "force": false,
  "chunk_size": 1200,
  "chunk_overlap": 180,
  "render_pages": false,
  "ocr": "never",
  "ocr_language": "eng",
  "ocr_dpi": 220,
  "ocr_max_pages": null,
  "require_searchable": true
}
```

Fields:

| Field | Type | Required | Default | Meaning |
|---|---:|---:|---:|---|
| `pdf_path` | string | yes | - | Absolute path or path relative to the repository root. |
| `doc_id` | string or null | no | null | Stable document id. If omitted, generated from title and file hash. |
| `title` | string or null | no | null | Human title. If omitted, PDF metadata or filename is used. |
| `authors` | string[] | no | `[]` | Author names used in citations and filters. |
| `tags` | string[] | no | `[]` | Topic tags such as `game-theory` or `convex-analysis`. |
| `force` | boolean | no | `false` | Replace an existing document with the same `doc_id`. |
| `chunk_size` | integer | no | `1200` | Approximate characters per chunk. Range: 300-4000. |
| `chunk_overlap` | integer | no | `180` | Overlapping characters between adjacent chunks. Range: 0-1000. |
| `render_pages` | boolean | no | `false` | Pre-render page images during ingestion. |
| `ocr` | enum | no | `never` | One of `never`, `auto`, or `required`. |
| `ocr_language` | string | no | `eng` | Tesseract language code. |
| `ocr_dpi` | integer | no | `220` | DPI for page images sent to OCR. |
| `ocr_max_pages` | integer or null | no | null | Optional cap on OCR pages. |
| `require_searchable` | boolean | no | `true` | Reject and do not index PDFs that produce no searchable text chunks. |

Output:

```json
{
  "status": "ingested",
  "document": {
    "doc_id": "book-title-a1b2c3d4e5",
    "title": "Book Title",
    "authors": ["Author A"],
    "tags": ["topic"],
    "source_path": "/original/path/book.pdf",
    "canonical_pdf_name": "book-title-a1b2c3d4.pdf",
    "file_sha256": "...",
    "page_count": 300,
    "created_at": "2026-07-01 13:00:00"
  },
  "counts": {
    "pages": 300,
    "chunks": 950
  },
  "warnings": []
}
```

Rejected scanned/image-only PDF output:

```json
{
  "status": "rejected",
  "document": null,
  "rejected_document": {
    "doc_id": "probability-with-martingales-williams",
    "title": "Probability with Martingales",
    "source_path": "/original/path/Probability With Martingales(Williams).pdf",
    "page_count": 265
  },
  "counts": {
    "pages": 265,
    "pages_with_text": 0,
    "chunks": 0,
    "ocr_attempted_pages": 3,
    "ocr_succeeded_pages": 0
  },
  "index_status": "not_indexed",
  "rejection_reason": "no_searchable_text",
  "diagnosis": "The PDF appears to be scanned/image-only or otherwise has no extractable text. This knowledge base currently accepts searchable text PDFs; scanned PDFs require a working OCR pipeline before they can be indexed.",
  "warnings": [
    "No extractable text chunks were found. The document was not added to the knowledge base."
  ]
}
```

### `list_documents`

List documents already indexed.

Input:

```json
{
  "query": null,
  "tags": null,
  "limit": 50,
  "offset": 0
}
```

Fields:

| Field | Type | Required | Default | Meaning |
|---|---:|---:|---:|---|
| `query` | string or null | no | null | Case-insensitive substring over title, authors, or source path. |
| `tags` | string[] or null | no | null | Require every listed tag. |
| `limit` | integer | no | `50` | Page size. Range: 1-200. |
| `offset` | integer | no | `0` | Pagination offset. |

Output:

```json
{
  "documents": [
    {
      "doc_id": "book-title-a1b2c3d4e5",
      "title": "Book Title",
      "authors": ["Author A"],
      "tags": ["topic"],
      "source_path": "/original/path/book.pdf",
      "canonical_pdf_name": "book-title-a1b2c3d4.pdf",
      "file_sha256": "...",
      "page_count": 300,
      "created_at": "2026-07-01 13:00:00"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

### `search`

Search chunks using DuckDB-backed BM25 text retrieval by default. Optional modes include term-overlap retrieval and reserved semantic retrieval; semantic retrieval only participates after embeddings have been generated and synced.

Default search is deliberately conservative. `answerability.status` is fixed to three product states:

| Status | Meaning | Agent behavior |
|---|---|---|
| `supported` | The knowledge base has direct textual evidence. | Answer only from the cited evidence. |
| `related_only` | The knowledge base has weakly related material, but it cannot support the requested answer. | Report the weak relation and ask before using independent model reasoning. |
| `not_found` | The knowledge base has no usable match. | Report no KB evidence and ask before using independent model reasoning. |

`mode: "overlap"` is exploratory term-set overlap, not embeddings. `mode: "semantic"` is reserved for LanceDB side-index recall. Deprecated `mode: "vector"` inputs are accepted as an alias for `semantic` and return a warning.

Ranking uses BM25 over indexed chunks. The implementation extracts query terms, filters common stopwords, computes document frequency over the filtered chunk set, and scores matches with `k1 = 1.5` and `b = 0.75`. BM25 controls ranking only; the `strict` evidence gate still controls whether the tool may return anything at all.

Chinese queries are handled lexically. If the query contains English or technical-symbol terms, those remain the main key terms and CJK bigram/trigram terms are added as auxiliary search terms. If no English or technical-symbol terms can be extracted, the server uses continuous CJK bigram/trigram terms as key terms and returns a warning. If no usable terms can be extracted at all, the response returns `not_found` with a warning instead of silently running a meaningless search.

After BM25, the server grades the evidence:

| Grade | Meaning | Strict default behavior |
|---|---|---|
| `exact_phrase` | A compound phrase from the query, such as `di-martingale`, is matched directly. | Return results as `supported`. |
| `all_key_terms` | All extracted key terms are matched. | Return results as `supported`. |
| `partial_terms` | Only some key terms are matched. | Return `related_only`; include `partial_results` only for inspection. |
| `none` | No key terms are matched. | Return `not_found`. |

This is intentionally stricter than “at least one term matched.” For example, a hit on `martingale` alone should not count as direct evidence for `di-martingale`.

Input:

```json
{
  "query": "fixed point theorem",
  "mode": "text",
  "top_k": 8,
  "filters": {
    "doc_id": null,
    "tags": null
  },
  "context_window": 0,
  "include_text": true,
  "strict": true
}
```

Fields:

| Field | Type | Required | Default | Meaning |
|---|---:|---:|---:|---|
| `query` | string | yes | - | Natural-language or keyword query. |
| `mode` | enum | no | `text` | One of `text`, `hybrid`, `overlap`, or `semantic`. Deprecated `vector` is treated as `semantic`. |
| `top_k` | integer | no | `8` | Maximum number of results. Range: 1-50. |
| `filters.doc_id` | string or null | no | null | Restrict to one document. |
| `filters.tags` | string[] or null | no | null | Require every listed document tag. |
| `context_window` | integer | no | `0` | Neighbor chunks to include on each side. Range: 0-5. |
| `include_text` | boolean | no | `true` | Include matched chunk text in results. |
| `strict` | boolean | no | `true` | Return only direct textual evidence as answerable `results`; weak matches become `related_only`, not answerable evidence. |

Output:

```json
{
  "query": "fixed point theorem",
  "mode": "text",
  "results": [
    {
      "chunk_id": "book-title-a1b2c3d4e5:p12:c0",
      "doc_id": "book-title-a1b2c3d4e5",
      "title": "Book Title",
      "page": 12,
      "score": 1.5,
      "bm25_score": 10.02,
      "match_type": "text",
      "citation": "Author A, Book Title, p. 12",
      "text": "...",
      "context": []
    }
  ]
}
```

When `strict` is true and no evidence is found, output has empty results:

```json
{
  "query": "di-martingale terminal hitting set",
  "mode": "text",
  "strict": true,
  "results": [],
  "answerability": {
    "status": "not_found",
    "evidence_grade": "none",
    "can_answer_from_kb": false,
    "must_ask_user_before_reasoning": true,
    "allowed_next_steps": [
      "report_no_direct_kb_answer",
      "ask_user_before_independent_reasoning"
    ],
    "message": "No direct textual evidence was found in the indexed knowledge base. Do not answer by analogy to unrelated sources; ask the user whether to proceed with general AI reasoning.",
    "matched_terms": [],
    "missing_terms": ["di-martingale", "dimartingale", "martingale"],
    "query_terms": ["di-martingale", "dimartingale", "martingale"]
  }
}
```

When only partial terms are found, the tool reports partial evidence but does not expose it as answerable evidence:

```json
{
  "query": "assignment dimartingale",
  "mode": "text",
  "strict": true,
  "results": [],
  "partial_results": [
    {
      "chunk_id": "sample-technical-reference:p28:c0",
      "matched_terms": ["assignment"]
    }
  ],
  "answerability": {
    "status": "related_only",
    "evidence_grade": "partial_terms",
    "can_answer_from_kb": false,
    "must_ask_user_before_reasoning": true,
    "allowed_next_steps": [
      "report_no_direct_kb_answer",
      "ask_user_before_independent_reasoning"
    ],
    "matched_terms": ["assignment"],
    "missing_terms": ["dimartingale"]
  }
}
```

### `search_terms`

Two-stage workflow for natural-language technical or domain-specific questions, especially descriptions whose useful search terms require domain interpretation. The MCP server does not call an LLM itself. Instead, it asks the connected agent to use its own model capability to infer both the surface topic and the latent technical structure, generate search queries, then searches those queries locally.

First call, without `suggested_queries`:

```json
{
  "problem": "Given two populations with types x and y and a surplus function c(x,y)=x^2*y, how should the planner assign pairs?",
  "top_k": 3,
  "filters": {
    "doc_id": "sample-technical-reference"
  },
  "strict": true
}
```

Output:

```json
{
  "workflow_status": "needs_query_rewrite",
  "requires_llm_rewrite": true,
  "results": [],
  "message": "The MCP server does not semantically rewrite natural-language technical or domain-specific questions. The agent should use its LLM capability to generate search queries, then call this tool again with suggested_queries.",
  "rewrite_instructions": [
    "First infer the latent technical structure behind the user problem: state variables, types, messages, histories, beliefs, feasible actions, constraints, and objective.",
    "Identify any hidden stochastic process, feasibility condition, result type, definition, or standard technical object that may govern the problem, such as posterior martingales, Bayes plausibility, splitting lemmas, filtrations, convexity, fixed points, duality, monotonicity, or comparative statics.",
    "Generate 3-5 concise English/technical search queries that mix surface-topic terms with technical terms.",
    "Include exact formulas, named structures, and inferred technical objects when useful."
  ]
}
```

Second call, after the agent uses its LLM to generate queries:

```json
{
  "problem": "Given two populations with types x and y and a surplus function c(x,y)=x^2*y, how should the planner assign pairs?",
  "suggested_queries": [
    "positive assortative matching supermodular surplus assignment problem",
    "structured assignment problem optimal matching",
    "matching workers firms surplus assignment problem",
    "submodularity supermodularity increasing differences optimal matching theorem"
  ],
  "top_k": 3,
  "filters": {
    "doc_id": "sample-technical-reference"
  },
  "context_window": 1,
  "include_text": false,
  "include_evidence_pages": true,
  "max_evidence_pages": 5,
  "strict": true
}
```

Output includes one `search` result per generated query, plus `evidence_pages` containing the full text of pages hit by direct evidence. The agent should read these pages before deciding whether the evidence is relevant enough for the next reasoning step.

```json
{
  "workflow_status": "supported",
  "requires_llm_rewrite": false,
  "suggested_queries": ["..."],
  "evidence_pages": [
    {
      "page": 52,
      "citation": "Sample Technical Reference, p. 52",
      "matched_queries": ["positive assortative matching supermodular surplus assignment problem"],
      "matched_terms": ["assortative", "matching", "supermodular"],
      "text": "One-Dimensional Case ... when Φ is supermodular, it is optimal to match the higher types with the higher types ..."
    }
  ],
  "query_results": [
    {
      "query": "positive assortative matching supermodular surplus assignment problem",
      "answerability": {
        "status": "supported"
      },
      "results": []
    }
  ]
}
```

### `get_chunk`

Fetch one chunk by id, optionally with neighbor chunks and a rendered page image.

Input:

```json
{
  "chunk_id": "book-title-a1b2c3d4e5:p12:c0",
  "context_window": 2,
  "include_page_image": false
}
```

Fields:

| Field | Type | Required | Default | Meaning |
|---|---:|---:|---:|---|
| `chunk_id` | string | yes | - | Chunk id returned by `search`. |
| `context_window` | integer | no | `0` | Neighbor chunks on each side. Range: 0-10. |
| `include_page_image` | boolean | no | `false` | Render/fetch the PDF page image. |

Output:

```json
{
  "chunk": {
    "chunk_id": "book-title-a1b2c3d4e5:p12:c0",
    "doc_id": "book-title-a1b2c3d4e5",
    "page": 12,
    "chunk_index": 31,
    "text": "...",
    "title": "Book Title",
    "citation": "Author A, Book Title, p. 12"
  },
  "context": [
    {
      "chunk_id": "book-title-a1b2c3d4e5:p11:c1",
      "doc_id": "book-title-a1b2c3d4e5",
      "page": 11,
      "chunk_index": 30,
      "text": "..."
    }
  ],
  "page_image": {
    "doc_id": "book-title-a1b2c3d4e5",
    "title": "Book Title",
    "page": 12,
    "image_path": "/repo/data/rendered/book-title-a1b2c3d4e5/page-0012-180dpi.png",
    "mime_type": "image/png",
    "citation": "Author A, Book Title, p. 12"
  }
}
```

`page_image` is only present when `include_page_image` is true.

### `get_page_text`

Return extracted text for a 1-based PDF page.

Input:

```json
{
  "doc_id": "book-title-a1b2c3d4e5",
  "page": 12,
  "include_chunks": false
}
```

Fields:

| Field | Type | Required | Default | Meaning |
|---|---:|---:|---:|---|
| `doc_id` | string | yes | - | Document id. |
| `page` | integer | yes | - | 1-based PDF page number. |
| `include_chunks` | boolean | no | `false` | Include chunk records located on the page. |

Output:

```json
{
  "doc_id": "book-title-a1b2c3d4e5",
  "title": "Book Title",
  "page": 12,
  "text": "...",
  "citation": "Author A, Book Title, p. 12",
  "chunks": [
    {
      "chunk_id": "book-title-a1b2c3d4e5:p12:c0",
      "doc_id": "book-title-a1b2c3d4e5",
      "page": 12,
      "chunk_index": 31,
      "text": "..."
    }
  ]
}
```

`chunks` is only present when `include_chunks` is true.

### `get_page_image`

Render or fetch a cached image for a 1-based PDF page.

Input:

```json
{
  "doc_id": "book-title-a1b2c3d4e5",
  "page": 12,
  "dpi": 180,
  "image_format": "png",
  "force": false
}
```

Fields:

| Field | Type | Required | Default | Meaning |
|---|---:|---:|---:|---|
| `doc_id` | string | yes | - | Document id. |
| `page` | integer | yes | - | 1-based PDF page number. |
| `dpi` | integer | no | `180` | Render DPI. Range: 72-400. |
| `image_format` | enum | no | `png` | One of `png`, `jpg`, or `jpeg`. |
| `force` | boolean | no | `false` | Regenerate image even if cached. |

Output:

```json
{
  "doc_id": "book-title-a1b2c3d4e5",
  "title": "Book Title",
  "page": 12,
  "image_path": "/repo/data/rendered/book-title-a1b2c3d4e5/page-0012-180dpi.png",
  "mime_type": "image/png",
  "citation": "Author A, Book Title, p. 12"
}
```

## Notes

This server is intentionally a knowledge-base evidence retriever. It should not force unrelated user questions onto whatever books happen to be indexed. The expected workflow is:

1. Search the indexed knowledge base.
2. If `answerability.status` is `related_only`, report that the material is weakly related but not sufficient for an answer.
3. If `answerability.status` is `not_found`, report that no direct evidence was found.
4. Ask the user whether to proceed with independent model reasoning, clearly separated from the knowledge-base result.

The current implementation uses Poppler (`pdftotext`, `pdfinfo`, `pdftoppm`) and a DuckDB index. Install Poppler before ingestion if those commands are missing.

## Storage Architecture

Each knowledge database is a separate DuckDB file, for example `data/index/kb_research_corpus.duckdb` or `data/index/kb_textbook_corpus.duckdb`. Database-level profiles live in `data/index/db_catalog.json`; they describe how the corpus should constrain answer generation and do not modify the DuckDB content. Each DuckDB stores:

- `documents`: one metadata record per PDF, including the original `source_path` and standard `canonical_pdf_name`.
- `pages`: extracted text for each page.
- `chunks`: search chunks used by BM25 and evidence lookup.
- `chunk_terms`: normalized lexical terms and frequencies per chunk.
- `embedding_jobs`: per-chunk embedding status keyed by `chunk_id` and `content_hash`.
- `semantic_index`: metadata for LanceDB side-index entries once embeddings are generated.

The original PDFs are not copied into this repository. Page images are generated on demand from `source_path` and cached under `data/rendered`.

DuckDB is the canonical store for corpus data, so extracted text, chunks, terms, and metadata are stored as structured tables rather than a monolithic JSON file.

Recommended scaling path:

- Use DuckDB as the canonical source of truth for documents, pages, chunks, metadata, lexical terms, and answerability evidence.
- Use LanceDB only as a derived semantic side index keyed by `chunk_id`, `embedding_model`, and `content_hash`.
- Query flow should be: DuckDB BM25 candidates + LanceDB semantic candidates -> merge by `chunk_id` in TypeScript -> hydrate canonical rows from DuckDB -> apply evidence gate.
- LanceDB matches alone should not produce `supported`; they can surface candidate pages, but direct support must still be verified against DuckDB text evidence.
