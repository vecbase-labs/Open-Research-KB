import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import {
  buildTechnicalIndex,
  checkReasonable,
  createDb,
  getChunk,
  getPageText,
  ingestPdf,
  listDb,
  listDocuments,
  renderPage,
  search,
  searchTerms,
  searchTechnicalResults,
  setActiveDb,
} from './store.js';

function jsonText(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

function createServer(): McpServer {
  const server = new McpServer({
    name: 'kb',
    version: '0.1.0',
  });

  server.registerTool(
    'create_db',
    {
      title: 'Create DB',
      description: 'Create a named DuckDB knowledge base. If path is a PDF or directory of PDFs, ingest those documents into the new DB; if path is null, create an empty DB.',
      inputSchema: z.object({
        db_name: z.string().nullable().default(null).describe('Knowledge-base name, e.g. research_corpus or textbook_corpus. If omitted, inferred from path or date.'),
        path: z.string().nullable().default(null).describe('Optional PDF file or directory containing PDFs. Null creates an empty DB.'),
        tags: z.array(z.string()).default([]).describe('Tags applied to documents ingested from path.'),
        ocr: z.enum(['never', 'auto', 'required']).default('auto'),
        ocr_language: z.string().default('eng'),
        ocr_dpi: z.number().int().min(120).max(400).default(220),
        ocr_max_pages: z.number().int().min(1).max(2000).nullable().default(null),
        chunk_size: z.number().int().min(300).max(4000).default(1200),
        chunk_overlap: z.number().int().min(0).max(1000).default(180),
      }),
    },
    async input => jsonText(await createDb(input)),
  );

  server.registerTool(
    'list_db',
    {
      title: 'List DB',
      description: 'List all DuckDB knowledge bases managed by this single kb MCP server.',
      inputSchema: z.object({}),
    },
    async () => jsonText(await listDb()),
  );

  server.registerTool(
    'set_active_db',
    {
      title: 'Set Active DB',
      description: 'Set or clear the default knowledge database for this MCP server process/session. Subsequent tool calls may omit db_name.',
      inputSchema: z.object({
        db_name: z.string().nullable().default(null).describe('Knowledge-base name to use by default. Null clears the active DB.'),
      }),
    },
    async input => jsonText(await setActiveDb(input)),
  );

  server.registerTool(
    'create_document',
    {
      title: 'Create Document',
      description: 'Add one new searchable local PDF to the knowledge base. Text PDFs are accepted; scanned/image-only PDFs without usable OCR text are rejected and not indexed.',
      inputSchema: z.object({
        db_name: z.string().nullable().default(null).describe('Target knowledge-base name. Required when more than one DB exists.'),
        pdf_path: z.string().describe('Absolute path or path relative to the repository root.'),
        doc_id: z.string().nullable().default(null).describe('Stable document id. Defaults to a slug plus content hash.'),
        title: z.string().nullable().default(null).describe('Human title. Defaults to filename.'),
        authors: z.array(z.string()).default([]).describe('Optional author names.'),
        tags: z.array(z.string()).default([]).describe('Optional topic tags, e.g. book, paper, probability.'),
        force: z.boolean().default(false).describe('Replace an existing document with the same doc_id.'),
        chunk_size: z.number().int().min(300).max(4000).default(1200).describe('Approximate characters per chunk.'),
        chunk_overlap: z.number().int().min(0).max(1000).default(180).describe('Overlapping characters between adjacent chunks.'),
        render_pages: z.boolean().default(false).describe('Render page images during ingestion.'),
        ocr: z.enum(['never', 'auto', 'required']).default('auto').describe('OCR policy for pages with no extractable text. auto tries OCR if available; required fails if OCR is unavailable.'),
        ocr_language: z.string().default('eng').describe('Tesseract language code.'),
        ocr_dpi: z.number().int().min(120).max(400).default(220).describe('DPI for page images sent to OCR.'),
        ocr_max_pages: z.number().int().min(1).max(2000).nullable().default(null).describe('Optional cap on pages OCR may process.'),
        require_searchable: z.boolean().default(true).describe('Reject and do not index PDFs that produce no searchable text chunks.'),
      }),
    },
    async input => jsonText(await ingestPdf(input)),
  );

  server.registerTool(
    'ingest_pdf',
    {
      title: 'Ingest PDF',
      description: 'Ingest a local PDF into the knowledge base.',
      inputSchema: z.object({
        db_name: z.string().nullable().default(null).describe('Target knowledge-base name. Required when more than one DB exists.'),
        pdf_path: z.string().describe('Absolute path or path relative to the repository root.'),
        doc_id: z.string().nullable().default(null).describe('Stable document id. Defaults to a slug plus content hash.'),
        title: z.string().nullable().default(null).describe('Human title. Defaults to PDF metadata or filename.'),
        authors: z.array(z.string()).default([]).describe('Optional author names.'),
        tags: z.array(z.string()).default([]).describe('Optional topic tags.'),
        force: z.boolean().default(false).describe('Replace an existing document with the same doc_id.'),
        chunk_size: z.number().int().min(300).max(4000).default(1200).describe('Approximate characters per chunk.'),
        chunk_overlap: z.number().int().min(0).max(1000).default(180).describe('Overlapping characters between adjacent chunks.'),
        render_pages: z.boolean().default(false).describe('Render page images during ingestion.'),
        ocr: z.enum(['never', 'auto', 'required']).default('never').describe('OCR policy for pages with no extractable text.'),
        ocr_language: z.string().default('eng').describe('Tesseract language code.'),
        ocr_dpi: z.number().int().min(120).max(400).default(220),
        ocr_max_pages: z.number().int().min(1).max(2000).nullable().default(null),
        require_searchable: z.boolean().default(false).describe('When true, reject and do not index PDFs that produce no searchable text chunks.'),
      }),
    },
    async input => jsonText(await ingestPdf(input)),
  );

  server.registerTool(
    'list_documents',
    {
      title: 'List Documents',
      description: 'List documents already available in the knowledge base.',
      inputSchema: z.object({
        db_name: z.string().nullable().default(null).describe('Knowledge-base name. Required when more than one DB exists.'),
        query: z.string().nullable().default(null).describe('Case-insensitive title/author/path substring.'),
        tags: z.array(z.string()).nullable().default(null).describe('Require documents to have every listed tag.'),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      }),
    },
    async input => jsonText(await listDocuments(input)),
  );

  server.registerTool(
    'search',
    {
      title: 'Search',
      description: 'Search PDF chunks for direct evidence. By default strict=true returns no overlap-only exploratory matches.',
      inputSchema: z.object({
        db_name: z.string().nullable().default(null).describe('Knowledge-base name to search. Required when more than one DB exists.'),
        query: z.string().describe('Natural-language or keyword query.'),
        mode: z.enum(['hybrid', 'text', 'overlap', 'semantic', 'vector']).default('hybrid').describe('Use text for DuckDB BM25, overlap for exploratory term overlap, semantic for LanceDB side-index recall when populated. vector is a deprecated alias for semantic.'),
        retrieval_profile: z.enum(['strict_evidence', 'research_context', 'exploratory_bibliography']).default('strict_evidence').describe('strict_evidence preserves old answerability behavior; research_context/exploratory_bibliography also return structured evidence items for later reasoning.'),
        top_k: z.number().int().min(1).max(50).default(8),
        max_items: z.number().int().min(1).max(80).optional().describe('Final item/result limit for research_context output.'),
        filters: z
          .object({
            doc_id: z.string().nullable().default(null).describe('Restrict results to one document.'),
            tags: z.array(z.string()).nullable().default(null).describe('Require documents to have every listed tag.'),
          })
          .default({ doc_id: null, tags: null }),
        context_window: z.number().int().min(0).max(5).default(0).describe('Neighbor chunks to include on each side.'),
        include_text: z.boolean().default(true),
        evidence_text_tokens: z.number().int().min(100).max(2000).default(900).describe('Approximate max tokens for evidence_text in structured research items.'),
        strict: z
          .boolean()
          .default(true)
          .describe('When true, return only direct textual evidence; do not use overlap-only exploratory matches.'),
      }),
    },
    async input => jsonText(await search(input)),
  );

  server.registerTool(
    'search_terms',
    {
      title: 'Search Terms',
      description: 'Two-stage workflow for natural-language technical or domain-specific questions: first ask the agent to rewrite into search queries, then search those generated queries for direct evidence.',
      inputSchema: z.object({
        db_name: z.string().nullable().default(null).describe('Knowledge-base name to search. Required when more than one DB exists.'),
        problem: z.string().describe('Original natural-language technical or domain-specific question from the user.'),
        suggested_queries: z.array(z.string()).optional().describe('3-5 English/technical queries generated by the agent using its LLM capability, mixing surface-topic terms with inferred technical objects and tools. Omit on the first call.'),
        retrieval_profile: z.enum(['strict_evidence', 'research_context', 'exploratory_bibliography']).default('strict_evidence').describe('strict_evidence only judges direct support; research_context returns a longer evidence packet; exploratory_bibliography is broader still.'),
        top_k: z.number().int().min(1).max(50).default(5),
        per_query_top_k: z.number().int().min(1).max(50).optional().describe('Number of chunks recalled per generated query before cross-query deduplication.'),
        max_items: z.number().int().min(1).max(80).default(20).describe('Final structured evidence item limit.'),
        min_items_if_available: z.number().int().min(0).max(80).default(12).describe('Target minimum item count when enough related material exists.'),
        deduplicate_by: z.enum(['chunk', 'page', 'doc']).default('page'),
        filters: z
          .object({
            doc_id: z.string().nullable().default(null).describe('Restrict results to one document.'),
            tags: z.array(z.string()).nullable().default(null).describe('Require documents to have every listed tag.'),
          })
          .default({ doc_id: null, tags: null }),
        context_window: z.number().int().min(0).max(5).default(1),
        include_text: z.boolean().default(true),
        evidence_text_tokens: z.number().int().min(100).max(2000).default(900),
        include_evidence_pages: z.boolean().default(true).describe('Include full text for pages hit by direct evidence results.'),
        max_evidence_pages: z.number().int().min(1).max(20).default(5),
        include_books: z.boolean().default(true),
        include_papers: z.boolean().default(true),
        include_terms: z.boolean().default(true),
        term_top_k: z.number().int().min(1).max(50).optional().describe('Per-query term/result search limit when include_terms=true.'),
        include_index_hits: z.boolean().default(false).describe('Reserved for future table-of-contents/index extraction; currently returns a diagnostic note.'),
        strict: z.boolean().default(true).describe('When true, each generated query must find direct textual evidence.'),
        candidate_solution: z.string().optional().describe('Optional candidate solution produced outside the MCP. The server does not validate the derivation directly; it only records it and checks the supplied method_check_queries.'),
        method_check_queries: z.array(z.string()).optional().describe('Optional queries that describe the candidate solution methods or prerequisite knowledge points. If supported by the selected corpus and allowed by the profile, the tool may permit labeled method-guided reasoning.'),
        min_supported_method_queries: z.number().int().min(1).max(20).optional().describe('Minimum number of method_check_queries that must have direct evidence. Defaults to all supplied method_check_queries.'),
      }),
    },
    async input => jsonText(await searchTerms(input)),
  );

  server.registerTool(
    'check_reasonable',
    {
      title: 'Check Reasonable',
      description: 'Check whether an independently reasoned answer stays within the selected knowledge-base scope. Open research profiles always pass; closed corpus profiles search detected non-topic technical method queries and fail if any are unsupported.',
      inputSchema: z.object({
        db_name: z.string().nullable().default(null).describe('Knowledge-base name. Required when more than one DB exists.'),
        problem: z.string().describe('Original user problem or question. Topic terms are removed from the technical-scope check.'),
        answer: z.string().describe('Independent reasoning answer to audit for over-scope technical methods.'),
        topic_terms: z.array(z.string()).optional().describe('Optional extra topic/domain terms to ignore, such as quadratic function or mechanism design primitives.'),
        technical_queries: z.array(z.string()).optional().describe('Optional agent-generated technical method queries extracted from the answer, e.g. LHopital rule, Taylor expansion, derivative difference quotient. If omitted, the server uses conservative built-in extraction.'),
        min_supported_queries: z.number().int().min(1).max(20).optional().describe('Minimum supported technical queries required. Defaults to all detected technical queries.'),
        per_query_top_k: z.number().int().min(1).max(50).default(8),
        filters: z
          .object({
            doc_id: z.string().nullable().default(null).describe('Restrict results to one document.'),
            tags: z.array(z.string()).nullable().default(null).describe('Require documents to have every listed tag.'),
          })
          .default({ doc_id: null, tags: null }),
        context_window: z.number().int().min(0).max(5).default(1),
      }),
    },
    async input => jsonText(await checkReasonable(input)),
  );

  server.registerTool(
    'build_technical_index',
    {
      title: 'Build Technical Index',
      description: 'Pure-code extractor for technical-term results from existing pages/chunks. Defaults to dry-run preview and does not mutate the knowledge base unless dry_run=false and write=true are both supplied.',
      inputSchema: z.object({
        db_name: z.string().nullable().default(null).describe('Knowledge-base name. Required when more than one DB exists.'),
        doc_id: z.string().nullable().default(null).describe('Optional document id to scan.'),
        doc_kind: z.enum(['all', 'paper', 'book']).default('all').describe('Restrict extraction to papers, books, or all documents.'),
        result_types: z.array(z.string()).nullable().default(null).describe('Optional result-type filter, e.g. theorem, proposition, lemma, corollary, claim, definition.'),
        dry_run: z.boolean().default(true).describe('Default true. When true, only previews extracted results and does not write tables.'),
        write: z.boolean().default(false).describe('Must be true together with dry_run=false to create/update technical_results tables.'),
        replace: z.boolean().default(true).describe('When writing, replace existing technical results for scanned documents.'),
        include_text: z.boolean().default(false).describe('Include full extracted statement/proof text in samples.'),
        sample_limit: z.number().int().min(0).max(200).default(20),
        max_results: z.number().int().min(1).max(50000).default(10000),
      }),
    },
    async input => jsonText(await buildTechnicalIndex(input)),
  );

  server.registerTool(
    'search_technical_results',
    {
      title: 'Search Technical Results',
      description: 'Read-only search over extracted technical-term results. Dynamically extracts from existing pages/chunks and ranks result statements; does not mutate the knowledge base.',
      inputSchema: z.object({
        db_name: z.string().nullable().default(null).describe('Knowledge-base name. Required when more than one DB exists.'),
        query: z.string().describe('Search query for technical-term statements, assumptions, conclusions, section titles, formula refs, and nearby technical terms.'),
        doc_id: z.string().nullable().default(null).describe('Optional document id to restrict search.'),
        doc_kind: z.enum(['all', 'paper', 'book']).default('all').describe('Restrict search to papers, books, or all documents.'),
        result_types: z.array(z.string()).nullable().default(null).describe('Optional result-type filter, e.g. theorem, proposition, lemma, corollary, claim, definition.'),
        top_k: z.number().int().min(1).max(100).default(20),
        include_text: z.boolean().default(true).describe('Include extracted statement/proof text. If false, return short statement previews.'),
        include_formula_context: z.boolean().default(true).describe('Include short read-only page snippets around referenced formulas such as (6) or (21).'),
        formula_context_chars: z.number().int().min(200).max(3000).default(900).describe('Approximate character window for each formula-context snippet.'),
        include_related_definitions: z.boolean().default(true).describe('Include nearby Definition/Assumption/Axiom results from the same document as lightweight variable/equilibrium-context hints.'),
        definition_context_window: z.number().int().min(0).max(10).default(3).describe('Page distance used to attach nearby definitions and assumptions to each returned technical result.'),
        max_scan_results: z.number().int().min(1).max(50000).default(50000).describe('Maximum extracted technical-result candidates to rank.'),
      }),
    },
    async input => jsonText(await searchTechnicalResults(input)),
  );

  server.registerTool(
    'get_chunk',
    {
      title: 'Get Chunk',
      description: 'Return one chunk plus optional neighbor chunks and page image.',
      inputSchema: z.object({
        db_name: z.string().nullable().default(null).describe('Knowledge-base name. Required when more than one DB exists.'),
        chunk_id: z.string().describe('Stable chunk id returned by search.'),
        context_window: z.number().int().min(0).max(10).default(0),
        include_page_image: z.boolean().default(false),
      }),
    },
    async input => jsonText(await getChunk(input)),
  );

  server.registerTool(
    'get_page_text',
    {
      title: 'Get Page Text',
      description: 'Return extracted text for one 1-based PDF page.',
      inputSchema: z.object({
        db_name: z.string().nullable().default(null).describe('Knowledge-base name. Required when more than one DB exists.'),
        doc_id: z.string(),
        page: z.number().int().min(1).describe('1-based PDF page number.'),
        include_chunks: z.boolean().default(false),
      }),
    },
    async input => jsonText(await getPageText(input)),
  );

  server.registerTool(
    'get_page_image',
    {
      title: 'Get Page Image',
      description: 'Render or fetch a cached image for one 1-based PDF page.',
      inputSchema: z.object({
        db_name: z.string().nullable().default(null).describe('Knowledge-base name. Required when more than one DB exists.'),
        doc_id: z.string(),
        page: z.number().int().min(1).describe('1-based PDF page number.'),
        dpi: z.number().int().min(72).max(400).default(180),
        image_format: z.enum(['png', 'jpg', 'jpeg']).default('png'),
        force: z.boolean().default(false).describe('Regenerate even if a cached image exists.'),
      }),
    },
    async input => jsonText(await renderPage(input)),
  );

  return server;
}

const handle = serveStdio(createServer);
process.on('SIGINT', () => {
  void handle.close();
});
console.error('kb TypeScript server running on stdio');
