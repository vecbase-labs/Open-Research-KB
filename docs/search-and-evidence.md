# Search and Evidence

[Home](../README.md) · [中文](search-and-evidence.zh-CN.md) · Previous: [Concepts](concepts.md) · Next: [Development](development.md)

## Default Retrieval

`search` defaults to:

```json
{
  "mode": "text"
}
```

This means DuckDB-backed BM25 text retrieval. It is the most stable and explainable path today.

## Search Modes

| Mode | Meaning |
|---|---|
| `text` | BM25 text retrieval. This is the current default. |
| `overlap` | Exploratory term-overlap retrieval. |
| `hybrid` | BM25 plus term overlap; not standard BM25 + vector hybrid retrieval. |
| `semantic` | Reserved for a future LanceDB vector side index. |
| `vector` | Deprecated alias for `semantic`. |

Embedding retrieval is not enabled by default. Semantic vector search requires an additional embedding side index and raises model choice, speed, reproducibility, and local compute questions.

## Answerability

OpenShelf does not treat "retrieved related text" as "the corpus supports the answer." Search results include answerability metadata:

| Status | Meaning | Recommended behavior |
|---|---|---|
| `supported` | Direct textual evidence was found. | Answer from cited evidence. |
| `related_only` | Related material was found, but it is not enough to support the answer. | Report the limitation, then ask or label independent reasoning. |
| `not_found` | No usable evidence was found. | State that the knowledge base has no evidence. |

This matters for research corpora, where related paragraphs, definitions, theorems, and conclusions are often not interchangeable.

Closed-corpus use cases usually require answers to come from corpus evidence, so answerability should be strict. Open-research corpora can allow additional reasoning, but the answer must separate what comes from the knowledge base from independent reasoning.

## Agent Decision Flow

OpenShelf is primarily used by an LLM agent with MCP tools. Users usually do not need to know which tool to call; they specify the knowledge base and question in natural language.

Recommended agent behavior:

1. Resolve the requested `db_name`, or ask the user to choose when multiple knowledge bases are available.
2. Call `search` or `search_terms` first, and use `search_technical_results` when structured theorem or definition retrieval is needed.
3. When `answerability.status` is `supported`, answer directly from cited evidence.
4. When the status is `related_only` or `not_found`, explain that direct corpus evidence is insufficient and ask whether the user allows further reasoning.
5. If the user allows further reasoning and the profile is `closed_corpus`, call `check_reasonable` before proceeding to audit whether the reasoning stays within the corpus boundary.
6. If the profile is `open_research`, independent reasoning may continue, but the answer must label the boundary between corpus evidence and independent reasoning.

This lets OpenShelf act not only as a retrieval layer, but also as an evidence boundary and reasoning-audit layer for agents.

## Top K and Metrics

`top_k` is the number of highest-ranked retrieval results returned after ranking. Common metrics include:

```text
Recall@1   whether gold evidence appears as the first result
Recall@5   whether gold evidence appears in the top 5
Recall@10  whether gold evidence appears in the top 10
MRR@10     reciprocal rank of the first relevant result within the top 10
```

These metrics are useful for evaluating whether a system finds the source text containing a gold answer. Technical-result indexes may return structured theorem, definition, or proof objects, so their objective is not identical to hitting gold-answer text and may need additional evaluation.

## Technical-Result Retrieval

For theorem, lemma, definition, proposition, and related structured objects:

1. Ingest PDFs normally to create page chunks.
2. After the user confirms that technical-result retrieval is needed, call `build_technical_index`.
3. Query structured results with `search_technical_results`.

This keeps technical results linked back to original chunks and pages for source inspection.

Previous: [Concepts](concepts.md) · Next: [Development](development.md)
