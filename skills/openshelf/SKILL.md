---
name: openshelf
description: Use OpenShelf MCP tools to create, register, search, and inspect local DuckDB-backed knowledge bases from PDFs, with strict evidence handling and closed/open corpus reasoning boundaries.
---

# OpenShelf

Use this skill when the user asks Codex to work with an OpenShelf knowledge base, search local PDFs, register or create a DuckDB knowledge base, inspect source evidence, or reason from a closed/open corpus boundary.

## Core Behavior

OpenShelf is an MCP-backed knowledge-base layer. Users should be able to ask in natural language, such as "use `research_corpus` to answer this question." The agent should choose tools and explain evidence status rather than asking the user to manually call every tool.

## Retrieval Flow

1. Resolve the target knowledge base. If multiple databases exist and the user has not named one, call `list_db` or ask the user to choose.
2. Search with `search` or `search_terms`. Use `search_technical_results` only when theorem, definition, proposition, or proof-level retrieval is relevant.
3. If `answerability.status` is `supported`, answer from the cited evidence and keep the answer grounded.
4. If `answerability.status` is `related_only` or `not_found`, state that the knowledge base does not provide enough direct evidence and ask whether the user wants independent reasoning.
5. If the user allows independent reasoning and the profile is closed corpus, call `check_reasonable` before continuing and report whether the reasoning stays within corpus boundaries.
6. If the profile is open research corpus, independent reasoning may continue, but clearly label what comes from the knowledge base and what is independent reasoning.

## Ingestion Flow

- Use `create_db` to create a new named knowledge base from a PDF file or folder.
- Use `create_db_from_exist` to register an existing OpenShelf `.duckdb` file without copying it or re-ingesting PDFs.
- Use `create_document` or `ingest_pdf` for additional searchable PDFs.
- By default, image-only PDFs are rejected unless OCR is explicitly requested.

## Technical Result Index

Regular ingestion creates page chunks. Term or technical-result chunks are optional and should be built only after the user asks for theorem, lemma, proposition, definition, or proof-level retrieval. Use `build_technical_index`, then query with `search_technical_results`.

## Evidence Discipline

Do not treat lexical similarity as direct support. Preserve the difference between:

- `supported`: direct evidence exists; answer from sources.
- `related_only`: related material exists but direct support is insufficient.
- `not_found`: no usable corpus evidence was found.
