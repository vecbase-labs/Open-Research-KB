# Concepts

[Home](../README.md) · [中文](concepts.zh-CN.md) · Previous: [Quick start](getting-started.md) · Next: [Search and evidence](search-and-evidence.md)

## Knowledge Base

An OpenShelf knowledge base maps to one physical DuckDB file. Multiple knowledge bases are isolated. OpenShelf does not run implicit union search across databases.

Common fields:

```text
db_name      logical name, such as default or research_corpus
duckdb_path  physical DuckDB file path
source_path  optional original corpus folder
profile      closed/open corpus-boundary and reasoning policy metadata
```

If more than one database exists, search and read tools require `db_name`, unless the session default has been set with `set_active_db`.

## DuckDB File

OpenShelf stores documents, pages, chunks, term statistics, and optional technical-result indexes in DuckDB. A knowledge base can be shared as a `.duckdb` file:

```json
{
  "db_name": "shared_corpus",
  "duckdb_path": "/path/to/kb_shared_corpus.duckdb"
}
```

When registering an existing database, OpenShelf validates the required tables. Registration does not copy the file or re-ingest documents.

## Page Chunks

Regular ingestion creates:

```text
documents
pages
chunks
chunk_terms
embedding_jobs
semantic_index
```

Page chunks are the default retrieval objects. They are produced by splitting extracted PDF page text and are best suited for judging whether a source directly supports a question.

## Closed Corpus and Open Research Corpus

OpenShelf records the corpus boundary in the knowledge-base profile. This boundary does not change database content, but it guides how agents should interpret retrieval results.

| Type | Meaning | Recommended behavior |
|---|---|---|
| `closed_corpus` | The user wants answers to come strictly from this knowledge base, such as textbooks, course material, or internal documents. | Answer only when direct evidence is sufficient; otherwise state that the corpus does not support the answer. |
| `open_research` | The knowledge base is part of a broader research context, such as a paper library or project literature corpus. | Independent reasoning is allowed only when clearly labeled and separated from corpus evidence. |
| `hybrid` | The corpus boundary is ambiguous and may need both internal evidence and additional reasoning. | Search corpus evidence first; ask before continuing when evidence is insufficient. |

OpenShelf infers the profile from `db_name`, `source_path`, and `tags`. Textbook-like names are more likely to be treated as closed corpus; research corpora are more likely to be treated as open research corpus. Users can make the intended boundary clearer through names and tags.

## Technical-Result Chunks

Technical-result chunks are not the default answer material created during ingestion. They are an optional structured index that users choose to build after ingestion. Regular ingestion creates page chunks first; when theorem, definition, proposition, or proof-level retrieval is needed, call `build_technical_index`.

Technical-result chunks are designed for theory-heavy documents, including:

```text
theorem
lemma
proposition
definition
corollary
assumption
proof
```

After `build_technical_index` writes the index, OpenShelf stores:

```text
technical_results
technical_result_links
```

A technical result usually contains a structured title, result type, page range, statement, proof, linked chunk ids, and nearby terms. It is useful for theorem, definition, proposition, and proof-dependency retrieval. It should not be evaluated only with ordinary RAG gold-answer recall.

## Profile

A profile is the machine-readable record of the closed/open boundary:

- A textbook corpus behaves like a closed corpus; answers should stay close to corpus evidence.
- A research-paper corpus behaves more like open research context; independent reasoning can be used only when labeled.

Profiles do not mutate DuckDB content. They help agents decide when to answer, when to report insufficient evidence, and when to ask before using external reasoning.

Previous: [Quick start](getting-started.md) · Next: [Search and evidence](search-and-evidence.md)
