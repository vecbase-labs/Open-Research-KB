# Repository Agent Guidelines

Use the repository's MCP tools and public APIs when working with the knowledge base. Do not bypass the server by reading DuckDB files, generated indexes, or cached artifacts directly unless the task is explicitly to debug storage internals.

## Knowledge Base Policy

When a user asks a question that should be grounded in an existing PDF corpus, search the configured knowledge base first. Treat retrieved evidence as the source of truth and cite the returned document, page, chunk, or evidence item in answers.

If direct evidence is not found, say so plainly. Only use independent reasoning when the user allows it or when the selected database profile permits labeled independent reasoning. Keep independent reasoning clearly separated from knowledge-base evidence.

## Multiple Knowledge Databases

This project can manage multiple physical DuckDB knowledge bases with a single MCP server. Different corpora are selected by `db_name`; `kb` is the MCP server name and must not be used as a database name.

General workflow:

1. If the user has not specified a database and multiple databases exist, call `list_db` and ask which `db_name` to use.
2. If the user specifies a database for the current session, call `set_active_db`.
3. Do not search across databases unless the user explicitly asks for cross-database search.
4. When searching multiple databases, report each database's evidence and answerability status separately.
5. If a tool returns `status: "db_selection_required"`, stop and ask the user to choose a database.

## Answering Rules

1. Answer from the knowledge base only when `answerability.status` is `supported` or the tool explicitly returns direct evidence.
2. Cite returned evidence locations; do not present weakly related material as direct support.
3. If the status is `related_only`, explain that the corpus contains only weakly related material and ask whether to proceed with independent reasoning.
4. If the status is `not_found`, explain that no usable evidence was found and ask whether to proceed independently.
5. When independent reasoning is used, label it as independent reasoning and do not imply it came from the corpus.

## Recommended Tool Flow

For natural-language technical or domain-specific questions, use `search_terms` first. Generate a small set of focused search queries that include both surface topic terms and the underlying technical objects or methods. For keyword lookups, use `search`. For source verification, use `get_chunk`, `get_page_text`, or `get_page_image`.

Use `check_reasonable` when an independent answer should be audited against a closed corpus profile.
