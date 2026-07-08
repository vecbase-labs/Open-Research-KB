import { execFile } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DuckDBInstance } from '@duckdb/node-api';

const execFileAsync = promisify(execFile);

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const indexDir = path.join(dataDir, 'index');
const renderDir = path.join(dataDir, 'rendered');
export const duckDbPath = process.env.KB_MCP_DUCKDB_PATH
  ? path.resolve(process.env.KB_MCP_DUCKDB_PATH)
  : path.join(indexDir, 'kb_default.duckdb');
const catalogPath = process.env.KB_MCP_CATALOG_PATH
  ? path.resolve(process.env.KB_MCP_CATALOG_PATH)
  : path.join(indexDir, 'db_catalog.json');
const defaultDbName = process.env.KB_MCP_DEFAULT_DB_NAME || 'default';
const reservedDbNames = new Set(['kb']);

const pdftotext = process.env.KB_MCP_PDFTOTEXT ?? 'pdftotext';
const pdftoppm = process.env.KB_MCP_PDFTOPPM ?? 'pdftoppm';
const pdfinfo = process.env.KB_MCP_PDFINFO ?? 'pdfinfo';
const tesseract = process.env.KB_MCP_TESSERACT ?? 'tesseract';

let indexWriteQueue = Promise.resolve();
const duckDbInstancePromises = new Map<string, Promise<DuckDBInstance>>();
const dbContext = new AsyncLocalStorage<DbCatalogEntry>();
let activeDbName: string | null = null;

export type SearchMode = 'hybrid' | 'text' | 'overlap' | 'semantic' | 'vector';
export type KbStatus = 'supported' | 'related_only' | 'not_found';
export type OcrMode = 'never' | 'auto' | 'required';
export type RetrievalProfile = 'strict_evidence' | 'research_context' | 'exploratory_bibliography';
export type DeduplicateBy = 'chunk' | 'page' | 'doc';
export type MethodBoundaryCheckStatus = 'not_requested' | 'not_allowed_by_profile' | 'within_corpus_methods' | 'partial_method_support' | 'not_supported';

const methodCheckGenericTerms = new Set([
  'function', 'functions', 'value', 'values', 'line', 'lines', 'school', 'textbook',
  'example', 'examples', 'problem', 'problems', 'math', 'mathematics',
]);

const methodCheckCoreTerms = new Set([
  'average', 'rate', 'change', 'derivative', 'differentiable', 'differentiation',
  'quotient', 'limit', 'limits', 'constant', 'quadratic', 'linear', 'convex',
  'concave', 'monotonicity', 'duality', 'martingale', 'posterior', 'bayes',
  'plausibility', 'equilibrium', 'incentive', 'compatibility', 'fixed', 'point',
  'lhopital', 'hopital', 'taylor', 'jensen', 'cauchy', 'squeeze', 'integral',
  'integration', 'lagrange', 'newton', 'filtration', 'martingales',
]);

const reasoningTechniquePhrases = [
  { pattern: /\bl'?h[oô]pital\b/i, query: "L'Hopital rule" },
  { pattern: /\btaylor\b/i, query: 'Taylor expansion theorem' },
  { pattern: /\bjensen\b/i, query: 'Jensen inequality convexity' },
  { pattern: /\bcauchy\b/i, query: 'Cauchy inequality theorem' },
  { pattern: /\bsqueeze theorem\b/i, query: 'squeeze theorem limit' },
  { pattern: /\bmean value theorem\b/i, query: 'mean value theorem derivative' },
  { pattern: /洛必达/, query: '洛必达 法则 极限' },
  { pattern: /泰勒/, query: '泰勒 展开' },
  { pattern: /导数|求导/, query: '导数 差商 极限' },
  { pattern: /极限/, query: '极限 差商' },
  { pattern: /微分/, query: '微分 导数' },
  { pattern: /积分/, query: '积分' },
  { pattern: /均值定理/, query: '均值定理 导数' },
  { pattern: /拉格朗日/, query: '拉格朗日 中值定理' },
  { pattern: /柯西/, query: '柯西 不等式' },
  { pattern: /夹逼/, query: '夹逼 定理 极限' },
  { pattern: /凸性|凸函数/, query: '凸性 凸函数' },
  { pattern: /贝叶斯|后验/, query: 'Bayes posterior belief' },
  { pattern: /鞅/, query: 'martingale' },
];

export interface DocumentRecord {
  doc_id: string;
  title: string;
  authors: string[];
  tags: string[];
  source_path: string;
  canonical_pdf_name: string;
  file_sha256: string;
  page_count: number;
  created_at: string;
}

export interface PageRecord {
  doc_id: string;
  page: number;
  text: string;
}

export interface ChunkRecord {
  chunk_id: string;
  doc_id: string;
  page: number;
  chunk_index: number;
  text: string;
}

export interface TechnicalResultRecord {
  result_id: string;
  doc_id: string;
  title: string;
  doc_kind: 'paper' | 'book';
  result_type: string;
  result_number: string | null;
  result_label: string;
  page_start: number;
  page_end: number;
  chunk_ids: string[];
  section_title: string | null;
  statement_text: string;
  proof_text: string | null;
  formula_refs: string[];
  nearby_terms: string[];
  assumption_text: string | null;
  conclusion_text: string | null;
  extraction_method: string;
  source_links: Array<Record<string, unknown>>;
  derived_from: Array<Record<string, unknown>>;
  relation_candidates: Array<Record<string, unknown>>;
}

interface FormulaContextRecord {
  formula_ref: string;
  page: number;
  citation: string;
  text: string;
}

interface RelatedDefinitionRecord {
  result_id: string;
  result_label: string;
  result_type: string;
  page_start: number;
  page_end: number;
  citation: string;
  statement_preview: string;
}

export interface KnowledgeIndex {
  documents: DocumentRecord[];
  pages: PageRecord[];
  chunks: ChunkRecord[];
}

export interface Filters {
  doc_id?: string | null;
  tags?: string[] | null;
}

export type EvidenceGrade = 'exact_phrase' | 'all_key_terms' | 'partial_terms' | 'none';

export interface QueryAnalysis {
  terms: string[];
  phrase_terms: string[];
  key_terms: string[];
  warnings: string[];
}

export interface DbCatalogEntry {
  name: string;
  duckdb_path: string;
  created_at: string;
  source_path?: string | null;
  is_default?: boolean;
  profile?: KnowledgeBaseProfile;
}

export type ScopePolicy = 'closed_corpus' | 'open_research' | 'hybrid';
export type FallbackPolicy = 'ask_before_external_reasoning' | 'method_guided_then_ask' | 'allow_labeled_independent_reasoning';
export type StylePolicy = 'infer_from_corpus' | 'academic_research' | 'minimal';
export type MethodBoundary = 'corpus_internal' | 'open_with_citations' | 'corpus_guided';
export type ExternalMethodsPolicy = 'forbid_unlabeled' | 'allowed_if_labeled' | 'allowed';

export interface KnowledgeBaseProfile {
  schema_version: 1;
  db_name: string;
  created_at: string;
  source: 'auto_inferred' | 'default_backfill' | 'catalog';
  scope_policy: ScopePolicy;
  fallback_policy: FallbackPolicy;
  style_policy: StylePolicy;
  method_boundary: MethodBoundary;
  external_methods_policy: ExternalMethodsPolicy;
  direct_evidence_required_for_kb_claim: boolean;
  allow_method_guided_independent_reasoning: boolean;
  must_label_independent_reasoning: boolean;
  corpus_boundary: 'knowledge_base_internal' | 'knowledge_base_primary' | 'open';
  inferred_from: {
    db_name: string;
    source_path: string | null;
    tags: string[];
    signals: string[];
  };
  notes: string[];
}

export function knowledgeBaseIdentity() {
  const current = dbContext.getStore();
  return {
    name: current?.name ?? defaultDbName,
    duckdb_path: current?.duckdb_path ?? duckDbPath,
    profile: current?.profile ?? inferKnowledgeBaseProfile({
      name: defaultDbName,
      sourcePath: null,
      tags: [],
      source: 'default_backfill',
    }),
  };
}

function withKnowledgeBase<T extends Record<string, unknown>>(value: T) {
  return {
    knowledge_base: knowledgeBaseIdentity(),
    ...value,
  };
}

const stopwords = new Set([
  'the', 'and', 'or', 'for', 'with', 'that', 'this', 'from', 'into', 'within',
  'where', 'when', 'what', 'which', 'whether', 'given', 'such', 'path', 'paths',
  'set', 'sets', 'probability', 'prob', 'please', 'using', 'use', 'query',
  'knowledge', 'base', 'mcp', 'even', 'odd', 'di', 'are', 'can', 'cannot',
  'should', 'would', 'could', 'from', 'into', 'onto', 'non',
]);

export async function ingestPdf(input: {
  db_name?: string | null;
  pdf_path: string;
  doc_id?: string | null;
  title?: string | null;
  authors?: string[];
  tags?: string[];
  force?: boolean;
  chunk_size?: number;
  chunk_overlap?: number;
  render_pages?: boolean;
  ocr?: OcrMode;
  ocr_language?: string;
  ocr_dpi?: number;
  ocr_max_pages?: number | null;
  require_searchable?: boolean;
}) {
  return withSelectedDb(input.db_name ?? null, async selection => {
  if (selection.required) return selection.response;
  await ensureDirs();
  const source = path.isAbsolute(input.pdf_path) ? input.pdf_path : path.resolve(root, input.pdf_path);
  await fs.access(source);
  const fileSha256 = await sha256File(source);
  const title = input.title || path.basename(source, path.extname(source));
  const docId = input.doc_id || `${slugify(title)}-${fileSha256.slice(0, 10)}`;
  const force = input.force ?? false;
  const chunkSize = input.chunk_size ?? 1200;
  const chunkOverlap = input.chunk_overlap ?? 180;
  const ocrMode = input.ocr ?? 'never';
  const ocrLanguage = input.ocr_language ?? 'eng';
  const ocrDpi = input.ocr_dpi ?? 220;
  const ocrMaxPages = input.ocr_max_pages ?? null;
  const requireSearchable = input.require_searchable ?? true;
  const ingestTempDir = await fs.mkdtemp(path.join(os.tmpdir(), `kb-mcp-${slugify(docId)}-${fileSha256.slice(0, 8)}-`));

  try {
    const initialIndex = await loadIndex();
    const removedInitialDocIds = new Set<string>();
    const existingBySha = initialIndex.documents.find(doc => doc.file_sha256 === fileSha256);
    if (existingBySha && existingBySha.doc_id !== docId) {
      const existingChunkCount = initialIndex.chunks.filter(chunk => chunk.doc_id === existingBySha.doc_id).length;
      if (requireSearchable && existingChunkCount === 0) {
        await withIndexWriteLock(async () => {
          const connection = await connectDb();
          try {
            await connection.run('begin transaction');
            await deleteDocumentRows(connection, existingBySha.doc_id);
            await connection.run('commit');
          } catch (error) {
            await connection.run('rollback').catch(() => undefined);
            throw error;
          } finally {
            connection.disconnectSync();
          }
          await removeRenderedArtifacts(existingBySha);
          removedInitialDocIds.add(existingBySha.doc_id);
        });
      } else {
        return withKnowledgeBase({
          status: 'already_exists',
          document: existingBySha,
          counts: {
            pages: initialIndex.pages.filter(page => page.doc_id === existingBySha.doc_id).length,
            chunks: existingChunkCount,
          },
          warnings: [`Duplicate PDF content already indexed as ${existingBySha.doc_id}.`],
        });
      }
    }
    if (existingBySha && existingBySha.doc_id === docId && requireSearchable) {
      const existingChunkCount = initialIndex.chunks.filter(chunk => chunk.doc_id === existingBySha.doc_id).length;
      if (existingChunkCount === 0) {
        await withIndexWriteLock(async () => {
          const connection = await connectDb();
          try {
            await connection.run('begin transaction');
            await deleteDocumentRows(connection, existingBySha.doc_id);
            await connection.run('commit');
          } catch (error) {
            await connection.run('rollback').catch(() => undefined);
            throw error;
          } finally {
            connection.disconnectSync();
          }
          await removeRenderedArtifacts(existingBySha);
          removedInitialDocIds.add(existingBySha.doc_id);
        });
      } else if (!force) {
        return withKnowledgeBase({
          status: 'already_exists',
          document: existingBySha,
          counts: {
            pages: initialIndex.pages.filter(page => page.doc_id === existingBySha.doc_id).length,
            chunks: existingChunkCount,
          },
          warnings: [`PDF content already indexed as ${existingBySha.doc_id}.`],
        });
      }
    } else if (existingBySha && existingBySha.doc_id === docId && !force) {
      const existingChunkCount = initialIndex.chunks.filter(chunk => chunk.doc_id === existingBySha.doc_id).length;
      return withKnowledgeBase({
        status: 'already_exists',
        document: existingBySha,
        counts: {
          pages: initialIndex.pages.filter(page => page.doc_id === existingBySha.doc_id).length,
          chunks: existingChunkCount,
        },
        warnings: [`PDF content already indexed as ${existingBySha.doc_id}.`],
      });
    }
    if (initialIndex.documents.some(doc => doc.doc_id === docId && !removedInitialDocIds.has(doc.doc_id)) && !force) {
      throw new Error(`Document already exists: ${docId}. Pass force=true to replace it.`);
    }
    const canonicalPdfName = standardPdfFileName(docId, fileSha256);
    const pageCount = await getPageCount(source);
    const pages: PageRecord[] = [];
    const chunks: ChunkRecord[] = [];
    const ingestWarnings: string[] = [];
    let pagesWithText = 0;
    let ocrAttemptedPages = 0;
    let ocrSucceededPages = 0;
    const createdAt = new Date().toISOString();

    for (let page = 1; page <= pageCount; page += 1) {
      const extracted = await extractPageTextWithOptionalOcr({
        pdfPath: source,
        page,
        tempDir: ingestTempDir,
        ocrMode,
        ocrLanguage,
        ocrDpi,
        ocrAllowed: ocrMaxPages === null || ocrAttemptedPages < ocrMaxPages,
      });
      if (extracted.ocr_attempted) ocrAttemptedPages += 1;
      if (extracted.ocr_succeeded) ocrSucceededPages += 1;
      if (extracted.warning && !ingestWarnings.includes(extracted.warning)) ingestWarnings.push(extracted.warning);
      const text = extracted.text;
      if (text.trim()) pagesWithText += 1;
      pages.push({ doc_id: docId, page, text });
      for (const chunkText of splitText(text, chunkSize, chunkOverlap)) {
        const localIndex = chunks.filter(chunk => chunk.page === page).length;
        chunks.push({
          chunk_id: `${docId}:p${page}:c${localIndex}`,
          doc_id: docId,
          page,
          chunk_index: chunks.length,
          text: chunkText,
        });
      }
      if (input.render_pages) {
        await renderPage({ doc_id: docId, page, dpi: 180, image_format: 'png', force: false }, { document: {
          doc_id: docId,
          title,
          authors: input.authors ?? [],
          tags: input.tags ?? [],
          source_path: source,
          canonical_pdf_name: canonicalPdfName,
          file_sha256: fileSha256,
          page_count: pageCount,
          created_at: createdAt,
        } });
      }
    }

    const document: DocumentRecord = {
      doc_id: docId,
      title,
      authors: input.authors ?? [],
      tags: input.tags ?? [],
      source_path: source,
      canonical_pdf_name: canonicalPdfName,
      file_sha256: fileSha256,
      page_count: pageCount,
      created_at: createdAt,
    };
    if (requireSearchable && chunks.length === 0) {
      await removeRenderedArtifacts(document);
      return withKnowledgeBase({
        status: 'rejected',
        document: null,
        rejected_document: document,
        counts: {
          pages: pages.length,
          pages_with_text: pagesWithText,
          chunks: chunks.length,
          ocr_attempted_pages: ocrAttemptedPages,
          ocr_succeeded_pages: ocrSucceededPages,
        },
        index_status: 'not_indexed',
        rejection_reason: 'no_searchable_text',
        diagnosis: 'The PDF appears to be scanned/image-only or otherwise has no extractable text. This knowledge base currently accepts searchable text PDFs; scanned PDFs require a working OCR pipeline before they can be indexed.',
        warnings: [
          ...ingestWarnings,
          'No extractable text chunks were found. The document was not added to the knowledge base.',
        ],
      });
    }
    const skippedExisting = await withIndexWriteLock(async () => {
      const existingBySha = await findDocumentBySha(fileSha256);
      if (existingBySha && existingBySha.doc_id !== docId) {
        const counts = await countDocumentRecords(existingBySha.doc_id);
        if (requireSearchable && counts.chunks === 0) {
          const connection = await connectDb();
          try {
            await connection.run('begin transaction');
            await deleteDocumentRows(connection, existingBySha.doc_id);
            await connection.run('commit');
          } catch (error) {
            await connection.run('rollback').catch(() => undefined);
            throw error;
          } finally {
            connection.disconnectSync();
          }
          await removeRenderedArtifacts(existingBySha);
        } else {
          return {
            document: existingBySha,
            counts,
          };
        }
      }
      const existingByDocId = await findDocumentById(docId);
      if (existingByDocId && !force) {
        throw new Error(`Document already exists: ${docId}. Pass force=true to replace it.`);
      }
      if (existingByDocId) await removeRenderedArtifacts(existingByDocId);
      await upsertDocumentBundle({ document, pages, chunks, replaceExisting: force || Boolean(existingByDocId) });
      return null;
    });
    if (skippedExisting) {
      return withKnowledgeBase({
        status: 'already_exists',
        document: skippedExisting.document,
        counts: skippedExisting.counts,
        warnings: [`Duplicate PDF content already indexed as ${skippedExisting.document.doc_id}.`],
      });
    }

    return withKnowledgeBase({
      status: 'ingested',
      document,
      counts: {
        pages: pages.length,
        pages_with_text: pagesWithText,
        chunks: chunks.length,
        ocr_attempted_pages: ocrAttemptedPages,
        ocr_succeeded_pages: ocrSucceededPages,
      },
      index_status: chunks.length ? 'searchable' : 'not_searchable',
      warnings: [
        ...ingestWarnings,
        ...(chunks.length ? [] : ['No extractable text chunks were found. This document is registered but not searchable until OCR text is available.']),
      ],
    });
  } finally {
    await fs.rm(ingestTempDir, { recursive: true, force: true });
  }
  });
}

export async function createDb(input: {
  db_name?: string | null;
  path?: string | null;
  tags?: string[];
  ocr?: OcrMode;
  ocr_language?: string;
  ocr_dpi?: number;
  ocr_max_pages?: number | null;
  chunk_size?: number;
  chunk_overlap?: number;
}) {
  await ensureDirs();
  const sourcePath = input.path ? path.resolve(input.path) : null;
  const name = normalizeDbName(input.db_name || (sourcePath ? path.basename(sourcePath) : `kb-${new Date().toISOString().slice(0, 10)}`));
  if (!name) throw new Error('db_name could not be inferred. Provide db_name explicitly.');
  if (reservedDbNames.has(name) || name === 'all' || name === 'union') throw new Error(`Reserved db_name: ${name}. Use a concrete knowledge-base name such as default, research_corpus, or textbook_corpus.`);
  const catalog = await readDbCatalog();
  if (catalog.some(entry => entry.name === name)) throw new Error(`Knowledge base already exists: ${name}`);
  const dbPath = path.join(path.dirname(catalogPath), `kb_${name}.duckdb`);
  const entry: DbCatalogEntry = {
    name,
    duckdb_path: dbPath,
    created_at: new Date().toISOString(),
    source_path: sourcePath,
    profile: inferKnowledgeBaseProfile({
      name,
      sourcePath,
      tags: input.tags ?? [],
      source: 'auto_inferred',
    }),
  };
  await writeDbCatalog([...catalog, entry]);
  await withDbEntry(entry, async () => {
    const connection = await connectDb();
    connection.disconnectSync();
  });

  const ingested_documents = [];
  const rejected_documents = [];
  if (sourcePath) {
    const stat = await fs.stat(sourcePath);
    const pdfPaths = stat.isDirectory()
      ? (await fs.readdir(sourcePath))
        .filter(file => file.toLowerCase().endsWith('.pdf'))
        .sort()
        .map(file => path.join(sourcePath, file))
      : [sourcePath];
    for (const pdfPath of pdfPaths) {
      const result = await ingestPdf({
        db_name: name,
        pdf_path: pdfPath,
        tags: input.tags ?? [],
        ocr: input.ocr ?? 'never',
        ocr_language: input.ocr_language,
        ocr_dpi: input.ocr_dpi,
        ocr_max_pages: input.ocr_max_pages,
        chunk_size: input.chunk_size,
        chunk_overlap: input.chunk_overlap,
        require_searchable: true,
      });
      if (result.status === 'rejected') rejected_documents.push(result);
      else ingested_documents.push(result);
    }
  }

  return {
    knowledge_base: { name: entry.name, duckdb_path: entry.duckdb_path, profile: entry.profile },
    status: 'created',
    db: entry,
    counts: {
      ingested_documents: ingested_documents.length,
      rejected_documents: rejected_documents.length,
    },
    ingested_documents,
    rejected_documents,
  };
}

export async function listDb() {
  const dbs = await Promise.all((await readDbCatalog()).map(async entry => {
    const counts = await withDbEntry(entry, () => countAllRecords());
    return { ...entry, active: entry.name === activeDbName, counts };
  }));
  return {
    databases: dbs,
    total: dbs.length,
    active_db_name: activeDbName,
    requires_db_name_for_search: dbs.length > 1,
  };
}

export async function setActiveDb(input: { db_name: string | null }) {
  const catalog = await readDbCatalog();
  if (!input.db_name) {
    activeDbName = null;
    return {
      status: 'cleared',
      active_db_name: null,
      message: 'No active knowledge base is set. If more than one DB exists, search tools will require db_name.',
      available_databases: dbSelectionOptions(catalog),
    };
  }
  const name = normalizeDbName(input.db_name);
  const entry = catalog.find(item => item.name === name);
  if (!entry) return dbSelectionRequired(catalog, `Unknown knowledge base: ${input.db_name}`);
  activeDbName = entry.name;
  return {
    status: 'active_db_set',
    active_db_name: activeDbName,
    knowledge_base: { name: entry.name, duckdb_path: entry.duckdb_path, profile: entry.profile },
    message: `This MCP server process will use ${entry.name} as the default knowledge base for subsequent calls that omit db_name.`,
  };
}

export async function listDocuments(input: {
  db_name?: string | null;
  query?: string | null;
  tags?: string[] | null;
  limit?: number;
  offset?: number;
}) {
  return withSelectedDb(input.db_name ?? null, async selection => {
  if (selection.required) return selection.response;
  const index = await loadIndex();
  const query = input.query?.toLowerCase();
  const tags = input.tags ?? null;
  let documents = [...index.documents].sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (query) {
    documents = documents.filter(doc =>
      doc.title.toLowerCase().includes(query)
      || doc.authors.join(' ').toLowerCase().includes(query)
      || doc.source_path.toLowerCase().includes(query),
    );
  }
  if (tags?.length) {
    documents = documents.filter(doc => tags.every(tag => doc.tags.includes(tag)));
  }
  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;
  return withKnowledgeBase({ documents: documents.slice(offset, offset + limit), total: documents.length, limit, offset });
  });
}

export async function search(input: {
  db_name?: string | null;
  query: string;
  mode?: SearchMode;
  retrieval_profile?: RetrievalProfile;
  top_k?: number;
  max_items?: number;
  filters?: Filters;
  context_window?: number;
  include_text?: boolean;
  evidence_text_tokens?: number;
  strict?: boolean;
}) {
  return withSelectedDb(input.db_name ?? null, async selection => {
  if (selection.required) return selection.response;
  const index = await loadIndex();
  const requestedMode = input.mode ?? 'text';
  const mode = requestedMode === 'vector' ? 'semantic' : requestedMode;
  const retrievalProfile = input.retrieval_profile ?? 'strict_evidence';
  const strict = input.strict ?? retrievalProfile === 'strict_evidence';
  const topK = input.max_items ?? input.top_k ?? (retrievalProfile === 'strict_evidence' ? 8 : 20);
  const contextWindow = input.context_window ?? 0;
  const includeText = input.include_text ?? true;
  const filters = input.filters ?? {};
  const queryAnalysis = extractQueryTerms(input.query);
  if (requestedMode === 'vector') {
    queryAnalysis.warnings.push('mode="vector" is deprecated; use mode="semantic". Semantic retrieval requires a populated LanceDB side index.');
  }
  if (mode === 'semantic' || mode === 'hybrid') {
    const semanticStatus = await getSemanticIndexStatus();
    if (!semanticStatus.ready) {
      queryAnalysis.warnings.push(semanticStatus.message);
    }
  }
  const queryTerms = queryAnalysis.terms;
  const docs = new Map(index.documents.map(doc => [doc.doc_id, doc]));

  const textMatches = mode === 'text' || mode === 'hybrid'
    ? await textSearchDb(queryTerms, topK * 3, filters, docs)
    : [];
  const overlapMatches = !strict && (mode === 'overlap' || mode === 'hybrid')
    ? overlapSearch(index, docs, input.query, topK * 3, filters)
    : [];

  if (strict && (mode === 'text' || mode === 'hybrid') && textMatches.length === 0) {
    return withKnowledgeBase({
      query: input.query,
      mode,
      strict,
      results: [],
      answerability: {
        status: 'not_found',
        evidence_grade: 'none',
        ...answerPolicy('not_found'),
        message: 'No direct textual evidence was found in the indexed knowledge base. Do not answer by analogy to unrelated sources; ask the user whether to proceed with general AI reasoning.',
        matched_terms: [],
        missing_terms: queryAnalysis.key_terms,
        query_terms: queryTerms.slice(0, 20),
        warnings: queryAnalysis.warnings,
      },
    });
  }

  const maxBm25Score = Math.max(...textMatches.map(item => item.bm25_score), 0);
  const merged = new Map<string, ChunkRecord & { score: number; match_type: string; matched_terms: string[]; bm25_score?: number; overlap_score?: number }>();
  textMatches.forEach((item, rank) => {
    const normalizedBm25Score = maxBm25Score > 0 ? item.bm25_score / maxBm25Score : 0;
    merged.set(item.chunk_id, {
      ...item,
      score: normalizedBm25Score,
      bm25_score: item.bm25_score,
      match_type: 'text',
      matched_terms: item.matched_terms,
    });
  });
  overlapMatches.forEach((item, rank) => {
    const overlapScore = item.overlapScore;
    const current = merged.get(item.chunk_id);
    if (current) {
      current.score += 0.25 * overlapScore;
      current.overlap_score = overlapScore;
      current.match_type = 'hybrid';
    } else {
      merged.set(item.chunk_id, {
        ...item,
        score: 0.25 * overlapScore,
        overlap_score: overlapScore,
        match_type: 'overlap',
        matched_terms: [],
      });
    }
  });

  const sorted = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, topK);
  const evidence = gradeEvidence(sorted, queryAnalysis);
  const directEvidence = evidence.evidence_grade === 'exact_phrase' || evidence.evidence_grade === 'all_key_terms';
  const visibleResults = strict && !directEvidence ? [] : sorted;
  const results = visibleResults.map(item => enrichChunk(index, docs, item, includeText, contextWindow));
  const partialResults = strict && evidence.evidence_grade === 'partial_terms'
    ? sorted.map(item => enrichChunk(index, docs, item, false, 0))
    : undefined;
  const matchedTerms = [...new Set(sorted.flatMap(item => item.matched_terms))].sort();
  const status = directEvidence
    ? 'supported'
    : evidence.evidence_grade === 'partial_terms'
      ? 'related_only'
      : results.length
        ? 'related_only'
        : 'not_found';
  return withKnowledgeBase({
    query: input.query,
    mode,
    retrieval_profile: retrievalProfile,
    strict,
    results,
    ...(partialResults ? { partial_results: partialResults } : {}),
    ...(retrievalProfile === 'strict_evidence' ? {} : {
      items: buildResearchContextItems({
        index,
        docs,
        queryResults: [{ query: input.query, results: sorted.map(item => enrichChunk(index, docs, item, true, contextWindow)) }],
        maxItems: topK,
        deduplicateBy: 'chunk',
        includeText,
        evidenceTextTokens: input.evidence_text_tokens ?? 900,
        includeBooks: true,
        includePapers: true,
        includeTerms: true,
      }).items,
    }),
    answerability: {
      status,
      evidence_grade: evidence.evidence_grade,
      ...answerPolicy(status),
      message: answerabilityMessage(status, strict),
      matched_terms: matchedTerms,
      missing_terms: evidence.missing_terms,
      query_terms: queryTerms.slice(0, 20),
      warnings: queryAnalysis.warnings,
    },
  });
  });
}

export async function searchTerms(input: {
  db_name?: string | null;
  problem: string;
  suggested_queries?: string[];
  retrieval_profile?: RetrievalProfile;
  top_k?: number;
  per_query_top_k?: number;
  max_items?: number;
  min_items_if_available?: number;
  deduplicate_by?: DeduplicateBy;
  filters?: Filters;
  context_window?: number;
  include_text?: boolean;
  evidence_text_tokens?: number;
  include_evidence_pages?: boolean;
  max_evidence_pages?: number;
  include_books?: boolean;
  include_papers?: boolean;
  include_terms?: boolean;
  term_top_k?: number;
  include_index_hits?: boolean;
  strict?: boolean;
  candidate_solution?: string;
  method_check_queries?: string[];
  min_supported_method_queries?: number;
}) {
  return withSelectedDb(input.db_name ?? null, async selection => {
  if (selection.required) return selection.response;
  const suggestedQueries = (input.suggested_queries ?? []).map(query => query.trim()).filter(Boolean);
  const retrievalProfile = input.retrieval_profile ?? (input.strict === false ? 'research_context' : 'strict_evidence');
  if (suggestedQueries.length === 0) {
    return withKnowledgeBase({
      workflow_status: 'needs_query_rewrite',
      requires_llm_rewrite: true,
      original_problem: input.problem,
      results: [],
      message: 'The MCP server does not semantically rewrite natural-language technical or domain-specific questions. The agent should use its LLM capability to generate search queries, then call this tool again with suggested_queries.',
      rewrite_instructions: [
        'First infer the latent technical structure behind the user problem: state variables, types, messages, histories, beliefs, feasible actions, constraints, and objective.',
        'Identify any hidden stochastic process, feasibility condition, result type, definition, or standard technical object that may govern the problem, such as posterior martingales, Bayes plausibility, splitting lemmas, filtrations, convexity, fixed points, duality, monotonicity, or comparative statics.',
        'Generate 3-5 concise English/technical search queries that mix surface-topic terms with technical terms.',
        'Also generate term-search terms: theorem, proposition, lemma, definition, characterization, necessary and sufficient, equilibrium existence, incentive compatibility, Bayes plausibility, posterior martingale, privacy constraint, verifiable disclosure, hard evidence, unraveling.',
        'For custom economic theory problems, first sketch the likely model class in keywords, then include those keywords in the search queries.',
        'Include exact formulas, named structures, and inferred technical objects when useful.',
        'Do not answer the technical or domain-specific question yet; only generate retrieval queries.',
      ],
      iterative_retrieval_policy: {
        can_refine_and_search_again: true,
        requires_user_permission_for_independent_reasoning: true,
        instructions: [
          'The agent may use later evidence packets returned by this tool to refine the query set and call search_terms again.',
          'Query refinement is retrieval work, not independent domain reasoning.',
          'Do not present a final answer from weak or technical-tool evidence unless answerability.status becomes supported or the user explicitly allows independent reasoning.',
        ],
      },
      next_call_example: {
        problem: input.problem,
        suggested_queries: [
          'positive assortative matching supermodular surplus assignment problem',
          'Monge array optimal assignment matching',
          'optimal transport assignment problem workers firms surplus',
          'submodularity supermodularity increasing differences optimal matching theorem',
        ],
        top_k: input.top_k ?? 5,
        retrieval_profile: retrievalProfile,
        per_query_top_k: input.per_query_top_k ?? input.top_k ?? 8,
        max_items: input.max_items ?? 20,
        filters: input.filters ?? {},
        strict: input.strict ?? true,
      },
    });
  }

  const queryResults = [];
  const perQueryTopK = input.per_query_top_k ?? input.top_k ?? (retrievalProfile === 'strict_evidence' ? 5 : 12);
  for (const query of suggestedQueries) {
    queryResults.push(await search({
      query,
      mode: 'text',
      retrieval_profile: 'strict_evidence',
      top_k: perQueryTopK,
      db_name: input.db_name ?? null,
      filters: input.filters ?? {},
      context_window: input.context_window ?? 1,
      include_text: input.include_text ?? true,
      strict: input.strict ?? retrievalProfile === 'strict_evidence',
    }));
  }

  const directResults = queryResults.filter(result => result.answerability.status === 'supported');
  const partialResults = queryResults.filter(result => result.answerability.status === 'related_only');
  const workflowStatus = directResults.length > 0
    ? 'supported'
    : partialResults.length > 0
      ? 'related_only'
      : 'not_found';
  const evidencePages = input.include_evidence_pages ?? true
    ? await collectEvidencePages(queryResults, input.max_evidence_pages ?? 5)
    : [];
  const index = await loadIndex();
  const docs = new Map(index.documents.map(doc => [doc.doc_id, doc]));
  const researchContext = buildResearchContextItems({
    index,
    docs,
    queryResults,
    maxItems: input.max_items ?? (retrievalProfile === 'strict_evidence' ? input.top_k ?? 8 : 20),
    minItemsIfAvailable: input.min_items_if_available ?? (retrievalProfile === 'strict_evidence' ? 0 : 12),
    deduplicateBy: input.deduplicate_by ?? 'page',
    includeText: input.include_text ?? true,
    evidenceTextTokens: input.evidence_text_tokens ?? 900,
    includeBooks: input.include_books ?? true,
    includePapers: input.include_papers ?? true,
    includeTerms: input.include_terms ?? true,
  });
  const termTopK = input.term_top_k ?? Math.max(5, Math.min(12, perQueryTopK));
  const technicalQueryResults = input.include_terms ?? true
    ? await collectTechnicalSearchResults({
      dbName: input.db_name ?? null,
      queries: suggestedQueries,
      topK: termTopK,
      includeText: input.include_text ?? true,
    })
    : [];
  const technicalItems = buildTechnicalEvidenceItems({
    technicalQueryResults,
    evidenceTextTokens: input.evidence_text_tokens ?? 900,
  });
  const maxItems = input.max_items ?? (retrievalProfile === 'strict_evidence' ? input.top_k ?? 8 : 20);
  const combinedContext = mergeEvidenceItems({
    contextItems: researchContext.items,
    technicalItems,
    maxItems,
    includeTerms: input.include_terms ?? true,
  });
  const suggestedFollowupQueries = buildFollowupQueries(input.problem, suggestedQueries, combinedContext.items);
  const methodCheckQueries = (input.method_check_queries ?? []).map(query => query.trim()).filter(Boolean);
  const methodQueryResults = [];
  for (const query of methodCheckQueries) {
    methodQueryResults.push(await search({
      query,
      mode: 'text',
      retrieval_profile: 'strict_evidence',
      top_k: perQueryTopK,
      db_name: input.db_name ?? null,
      filters: input.filters ?? {},
      context_window: input.context_window ?? 1,
      include_text: input.include_text ?? true,
      strict: true,
    }));
  }
  const methodBoundaryCheck = buildMethodBoundaryCheck({
    profile: knowledgeBaseIdentity().profile,
    method_check_queries: methodCheckQueries,
    query_results: methodQueryResults,
    min_supported_queries: input.min_supported_method_queries,
  });
  const supportType = workflowStatus === 'supported'
    ? 'direct_evidence'
    : methodBoundaryCheck.can_answer_with_labeled_method_guided_reasoning
      ? 'method_guided_corpus_check'
      : 'none';
  const finalWorkflowStatus: KbStatus = supportType === 'method_guided_corpus_check' ? 'supported' : workflowStatus;
  const finalPolicy = supportType === 'method_guided_corpus_check'
    ? {
      can_answer_from_kb: true,
      must_ask_user_before_reasoning: false,
      allowed_next_steps: ['answer_with_labeled_method_guided_reasoning', 'cite_method_check_evidence'],
    }
    : answerPolicy(finalWorkflowStatus);

  return withKnowledgeBase({
    workflow_status: retrievalProfile === 'strict_evidence' ? finalWorkflowStatus : retrievalProfile,
    requires_llm_rewrite: false,
    retrieval_profile: retrievalProfile,
    ...finalPolicy,
    answerability: {
      status: finalWorkflowStatus,
      support_type: supportType,
      original_problem_status: workflowStatus,
      can_answer_directly_from_kb: workflowStatus === 'supported',
      independent_reasoning_label_required: supportType === 'method_guided_corpus_check',
      required_answer_framing: supportType === 'method_guided_corpus_check'
        ? 'State first that the knowledge base did not directly answer the original problem; then separate the independently derived solution from the method-check citations.'
        : undefined,
      ...finalPolicy,
      reason: supportType === 'method_guided_corpus_check'
        ? 'The knowledge base did not directly solve the original problem, but it directly supports the candidate solution methods under the selected profile.'
        : workflowStatus === 'supported'
        ? 'At least one generated query found direct textual evidence in the knowledge base.'
        : combinedContext.items.length
          ? 'No single source directly solves the proposed custom problem, but the knowledge base contains related model primitives, technical tools, or background evidence.'
          : 'No useful evidence was found in the selected knowledge base.',
    },
    original_problem: input.problem,
    ...(input.candidate_solution ? { candidate_solution: input.candidate_solution } : {}),
    suggested_queries: suggestedQueries,
    query_results: queryResults,
    method_boundary_check: {
      ...methodBoundaryCheck,
      query_results: methodQueryResults,
    },
    technical_query_results: technicalQueryResults,
    items: combinedContext.items,
    grouped_items: combinedContext.grouped_items,
    item_policy: {
      purpose: 'Use these items as an evidence packet for later reasoning. Do not treat technical_tool, background, or weak_related items as direct support for a final answer.',
      evidence_grades: ['direct_model_primitive', 'term_or_result', 'technical_tool', 'background', 'weak_related'],
      answerability_contributions: ['direct_support', 'helps_formalize', 'only_background'],
    },
    iterative_retrieval_policy: {
      can_refine_and_search_again: true,
      requires_user_permission_for_independent_reasoning: finalWorkflowStatus !== 'supported',
      instructions: [
        'The LLM may inspect items, matched_terms, evidence_text, and neighbor_context to produce a revised suggested_queries array and call this tool again.',
        'The revised queries should target gaps, missing primitives, and promising technical tools surfaced by the current evidence packet.',
        'If the original problem is not directly supported, the agent may submit candidate_solution and method_check_queries to verify that the solution methods are inside the selected corpus boundary.',
        'If method_boundary_check.can_answer_with_labeled_method_guided_reasoning is true, answer with a clear label that the original problem was not directly found in the knowledge base and that the final derivation is independent/method-guided reasoning, not a verbatim knowledge-base answer.',
        'If answerability.status is related_only or not_found and method_boundary_check is not within_corpus_methods, do not give a final independent answer until the user permits independent reasoning.',
        'Keep direct_model_primitive evidence separate from technical_tool/background evidence in any later explanation.',
      ],
      next_call_template: {
        db_name: input.db_name ?? null,
        problem: input.problem,
        suggested_queries: suggestedFollowupQueries,
        retrieval_profile: retrievalProfile,
        per_query_top_k: Math.max(perQueryTopK, 12),
        max_items: input.max_items ?? (retrievalProfile === 'strict_evidence' ? input.top_k ?? 8 : 20),
        deduplicate_by: input.deduplicate_by ?? 'page',
        strict: input.strict ?? retrievalProfile === 'strict_evidence',
      },
    },
    suggested_followup_queries: suggestedFollowupQueries,
    retrieval_diagnostics: {
      per_query_top_k: perQueryTopK,
      max_items: input.max_items ?? (retrievalProfile === 'strict_evidence' ? input.top_k ?? 8 : 20),
      term_top_k: termTopK,
      technical_result_items: technicalItems.length,
      term_items_returned: combinedContext.items.filter((item: Record<string, any>) => item.item_type === 'technical_result').length,
      deduplicate_by: input.deduplicate_by ?? 'page',
      min_items_if_available: input.min_items_if_available ?? (retrievalProfile === 'strict_evidence' ? 0 : 12),
      include_books: input.include_books ?? true,
      include_papers: input.include_papers ?? true,
      include_terms: input.include_terms ?? true,
      include_index_hits: input.include_index_hits ?? false,
      index_hits_note: input.include_index_hits ? 'Index/table-of-contents extraction is not implemented yet; returned items are chunk/page retrieval hits.' : undefined,
    },
    evidence_pages: evidencePages,
    message: searchTermsMessage(finalWorkflowStatus, supportType),
  });
  });
}

export async function checkReasonable(input: {
  db_name?: string | null;
  problem: string;
  answer: string;
  topic_terms?: string[];
  technical_queries?: string[];
  min_supported_queries?: number;
  per_query_top_k?: number;
  filters?: Filters;
  context_window?: number;
}) {
  return withSelectedDb(input.db_name ?? null, async selection => {
  if (selection.required) return selection.response;
  const profile = knowledgeBaseIdentity().profile;
  if (profile.scope_policy === 'open_research' || profile.method_boundary === 'open_with_citations') {
    return withKnowledgeBase({
      reasonable: true,
      status: 'reasonable',
      corpus_scope: profile.scope_policy,
      check_required: false,
      reason: 'The selected knowledge base is an open corpus profile; independent reasoning is allowed when labeled and separated from citations.',
    });
  }

  const technicalQueries = extractReasoningTechnicalQueries({
    problem: input.problem,
    answer: input.answer,
    topic_terms: input.topic_terms,
    technical_queries: input.technical_queries,
  });
  if (technicalQueries.length === 0) {
    return withKnowledgeBase({
      reasonable: true,
      status: 'reasonable',
      corpus_scope: profile.scope_policy,
      check_required: true,
      technical_queries: [],
      reason: 'No non-topic technical method terms were detected in the independent answer.',
    });
  }

  const perQueryTopK = input.per_query_top_k ?? 8;
  const queryResults = [];
  for (const query of technicalQueries) {
    queryResults.push(await search({
      query,
      mode: 'text',
      retrieval_profile: 'strict_evidence',
      top_k: perQueryTopK,
      db_name: input.db_name ?? null,
      filters: input.filters ?? {},
      context_window: input.context_window ?? 1,
      include_text: true,
      strict: true,
    }));
  }

  const checkedQueries = queryResults.map(result => {
    const evidence = methodEvidenceFromQueryResult(result);
    return {
      query: String(result.query ?? ''),
      supported: evidence !== null,
      support_level: evidence?.support_level ?? 'not_found',
      matched_terms: evidence?.matched_terms ?? result.answerability?.matched_terms ?? [],
      evidence_locations: evidence?.citations ?? [],
      answerability_status: result.answerability?.status ?? 'not_found',
      evidence_grade: result.answerability?.evidence_grade ?? 'none',
    };
  });
  const supportedQueries = checkedQueries.filter(item => item.supported);
  const required = Math.min(
    technicalQueries.length,
    Math.max(1, input.min_supported_queries ?? technicalQueries.length),
  );
  const unsupportedQueries = checkedQueries.filter(item => !item.supported);
  const reasonable = supportedQueries.length >= required && unsupportedQueries.length === 0;

  return withKnowledgeBase({
    reasonable,
    status: reasonable ? 'reasonable' : 'over_scope',
    corpus_scope: profile.scope_policy,
    check_required: true,
    original_problem: input.problem,
    technical_queries: technicalQueries,
    checked_queries: checkedQueries,
    unsupported_queries: unsupportedQueries.map(item => item.query),
    supported_queries: supportedQueries.map(item => item.query),
    min_supported_queries: required,
    query_results: queryResults,
    reason: reasonable
      ? 'Every detected non-topic technical method query was found in the selected closed corpus.'
      : 'At least one detected non-topic technical method query was not found in the selected closed corpus, so the independent answer may be over scope.',
  });
  });
}

export function extractReasoningTechnicalQueries(input: {
  problem: string;
  answer: string;
  topic_terms?: string[];
  technical_queries?: string[];
}) {
  const suppliedQueries = (input.technical_queries ?? []).map(query => query.trim()).filter(Boolean);
  if (suppliedQueries.length > 0) return [...new Set(suppliedQueries)];

  const topicTerms = new Set([
    ...extractQueryTerms(input.problem).terms,
    ...(input.topic_terms ?? []).flatMap(term => extractQueryTerms(term).terms),
  ].map(term => normalize(term)));
  const answer = input.answer;
  const queries: string[] = [];

  for (const item of reasoningTechniquePhrases) {
    if (!item.pattern.test(answer)) continue;
    const queryTerms = extractQueryTerms(item.query).terms.map(term => normalize(term));
    const isPureTopic = queryTerms.length > 0 && queryTerms.every(term => topicTerms.has(term));
    if (!isPureTopic) queries.push(item.query);
  }

  for (const term of extractQueryTerms(answer).key_terms) {
    const normalized = normalize(term);
    if (topicTerms.has(normalized)) continue;
    if (stopwords.has(normalized) || methodCheckGenericTerms.has(normalized)) continue;
    if (!methodCheckCoreTerms.has(normalized)) continue;
    queries.push(normalized);
  }

  return [...new Set(queries)].slice(0, 12);
}

export async function buildTechnicalIndex(input: {
  db_name?: string | null;
  doc_id?: string | null;
  doc_kind?: 'all' | 'paper' | 'book';
  result_types?: string[] | null;
  dry_run?: boolean;
  write?: boolean;
  replace?: boolean;
  include_text?: boolean;
  sample_limit?: number;
  max_results?: number;
}) {
  return withSelectedDb(input.db_name ?? null, async selection => {
  if (selection.required) return selection.response;
  const dryRun = input.dry_run ?? true;
  const write = input.write ?? false;
  const includeText = input.include_text ?? false;
  const sampleLimit = input.sample_limit ?? 20;
  const maxResults = input.max_results ?? 10000;
  const index = await loadIndex();
  const docs = new Map(index.documents.map(doc => [doc.doc_id, doc]));
  const requestedTypes = input.result_types?.length
    ? new Set(input.result_types.map(type => type.toLowerCase()))
    : null;
  const selectedDocs = index.documents.filter(doc => {
    if (input.doc_id && doc.doc_id !== input.doc_id) return false;
    const kind = classifyDocumentKind(doc);
    if (input.doc_kind && input.doc_kind !== 'all' && input.doc_kind !== kind) return false;
    return true;
  });
  const selectedDocIds = new Set(selectedDocs.map(doc => doc.doc_id));
  const selectedIndex: KnowledgeIndex = {
    documents: selectedDocs,
    pages: index.pages.filter(page => selectedDocIds.has(page.doc_id)),
    chunks: index.chunks.filter(chunk => selectedDocIds.has(chunk.doc_id)),
  };
  let results = extractTechnicalResults(selectedIndex, docs)
    .filter(result => !requestedTypes || requestedTypes.has(result.result_type));
  if (results.length > maxResults) results = results.slice(0, maxResults);

  let writeStatus: Record<string, unknown> = {
    status: dryRun || !write ? 'dry_run_not_written' : 'pending',
    dry_run: dryRun,
    write_requested: write,
  };
  if (write && !dryRun) {
    writeStatus = await writeTechnicalResults(results, {
      replace: input.replace ?? true,
      docIds: [...selectedDocIds],
    });
  }

  const byType = countBy(results, result => result.result_type);
  const byDocKind = countBy(results, result => result.doc_kind);
  const byDoc = [...countBy(results, result => result.doc_id).entries()]
    .map(([doc_id, count]) => ({ doc_id, title: docs.get(doc_id)?.title ?? doc_id, doc_kind: docs.get(doc_id) ? classifyDocumentKind(docs.get(doc_id)!) : 'paper', count }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
  return withKnowledgeBase({
    status: 'technical_index_preview',
    extraction_method: 'regex_technical_results_v1',
    mutation_policy: {
      default_is_dry_run: true,
      current_call_wrote_to_database: Boolean(write && !dryRun),
      write_requires: { dry_run: false, write: true },
    },
    lineage_interface: {
      reserved_result_fields: ['source_links', 'derived_from', 'relation_candidates'],
      reserved_table: 'technical_result_links',
      intended_use: 'Future OKF-style links can connect a paper result to a book theorem, prior theorem, formula, or proof dependency without changing the result schema.',
    },
    filters: {
      doc_id: input.doc_id ?? null,
      doc_kind: input.doc_kind ?? 'all',
      result_types: input.result_types ?? null,
      max_results: maxResults,
    },
    counts: {
      documents_scanned: selectedDocs.length,
      pages_scanned: selectedIndex.pages.length,
      chunks_scanned: selectedIndex.chunks.length,
      technical_results: results.length,
      by_doc_kind: Object.fromEntries(byDocKind),
      by_result_type: Object.fromEntries([...byType.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    },
    top_documents: byDoc.slice(0, 25),
    write_status: writeStatus,
    samples: results.slice(0, sampleLimit).map(result => technicalResultForOutput(result, includeText)),
  });
  });
}

export async function searchTechnicalResults(input: {
  db_name?: string | null;
  query: string;
  doc_id?: string | null;
  doc_kind?: 'all' | 'paper' | 'book';
  result_types?: string[] | null;
  top_k?: number;
  include_text?: boolean;
  include_formula_context?: boolean;
  formula_context_chars?: number;
  include_related_definitions?: boolean;
  definition_context_window?: number;
  max_scan_results?: number;
}) {
  return withSelectedDb(input.db_name ?? null, async selection => {
  if (selection.required) return selection.response;
  const includeText = input.include_text ?? true;
  const includeFormulaContext = input.include_formula_context ?? true;
  const formulaContextChars = input.formula_context_chars ?? 900;
  const includeRelatedDefinitions = input.include_related_definitions ?? true;
  const definitionContextWindow = input.definition_context_window ?? 3;
  const topK = input.top_k ?? 20;
  const maxScanResults = input.max_scan_results ?? 50000;
  const index = await loadIndex();
  const docs = new Map(index.documents.map(doc => [doc.doc_id, doc]));
  const requestedTypes = input.result_types?.length
    ? new Set(input.result_types.map(type => type.toLowerCase()))
    : null;
  const selectedDocs = index.documents.filter(doc => {
    if (input.doc_id && doc.doc_id !== input.doc_id) return false;
    const kind = classifyDocumentKind(doc);
    if (input.doc_kind && input.doc_kind !== 'all' && input.doc_kind !== kind) return false;
    return true;
  });
  const selectedDocIds = new Set(selectedDocs.map(doc => doc.doc_id));
  const selectedIndex: KnowledgeIndex = {
    documents: selectedDocs,
    pages: index.pages.filter(page => selectedDocIds.has(page.doc_id)),
    chunks: index.chunks.filter(chunk => selectedDocIds.has(chunk.doc_id)),
  };
  const extractedResults = extractTechnicalResults(selectedIndex, docs);
  let candidates = extractedResults
    .filter(result => !requestedTypes || requestedTypes.has(result.result_type));
  if (candidates.length > maxScanResults) candidates = candidates.slice(0, maxScanResults);

  const queryAnalysis = extractQueryTerms(input.query);
  const scored = candidates
    .map(result => scoreTechnicalResult(result, queryAnalysis.terms))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.result.title.localeCompare(b.result.title))
    .slice(0, topK);
  const byType = countBy(scored.map(item => item.result), result => result.result_type);
  const byDocKind = countBy(scored.map(item => item.result), result => result.doc_kind);
  const formulaContextByResult = includeFormulaContext
    ? buildFormulaContextForResults(scored.map(item => item.result), selectedIndex, docs, formulaContextChars)
    : new Map<string, FormulaContextRecord[]>();
  const relatedDefinitionsByResult = includeRelatedDefinitions
    ? buildRelatedDefinitionContext(scored.map(item => item.result), extractedResults, definitionContextWindow)
    : new Map<string, RelatedDefinitionRecord[]>();
  return withKnowledgeBase({
    status: scored.length ? 'found' : 'not_found',
    query: input.query,
    query_terms: queryAnalysis.terms.slice(0, 30),
    extraction_method: 'regex_technical_results_v1',
    search_mode: 'dynamic_extract_then_lexical_rank',
    mutation_policy: {
      current_call_wrote_to_database: false,
      note: 'This search dynamically extracts technical results from existing pages/chunks and does not mutate the knowledge base.',
    },
    filters: {
      doc_id: input.doc_id ?? null,
      doc_kind: input.doc_kind ?? 'all',
      result_types: input.result_types ?? null,
      top_k: topK,
      include_formula_context: includeFormulaContext,
      formula_context_chars: formulaContextChars,
      include_related_definitions: includeRelatedDefinitions,
      definition_context_window: definitionContextWindow,
      max_scan_results: maxScanResults,
    },
    counts: {
      documents_scanned: selectedDocs.length,
      technical_results_scanned: candidates.length,
      returned: scored.length,
      by_doc_kind: Object.fromEntries(byDocKind),
      by_result_type: Object.fromEntries([...byType.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    },
    results: scored.map((item, index) => ({
      rank: index + 1,
      score: item.score,
      matched_terms: item.matched_terms,
      match_fields: item.match_fields,
      ...technicalResultForOutput(
        item.result,
        includeText,
        formulaContextByResult.get(item.result.result_id) ?? [],
        relatedDefinitionsByResult.get(item.result.result_id) ?? [],
      ),
    })),
  });
  });
}

export async function getChunk(input: { db_name?: string | null; chunk_id: string; context_window?: number; include_page_image?: boolean }) {
  return withSelectedDb(input.db_name ?? null, async selection => {
  if (selection.required) return selection.response;
  const index = await loadIndex();
  const docs = new Map(index.documents.map(doc => [doc.doc_id, doc]));
  const chunk = index.chunks.find(item => item.chunk_id === input.chunk_id);
  if (!chunk) throw new Error(`Chunk not found: ${input.chunk_id}`);
  const doc = mustGetDoc(docs, chunk.doc_id);
  const result: Record<string, unknown> = {
    chunk: { ...chunk, title: doc.title, citation: citation(doc, chunk.page) },
    context: neighborChunks(index, chunk.doc_id, chunk.chunk_index, input.context_window ?? 0),
  };
  if (input.include_page_image) {
    result.page_image = await renderPage({ doc_id: chunk.doc_id, page: chunk.page, dpi: 180, image_format: 'png', force: false });
  }
  return withKnowledgeBase(result);
  });
}

export async function getPageText(input: { db_name?: string | null; doc_id: string; page: number; include_chunks?: boolean }) {
  return withSelectedDb(input.db_name ?? null, async selection => {
  if (selection.required) return selection.response;
  const index = await loadIndex();
  const docs = new Map(index.documents.map(doc => [doc.doc_id, doc]));
  const doc = mustGetDoc(docs, input.doc_id);
  const page = index.pages.find(item => item.doc_id === input.doc_id && item.page === input.page);
  if (!page) throw new Error(`Page not found: ${input.doc_id} page ${input.page}`);
  const result: Record<string, unknown> = {
    doc_id: input.doc_id,
    title: doc.title,
    page: input.page,
    text: page.text,
    citation: citation(doc, input.page),
  };
  if (input.include_chunks) {
    result.chunks = index.chunks.filter(chunk => chunk.doc_id === input.doc_id && chunk.page === input.page);
  }
  return withKnowledgeBase(result);
  });
}

async function collectEvidencePages(queryResults: Array<Record<string, any>>, maxPages: number) {
  const byPage = new Map<string, any>();
  const evidencePages = [];
  for (const queryResult of queryResults) {
    if (queryResult.answerability?.status !== 'supported') continue;
    for (const result of queryResult.results ?? []) {
      const key = `${result.doc_id}:${result.page}`;
      const existing = byPage.get(key);
      if (existing) {
        existing.matched_queries = [...new Set([...existing.matched_queries, queryResult.query])];
        existing.matched_terms = [...new Set([...existing.matched_terms, ...(result.matched_terms ?? [])])];
        continue;
      }
      const page = await getPageText({ doc_id: result.doc_id, page: result.page, include_chunks: true });
      const evidencePage = {
        doc_id: result.doc_id,
        title: result.title,
        page: result.page,
        citation: result.citation,
        matched_queries: [queryResult.query],
        matched_terms: result.matched_terms ?? [],
        text: page.text,
        chunks: page.chunks,
      };
      byPage.set(key, evidencePage);
      evidencePages.push(evidencePage);
      if (evidencePages.length >= maxPages) return evidencePages;
    }
  }
  return evidencePages;
}

export function extractTechnicalResults(index: KnowledgeIndex, docs: Map<string, DocumentRecord>) {
  const results: TechnicalResultRecord[] = [];
  const pagesByDoc = groupBy(index.pages, page => page.doc_id);
  const chunksByDoc = groupBy(index.chunks, chunk => chunk.doc_id);
  for (const doc of index.documents) {
    const pages = (pagesByDoc.get(doc.doc_id) ?? []).sort((a, b) => a.page - b.page);
    if (!pages.length) continue;
    const chunks = (chunksByDoc.get(doc.doc_id) ?? []).sort((a, b) => a.chunk_index - b.chunk_index);
    const combined = combineDocumentPages(pages);
    const matches = [...combined.text.matchAll(technicalResultStartRegex())];
    for (let indexInDoc = 0; indexInDoc < matches.length; indexInDoc += 1) {
      const match = matches[indexInDoc];
      const start = match.index ?? 0;
      const nextStart = matches[indexInDoc + 1]?.index ?? combined.text.length;
      const rawBlock = combined.text.slice(start, Math.min(nextStart, start + 9000)).trim();
      const parsed = parseTechnicalResultHeader(match[1] ?? '');
      if (!parsed) continue;
      const statementText = cleanTechnicalText(extractStatementText(rawBlock));
      if (!isUsefulTechnicalStatement(statementText)) continue;
      const pageStart = pageAtOffset(combined.pageOffsets, start);
      const pageEnd = pageAtOffset(combined.pageOffsets, Math.min(nextStart, start + rawBlock.length));
      const sectionTitle = nearestSectionTitle(combined.text.slice(Math.max(0, start - 2500), start));
      const proofText = extractProofText(rawBlock);
      const formulaRefs = extractFormulaRefs(rawBlock);
      const nearbyTerms = technicalNearbyTerms(statementText);
      const assumptionText = inferAssumptionText(statementText);
      const conclusionText = inferConclusionText(statementText);
      const chunkIds = chunks
        .filter(chunk => chunk.page >= pageStart && chunk.page <= pageEnd)
        .map(chunk => chunk.chunk_id);
      results.push({
        result_id: technicalResultId(doc.doc_id, parsed.resultType, parsed.resultNumber, pageStart, statementText),
        doc_id: doc.doc_id,
        title: doc.title,
        doc_kind: classifyDocumentKind(doc),
        result_type: parsed.resultType,
        result_number: parsed.resultNumber,
        result_label: parsed.resultLabel,
        page_start: pageStart,
        page_end: pageEnd,
        chunk_ids: chunkIds,
        section_title: sectionTitle,
        statement_text: statementText,
        proof_text: proofText,
        formula_refs: formulaRefs,
        nearby_terms: nearbyTerms,
        assumption_text: assumptionText,
        conclusion_text: conclusionText,
        extraction_method: 'regex_technical_results_v1',
        source_links: [],
        derived_from: [],
        relation_candidates: [],
      });
    }
  }
  return dedupeTechnicalResults(results);
}

function technicalResultStartRegex() {
  return /(?:^|\n)\s*((?:Theorem|THEOREM|Lemma|LEMMA|Proposition|PROPOSITION|Corollary|COROLLARY|Claim|CLAIM|Definition|DEFINITION|Assumption|ASSUMPTION|Axiom|AXIOM|Fact|FACT|Observation|OBSERVATION|Example|EXAMPLE|Conjecture|CONJECTURE)\s+(?:(?:[A-Z]?\d+(?:\.\d+)*|[IVXLCDM]+|[A-Z])\b(?:\s*\([^)]{1,180}\))?[\.:]|\([^)]{1,180}\)[\.:]))/g;
}

function parseTechnicalResultHeader(header: string) {
  const match = header.trim().match(/^(Theorem|Lemma|Proposition|Corollary|Claim|Definition|Assumption|Axiom|Fact|Observation|Example|Conjecture)\s*([A-Z]?\d+(?:\.\d+)*|[IVXLCDM]+|[A-Z])?/i);
  if (!match) return null;
  return {
    resultType: match[1].toLowerCase(),
    resultNumber: match[2] ?? null,
    resultLabel: header.replace(/\s+/g, ' ').trim(),
  };
}

function combineDocumentPages(pages: PageRecord[]) {
  let text = '';
  const pageOffsets: Array<{ page: number; start: number; end: number }> = [];
  for (const page of pages) {
    const prefix = text ? '\n\n' : '';
    const start = text.length + prefix.length;
    text += `${prefix}${page.text}`;
    pageOffsets.push({ page: page.page, start, end: text.length });
  }
  return { text, pageOffsets };
}

function pageAtOffset(pageOffsets: Array<{ page: number; start: number; end: number }>, offset: number) {
  return pageOffsets.find(item => offset >= item.start && offset <= item.end)?.page ?? pageOffsets[pageOffsets.length - 1]?.page ?? 1;
}

function nearestSectionTitle(textBefore: string) {
  const lines = textBefore.split('\n').map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].replace(/\s+/g, ' ');
    if (line.length < 4 || line.length > 140) continue;
    if (/^(abstract|references|appendix|proofs?)$/i.test(line)) return line;
    if (/^(?:\d+(?:\.\d+)*|[IVXLCDM]+)\.?\s+[A-Z][A-Za-z0-9 ,:;()'’\-/]{3,}$/.test(line)) return line;
    if (/^[A-Z][A-Za-z0-9 ,:;()'’\-/]{3,}$/.test(line) && !/[.!?]$/.test(line) && line.split(/\s+/).length <= 12) return line;
  }
  return null;
}

function extractStatementText(rawBlock: string) {
  const proofIndex = rawBlock.search(/\n\s*(Proof|Proof\.|Proof:|Demonstration|Sketch of proof)\b/i);
  const statement = proofIndex >= 0 ? rawBlock.slice(0, proofIndex) : rawBlock;
  return statement.slice(0, 5000);
}

function extractProofText(rawBlock: string) {
  const proofIndex = rawBlock.search(/\n\s*(Proof|Proof\.|Proof:|Demonstration|Sketch of proof)\b/i);
  if (proofIndex < 0) return null;
  return cleanTechnicalText(rawBlock.slice(proofIndex, proofIndex + 5000));
}

function cleanTechnicalText(text: string) {
  return text
    .replace(/Downloaded from https?:\/\/\S+/gi, '')
    .replace(/See the Terms and Conditions.*?(?=\n|$)/gi, '')
    .replace(/\bRAND\s*C?\s*2014\.?/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function isUsefulTechnicalStatement(text: string) {
  if (text.length < 40) return false;
  if (/^(Theorem|Lemma|Proposition|Corollary|Claim|Definition|Assumption|Axiom|Fact|Observation|Example|Conjecture)\s*$/i.test(text)) return false;
  return true;
}

function extractFormulaRefs(text: string) {
  const refs = text.match(/\((?:\d+(?:\.\d+)*|[A-Z]\.\d+)\)/g) ?? [];
  return [...new Set(refs.filter(ref => !isLikelyCitationYearRef(ref)).slice(0, 30))];
}

function isLikelyCitationYearRef(ref: string) {
  const numeric = ref.match(/^\((\d{4})\)$/);
  if (!numeric) return false;
  const year = Number(numeric[1]);
  return year >= 1500 && year <= 2099;
}

function technicalNearbyTerms(text: string) {
  const preferred = [
    'equilibrium', 'pbe', 'belief', 'posterior', 'cutoff', 'threshold', 'incentive',
    'compatibility', 'individual rationality', 'disclosure', 'message', 'signal',
    'type', 'state', 'mechanism', 'martingale', 'bayes', 'plausibility', 'optimal',
    'continues', 'stops', 'separating', 'pooling', 'truthful', 'verifiable',
  ];
  const normalized = normalize(text);
  const hits = preferred.filter(term => normalized.includes(term));
  const queryTerms = extractQueryTerms(text).terms
    .filter(term => term.length > 4 && !hits.includes(term))
    .slice(0, 12);
  return [...new Set([...hits, ...queryTerms])].slice(0, 20);
}

function inferAssumptionText(text: string) {
  const sentences = splitSentences(text);
  const assumption = sentences.find(sentence => /\b(let|suppose|assume|if|under|provided|given|when|whenever|condition)\b/i.test(sentence));
  return assumption ? truncateToApproxTokens(assumption, 80) : null;
}

function inferConclusionText(text: string) {
  const sentences = splitSentences(text);
  const conclusion = sentences.find(sentence => /\b(if and only if|then|there exists|unique|optimal|equilibrium|continues|stops|discloses|satisfies|implies|is|are)\b/i.test(sentence));
  return conclusion ? truncateToApproxTokens(conclusion, 100) : null;
}

function splitSentences(text: string) {
  return text
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map(sentence => sentence.trim())
    .filter(Boolean);
}

function technicalResultId(docId: string, resultType: string, resultNumber: string | null, pageStart: number, statementText: string) {
  return `${docId}:${resultType}:${resultNumber ?? 'unnumbered'}:p${pageStart}:${sha256Text(statementText).slice(0, 12)}`;
}

function dedupeTechnicalResults(results: TechnicalResultRecord[]) {
  const seen = new Set<string>();
  const deduped: TechnicalResultRecord[] = [];
  for (const result of results) {
    const key = `${result.doc_id}:${result.result_type}:${result.result_number ?? result.result_label}:${result.page_start}:${result.statement_text.slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(result);
  }
  return deduped;
}

function buildFormulaContextForResults(
  results: TechnicalResultRecord[],
  index: KnowledgeIndex,
  docs: Map<string, DocumentRecord>,
  contextChars: number,
) {
  const pagesByDoc = groupBy(index.pages, page => page.doc_id);
  const cache = new Map<string, FormulaContextRecord | null>();
  const output = new Map<string, FormulaContextRecord[]>();
  for (const result of results) {
    const contexts: FormulaContextRecord[] = [];
    for (const formulaRef of result.formula_refs.slice(0, 10)) {
      const key = `${result.doc_id}:${formulaRef}`;
      if (!cache.has(key)) {
        cache.set(key, findFormulaContext(result.doc_id, formulaRef, pagesByDoc.get(result.doc_id) ?? [], docs, contextChars));
      }
      const context = cache.get(key);
      if (context) contexts.push(context);
    }
    output.set(result.result_id, contexts);
  }
  return output;
}

function buildRelatedDefinitionContext(
  results: TechnicalResultRecord[],
  allResults: TechnicalResultRecord[],
  pageWindow: number,
) {
  const definitions = allResults.filter(result => ['definition', 'assumption', 'axiom'].includes(result.result_type));
  const output = new Map<string, RelatedDefinitionRecord[]>();
  for (const result of results) {
    const related = definitions
      .filter(definition => definition.doc_id === result.doc_id)
      .filter(definition => Math.abs(definition.page_start - result.page_start) <= pageWindow || Math.abs(definition.page_end - result.page_end) <= pageWindow)
      .sort((a, b) => Math.abs(a.page_start - result.page_start) - Math.abs(b.page_start - result.page_start) || a.page_start - b.page_start)
      .slice(0, 8)
      .map(definition => ({
        result_id: definition.result_id,
        result_label: definition.result_label,
        result_type: definition.result_type,
        page_start: definition.page_start,
        page_end: definition.page_end,
        citation: `${definition.title}, pp. ${definition.page_start}${definition.page_end === definition.page_start ? '' : `-${definition.page_end}`}`,
        statement_preview: truncateToApproxTokens(definition.statement_text, 90),
      }));
    output.set(result.result_id, related);
  }
  return output;
}

function findFormulaContext(
  docId: string,
  formulaRef: string,
  pages: PageRecord[],
  docs: Map<string, DocumentRecord>,
  contextChars: number,
): FormulaContextRecord | null {
  const escaped = escapeRegExp(formulaRef);
  const pattern = new RegExp(escaped, 'g');
  let best: { page: PageRecord; index: number; score: number } | null = null;
  for (const page of pages) {
    for (const match of page.text.matchAll(pattern)) {
      const index = match.index ?? 0;
      const snippet = page.text.slice(Math.max(0, index - 220), Math.min(page.text.length, index + 220));
      if (looksLikeBibliographicCitation(snippet, formulaRef)) continue;
      const score = formulaContextScore(snippet, index, page.text, formulaRef);
      if (!best || score > best.score + 3 || (score >= best.score - 3 && page.page < best.page.page)) {
        best = { page, index, score };
      }
    }
  }
  if (!best) return null;
  const doc = docs.get(docId);
  const text = extractFormulaSnippet(best.page.text, best.index, contextChars);
  return {
    formula_ref: formulaRef,
    page: best.page.page,
    citation: `${doc?.title ?? docId}, p. ${best.page.page}`,
    text,
  };
}

function formulaContextScore(snippet: string, index: number, pageText: string, formulaRef: string) {
  let score = 0;
  const localStart = Math.max(0, index - 140);
  const localEnd = Math.min(pageText.length, index + formulaRef.length + 80);
  const local = pageText.slice(localStart, localEnd);
  const normalized = normalize(local);
  if (/[=≤≥<>≡]/.test(local)) score += 6;
  if (/\b(if and only if|iff|condition|equation|where|defined|define|holds|satisfied)\b/.test(normalized)) score += 3;
  if (/\b(proposition|lemma|theorem|definition)\b/.test(normalized)) score += 2;
  const lineStart = pageText.lastIndexOf('\n', index);
  const lineEnd = pageText.indexOf('\n', index);
  const line = pageText.slice(lineStart + 1, lineEnd < 0 ? pageText.length : lineEnd);
  if (line.trim().replace(/[.;,]$/, '').endsWith(formulaRef)) score += 8;
  if (/\bcondition\s+\(\d+(?:\.\d+)*\)/i.test(local) && !/[=≤≥<>≡]/.test(local)) score -= 4;
  if (index < pageText.length * 0.75) score += 1;
  return score;
}

function looksLikeBibliographicCitation(snippet: string, formulaRef: string) {
  if (!isLikelyCitationYearRef(formulaRef)) return false;
  return /\b[A-Z][A-Za-z]+(?:\s+and\s+[A-Z][A-Za-z]+)?\s*,?\s*$/.test(snippet.slice(0, snippet.indexOf(formulaRef)));
}

function extractFormulaSnippet(text: string, index: number, contextChars: number) {
  const halfWindow = Math.max(120, Math.floor(contextChars / 2));
  const start = Math.max(0, index - halfWindow);
  const end = Math.min(text.length, index + halfWindow);
  return cleanTechnicalText(text.slice(start, end)).replace(/\n{3,}/g, '\n\n');
}

function technicalResultForOutput(
  result: TechnicalResultRecord,
  includeText: boolean,
  formulaContext: FormulaContextRecord[] = [],
  relatedDefinitions: RelatedDefinitionRecord[] = [],
) {
  const base: Record<string, unknown> = {
    result_id: result.result_id,
    doc_id: result.doc_id,
    title: result.title,
    doc_kind: result.doc_kind,
    result_type: result.result_type,
    result_number: result.result_number,
    result_label: result.result_label,
    page_start: result.page_start,
    page_end: result.page_end,
    chunk_ids: result.chunk_ids,
    section_title: result.section_title,
    formula_refs: result.formula_refs,
    formula_context: formulaContext,
    related_definitions: relatedDefinitions,
    nearby_terms: result.nearby_terms,
    assumption_text: result.assumption_text,
    conclusion_text: result.conclusion_text,
    extraction_method: result.extraction_method,
    source_links: result.source_links,
    derived_from: result.derived_from,
    relation_candidates: result.relation_candidates,
    citation: `${result.title}, pp. ${result.page_start}${result.page_end === result.page_start ? '' : `-${result.page_end}`}`,
  };
  if (includeText) {
    base.statement_text = result.statement_text;
    base.proof_text = result.proof_text;
  } else {
    base.statement_preview = truncateToApproxTokens(result.statement_text, 80);
  }
  return base;
}

function scoreTechnicalResult(result: TechnicalResultRecord, queryTerms: string[]) {
  const fields = {
    label: result.result_label,
    title: result.title,
    section: result.section_title ?? '',
    statement: result.statement_text,
    assumption: result.assumption_text ?? '',
    conclusion: result.conclusion_text ?? '',
    nearby_terms: result.nearby_terms.join(' '),
    formula_refs: result.formula_refs.join(' '),
  };
  const weights: Record<keyof typeof fields, number> = {
    label: 3,
    title: 2,
    section: 2,
    statement: 5,
    assumption: 4,
    conclusion: 5,
    nearby_terms: 3,
    formula_refs: 1,
  };
  const matchedTerms = new Set<string>();
  const matchFields = new Set<string>();
  let score = resultTypeSearchWeight(result.result_type);
  for (const term of queryTerms) {
    for (const [field, value] of Object.entries(fields) as Array<[keyof typeof fields, string]>) {
      const count = countTerm(value, term);
      if (!count) continue;
      matchedTerms.add(term);
      matchFields.add(field);
      score += weights[field] * Math.min(count, 4);
    }
  }
  if (matchedTerms.size === 0) score = 0;
  return {
    result,
    score,
    matched_terms: [...matchedTerms].sort(),
    match_fields: [...matchFields].sort(),
  };
}

function resultTypeSearchWeight(resultType: string) {
  const weights: Record<string, number> = {
    theorem: 8,
    proposition: 8,
    lemma: 7,
    corollary: 6,
    claim: 5,
    definition: 4,
    assumption: 3,
    axiom: 3,
    observation: 2,
    fact: 2,
    example: 1,
    conjecture: 1,
  };
  return weights[resultType] ?? 1;
}

async function writeTechnicalResults(results: TechnicalResultRecord[], input: { replace: boolean; docIds: string[] }) {
  const connection = await connectDb();
  const createdAt = new Date().toISOString();
  try {
    await ensureTechnicalResultSchema(connection);
    await connection.run('begin transaction');
    if (input.replace && input.docIds.length) {
      const placeholders = input.docIds.map((_, index) => `$${index + 1}`).join(', ');
      await connection.run(`delete from technical_result_links where source_result_id in (select result_id from technical_results where doc_id in (${placeholders}))`, input.docIds);
      await connection.run(`delete from technical_results where doc_id in (${placeholders})`, input.docIds);
    }
    for (const result of results) {
      await connection.run(
        `insert or replace into technical_results
          (result_id, doc_id, title, doc_kind, result_type, result_number, result_label, page_start, page_end, chunk_ids_json,
           section_title, statement_text, proof_text, formula_refs_json, nearby_terms_json, assumption_text, conclusion_text,
           extraction_method, source_links_json, derived_from_json, relation_candidates_json, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
        [
          result.result_id,
          result.doc_id,
          result.title,
          result.doc_kind,
          result.result_type,
          result.result_number,
          result.result_label,
          result.page_start,
          result.page_end,
          JSON.stringify(result.chunk_ids),
          result.section_title,
          result.statement_text,
          result.proof_text,
          JSON.stringify(result.formula_refs),
          JSON.stringify(result.nearby_terms),
          result.assumption_text,
          result.conclusion_text,
          result.extraction_method,
          JSON.stringify(result.source_links),
          JSON.stringify(result.derived_from),
          JSON.stringify(result.relation_candidates),
          createdAt,
        ],
      );
    }
    await connection.run('commit');
    return {
      status: 'written',
      replaced_existing_for_doc_ids: input.replace ? input.docIds.length : 0,
      technical_results_written: results.length,
      tables: ['technical_results', 'technical_result_links'],
    };
  } catch (error) {
    await connection.run('rollback').catch(() => undefined);
    throw error;
  } finally {
    connection.disconnectSync();
  }
}

async function ensureTechnicalResultSchema(connection: Awaited<ReturnType<DuckDBInstance['connect']>>) {
  await connection.run(`
    create table if not exists technical_results (
      result_id varchar primary key,
      doc_id varchar not null,
      title varchar not null,
      doc_kind varchar not null,
      result_type varchar not null,
      result_number varchar,
      result_label varchar not null,
      page_start integer not null,
      page_end integer not null,
      chunk_ids_json varchar not null,
      section_title varchar,
      statement_text varchar not null,
      proof_text varchar,
      formula_refs_json varchar not null,
      nearby_terms_json varchar not null,
      assumption_text varchar,
      conclusion_text varchar,
      extraction_method varchar not null,
      source_links_json varchar not null,
      derived_from_json varchar not null,
      relation_candidates_json varchar not null,
      created_at varchar not null
    )
  `);
  await connection.run(`
    create table if not exists technical_result_links (
      link_id varchar primary key,
      source_result_id varchar not null,
      target_result_id varchar,
      target_doc_id varchar,
      target_label varchar,
      link_type varchar not null,
      confidence double,
      notes varchar,
      metadata_json varchar not null,
      created_at varchar not null
    )
  `);
}

function groupBy<T>(items: T[], keyFn: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

function countBy<T>(items: T[], keyFn: (item: T) => string) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export async function renderPage(
  input: { db_name?: string | null; doc_id: string; page: number; dpi?: number; image_format?: 'png' | 'jpg' | 'jpeg'; force?: boolean },
  override?: { document: DocumentRecord },
) {
  return withSelectedDb(input.db_name ?? null, async selection => {
  if (selection.required) return selection.response;
  await ensureDirs();
  const document = override?.document ?? mustGetDoc(new Map((await loadIndex()).documents.map(doc => [doc.doc_id, doc])), input.doc_id);
  const dpi = input.dpi ?? 180;
  const format = input.image_format ?? 'png';
  const extension = format === 'jpeg' ? 'jpg' : format;
  const outputDir = path.join(renderDir, slugify(knowledgeBaseIdentity().name), input.doc_id);
  await fs.mkdir(outputDir, { recursive: true });
  const outputPrefix = path.join(outputDir, `page-${String(input.page).padStart(4, '0')}-${dpi}dpi`);
  const outputPath = `${outputPrefix}.${extension}`;
  if (input.force || !(await exists(outputPath))) {
    const args = ['-f', String(input.page), '-l', String(input.page), '-r', String(dpi), '-singlefile'];
    args.push(extension === 'png' ? '-png' : '-jpeg');
    args.push(document.source_path, outputPrefix);
    await execFileAsync(pdftoppm, args);
  }
  return withKnowledgeBase({
    doc_id: input.doc_id,
    title: document.title,
    page: input.page,
    image_path: outputPath,
    mime_type: extension === 'png' ? 'image/png' : 'image/jpeg',
    citation: citation(document, input.page),
  });
  });
}

async function ensureDirs() {
  await fs.mkdir(indexDir, { recursive: true });
  await fs.mkdir(renderDir, { recursive: true });
}

function parseCatalogProfile(value: unknown, dbName: string, sourcePath: string | null, tags: string[]): KnowledgeBaseProfile | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const profile = value as Partial<KnowledgeBaseProfile>;
  if (profile.schema_version !== 1) return undefined;
  return {
    ...inferKnowledgeBaseProfile({ name: dbName, sourcePath, tags, source: 'catalog' }),
    ...profile,
    db_name: dbName,
    source: 'catalog',
    inferred_from: {
      db_name: dbName,
      source_path: sourcePath,
      tags,
      signals: Array.isArray(profile.inferred_from?.signals) ? profile.inferred_from.signals.map(String) : [],
    },
    notes: Array.isArray(profile.notes) ? profile.notes.map(String) : [],
  };
}

export function inferKnowledgeBaseProfile(input: {
  name: string;
  sourcePath: string | null;
  tags: string[];
  source: KnowledgeBaseProfile['source'];
}): KnowledgeBaseProfile {
  const haystack = [input.name, input.sourcePath ?? '', ...input.tags].join(' ').toLowerCase();
  const signals: string[] = [];
  if (/textbook|course|curriculum|school|math|教材/.test(haystack)) signals.push('school_textbook_corpus');
  if (/econ|phd|paper|论文|research|theory|mechanism|game/.test(haystack)) signals.push('research_corpus');

  const created_at = new Date().toISOString();
  const base = {
    schema_version: 1 as const,
    db_name: input.name,
    created_at,
    source: input.source,
    direct_evidence_required_for_kb_claim: true,
    must_label_independent_reasoning: true,
    inferred_from: {
      db_name: input.name,
      source_path: input.sourcePath,
      tags: input.tags,
      signals,
    },
  };

  if (signals.includes('school_textbook_corpus') && !signals.includes('research_corpus')) {
    return {
      ...base,
      scope_policy: 'closed_corpus',
      fallback_policy: 'method_guided_then_ask',
      style_policy: 'infer_from_corpus',
      method_boundary: 'corpus_internal',
      external_methods_policy: 'forbid_unlabeled',
      allow_method_guided_independent_reasoning: true,
      corpus_boundary: 'knowledge_base_internal',
      notes: [
        'Treat the selected knowledge base itself as the boundary; do not infer a broader curriculum from the name.',
        'If direct evidence is missing, first search for corpus-internal method evidence before asking to use external reasoning.',
      ],
    };
  }

  if (signals.includes('research_corpus')) {
    return {
      ...base,
      scope_policy: 'open_research',
      fallback_policy: 'allow_labeled_independent_reasoning',
      style_policy: 'academic_research',
      method_boundary: 'open_with_citations',
      external_methods_policy: 'allowed_if_labeled',
      allow_method_guided_independent_reasoning: true,
      corpus_boundary: 'knowledge_base_primary',
      notes: [
        'Use the corpus for citations, terminology, and source grounding; clearly label independent reasoning.',
        'Do not modify this profile by changing the underlying DuckDB content.',
      ],
    };
  }

  return {
    ...base,
    scope_policy: 'hybrid',
    fallback_policy: 'ask_before_external_reasoning',
    style_policy: 'infer_from_corpus',
    method_boundary: 'corpus_guided',
    external_methods_policy: 'allowed_if_labeled',
    allow_method_guided_independent_reasoning: false,
    corpus_boundary: 'knowledge_base_primary',
    notes: [
      'No strong corpus type signal was inferred; prefer asking before using external reasoning.',
    ],
  };
}

async function readDbCatalog(): Promise<DbCatalogEntry[]> {
  await ensureDirs();
  try {
    const raw = await fs.readFile(catalogPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.databases)) throw new Error('Invalid database catalog format.');
    const entries = parsed.databases.map((entry: Record<string, unknown>) => ({
      name: String(entry.name),
      duckdb_path: path.resolve(String(entry.duckdb_path)),
      created_at: String(entry.created_at),
      source_path: entry.source_path === undefined || entry.source_path === null ? null : String(entry.source_path),
      is_default: Boolean(entry.is_default),
      profile: parseCatalogProfile(entry.profile, String(entry.name), entry.source_path === undefined || entry.source_path === null ? null : String(entry.source_path), []),
    }));
    return ensureDefaultDbEntry(entries);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return ensureDefaultDbEntry([]);
  }
}

function ensureDefaultDbEntry(entries: DbCatalogEntry[]) {
  if (entries.some(entry => entry.name === defaultDbName)) {
    return entries.map(entry => ({
      ...entry,
      profile: entry.profile ?? inferKnowledgeBaseProfile({
        name: entry.name,
        sourcePath: entry.source_path ?? null,
        tags: [],
        source: 'default_backfill',
      }),
    }));
  }
  return [
    {
      name: defaultDbName,
      duckdb_path: duckDbPath,
      created_at: new Date(0).toISOString(),
      source_path: null,
      is_default: true,
      profile: inferKnowledgeBaseProfile({
        name: defaultDbName,
        sourcePath: null,
        tags: [],
        source: 'default_backfill',
      }),
    },
    ...entries,
  ];
}

async function writeDbCatalog(entries: DbCatalogEntry[]) {
  await ensureDirs();
  const deduped = ensureDefaultDbEntry(entries).filter((entry, index, all) =>
    all.findIndex(candidate => candidate.name === entry.name) === index,
  ).map(entry => ({
    ...entry,
    profile: entry.profile ?? inferKnowledgeBaseProfile({
      name: entry.name,
      sourcePath: entry.source_path ?? null,
      tags: [],
      source: 'auto_inferred',
    }),
  }));
  await fs.writeFile(catalogPath, `${JSON.stringify({ databases: deduped }, null, 2)}\n`, 'utf8');
}

async function resolveDbSelection(dbName?: string | null) {
  const current = dbContext.getStore();
  if (current && !dbName) return { entry: current };
  const catalog = await readDbCatalog();
  if (dbName) {
    const normalizedName = normalizeDbName(dbName);
    const entry = catalog.find(item => item.name === normalizedName);
    if (!entry) {
      return {
        required: true,
        response: dbSelectionRequired(catalog, `Unknown knowledge base: ${dbName}`),
      };
    }
    return { entry };
  }
  if (activeDbName) {
    const entry = catalog.find(item => item.name === activeDbName);
    if (entry) return { entry };
    activeDbName = null;
  }
  if (catalog.length === 1) return { entry: catalog[0] };
  return {
    required: true,
    response: dbSelectionRequired(catalog, 'More than one knowledge base is available. Select a db_name before searching or reading documents, or call set_active_db for this session.'),
  };
}

function dbSelectionRequired(catalog: DbCatalogEntry[], message: string) {
  return {
    status: 'db_selection_required',
    must_specify_db_name: true,
    can_set_active_db: true,
    message,
    selection_ui: {
      type: 'single_select',
      instructions: 'Show these databases in order and let the user choose one, for example with keyboard up/down selection if the client supports it.',
      options: dbSelectionOptions(catalog),
    },
    available_databases: dbSelectionOptions(catalog),
  };
}

function dbSelectionOptions(catalog: DbCatalogEntry[]) {
  return catalog.map((entry, index) => ({
    index: index + 1,
    label: entry.name,
    value: entry.name,
    name: entry.name,
    duckdb_path: entry.duckdb_path,
    is_default: Boolean(entry.is_default),
    is_active: entry.name === activeDbName,
    source_path: entry.source_path ?? null,
  }));
}

async function withSelectedDb<T>(dbName: string | null, operation: (selection: { required?: boolean; response?: any; entry?: DbCatalogEntry }) => Promise<T>) {
  const selection = await resolveDbSelection(dbName);
  if (selection.required || !selection.entry) return operation(selection);
  return withDbEntry(selection.entry, () => operation(selection));
}

async function withDbEntry<T>(entry: DbCatalogEntry, operation: () => Promise<T>) {
  return dbContext.run(entry, operation);
}

async function loadIndex(): Promise<KnowledgeIndex> {
  await ensureDirs();
  const connection = await connectDb();
  try {
    const documentRows = await queryRows<Record<string, unknown>>(connection, `
      select doc_id, title, authors_json, tags_json, source_path, canonical_pdf_name, file_sha256, page_count, created_at
      from documents
      order by created_at desc
    `);
    const pageRows = await queryRows<PageRecord>(connection, `
      select doc_id, page, text
      from pages
      order by doc_id, page
    `);
    const chunkRows = await queryRows<ChunkRecord>(connection, `
      select chunk_id, doc_id, page, chunk_index, text
      from chunks
      order by doc_id, chunk_index
    `);
    return {
      documents: documentRows.map(documentFromRow),
      pages: pageRows.map(row => ({ doc_id: row.doc_id, page: Number(row.page), text: row.text })),
      chunks: chunkRows.map(row => ({
        chunk_id: row.chunk_id,
        doc_id: row.doc_id,
        page: Number(row.page),
        chunk_index: Number(row.chunk_index),
        text: row.text,
      })),
    };
  } finally {
    connection.disconnectSync();
  }
}

async function upsertDocumentBundle(input: {
  document: DocumentRecord;
  pages: PageRecord[];
  chunks: ChunkRecord[];
  replaceExisting: boolean;
}) {
  const connection = await connectDb();
  try {
    await connection.run('begin transaction');
    if (input.replaceExisting) {
      await deleteDocumentRows(connection, input.document.doc_id);
    }

    const doc = input.document;
    await connection.run(
      `insert into documents
        (doc_id, title, authors_json, tags_json, source_path, canonical_pdf_name, file_sha256, page_count, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [doc.doc_id, doc.title, JSON.stringify(doc.authors), JSON.stringify(doc.tags), doc.source_path, doc.canonical_pdf_name, doc.file_sha256, doc.page_count, doc.created_at],
    );

    for (const page of input.pages) {
      await connection.run(
        'insert into pages (doc_id, page, text) values ($1, $2, $3)',
        [page.doc_id, page.page, page.text],
      );
    }

    const updatedAt = new Date().toISOString();
    for (const chunk of input.chunks) {
      const contentHash = sha256Text(chunk.text);
      const tokenCount = tokenizeForLength(chunk.text).length;
      await connection.run(
        'insert into chunks (chunk_id, doc_id, page, chunk_index, text, token_count, content_hash) values ($1, $2, $3, $4, $5, $6, $7)',
        [chunk.chunk_id, chunk.doc_id, chunk.page, chunk.chunk_index, chunk.text, tokenCount, contentHash],
      );
      for (const [term, frequency] of chunkTermFrequencies(chunk.text).entries()) {
        await connection.run(
          'insert into chunk_terms (chunk_id, term, frequency) values ($1, $2, $3)',
          [chunk.chunk_id, term, frequency],
        );
      }
      await connection.run(
        `insert into embedding_jobs
          (chunk_id, embedding_model, content_hash, status, updated_at, error)
         values ($1, $2, $3, $4, $5, $6)`,
        [chunk.chunk_id, 'unset', contentHash, 'pending', updatedAt, null],
      );
    }

    await connection.run('commit');
  } catch (error) {
    await connection.run('rollback').catch(() => undefined);
    throw error;
  } finally {
    connection.disconnectSync();
  }
}

async function deleteDocumentRows(connection: Awaited<ReturnType<DuckDBInstance['connect']>>, docId: string) {
  const chunkRows = await queryRows<{ chunk_id: string }>(
    connection,
    'select chunk_id from chunks where doc_id = $1',
    [docId],
  );
  if (chunkRows.length) {
    const placeholders = chunkRows.map((_, index) => `$${index + 1}`).join(', ');
    const chunkIds = chunkRows.map(row => row.chunk_id);
    await connection.run(`delete from semantic_index where chunk_id in (${placeholders})`, chunkIds);
    await connection.run(`delete from embedding_jobs where chunk_id in (${placeholders})`, chunkIds);
    await connection.run(`delete from chunk_terms where chunk_id in (${placeholders})`, chunkIds);
  }
  await connection.run('delete from chunks where doc_id = $1', [docId]);
  await connection.run('delete from pages where doc_id = $1', [docId]);
  await connection.run('delete from documents where doc_id = $1', [docId]);
}

async function connectDb() {
  await ensureDirs();
  const selectedPath = knowledgeBaseIdentity().duckdb_path;
  let instancePromise = duckDbInstancePromises.get(selectedPath);
  if (!instancePromise) {
    instancePromise = DuckDBInstance.fromCache(selectedPath);
    duckDbInstancePromises.set(selectedPath, instancePromise);
  }
  const instance = await instancePromise;
  const connection = await instance.connect();
  await ensureSchema(connection);
  return connection;
}

async function ensureSchema(connection: Awaited<ReturnType<DuckDBInstance['connect']>>) {
  await connection.run(`
    create table if not exists documents (
      doc_id varchar primary key,
      title varchar not null,
      authors_json varchar not null,
      tags_json varchar not null,
      source_path varchar not null,
      canonical_pdf_name varchar not null,
      file_sha256 varchar not null,
      page_count integer not null,
      created_at varchar not null
    )
  `);
  await connection.run(`
    create table if not exists pages (
      doc_id varchar not null,
      page integer not null,
      text varchar not null,
      primary key (doc_id, page)
    )
  `);
  await connection.run(`
    create table if not exists chunks (
      chunk_id varchar primary key,
      doc_id varchar not null,
      page integer not null,
      chunk_index integer not null,
      text varchar not null,
      token_count integer not null,
      content_hash varchar not null
    )
  `);
  await connection.run(`
    create table if not exists chunk_terms (
      chunk_id varchar not null,
      term varchar not null,
      frequency integer not null,
      primary key (chunk_id, term)
    )
  `);
  await connection.run(`
    create table if not exists embedding_jobs (
      chunk_id varchar primary key,
      embedding_model varchar not null,
      content_hash varchar not null,
      status varchar not null,
      updated_at varchar not null,
      error varchar
    )
  `);
  await connection.run(`
    create table if not exists semantic_index (
      chunk_id varchar primary key,
      embedding_model varchar not null,
      content_hash varchar not null,
      vector_index_name varchar not null,
      updated_at varchar not null
    )
  `);
}

async function queryRows<T>(connection: Awaited<ReturnType<DuckDBInstance['connect']>>, sql: string, values?: unknown[]) {
  const reader = await connection.runAndReadAll(sql, values as any);
  return reader.getRowObjectsJson() as T[];
}

export async function queryDuckDb<T>(sql: string, values?: unknown[]) {
  const connection = await connectDb();
  try {
    return await queryRows<T>(connection, sql, values);
  } finally {
    connection.disconnectSync();
  }
}

export async function runDuckDb(sql: string, values?: unknown[]) {
  const connection = await connectDb();
  try {
    await connection.run(sql, values as any);
  } finally {
    connection.disconnectSync();
  }
}

async function findDocumentById(docId: string) {
  return findOneDocument('doc_id = $1', [docId]);
}

async function findDocumentBySha(fileSha256: string) {
  return findOneDocument('file_sha256 = $1', [fileSha256]);
}

async function findOneDocument(whereClause: string, values: unknown[]) {
  const connection = await connectDb();
  try {
    const rows = await queryRows<Record<string, unknown>>(
      connection,
      `select doc_id, title, authors_json, tags_json, source_path, canonical_pdf_name, file_sha256, page_count, created_at
       from documents
       where ${whereClause}
       limit 1`,
      values,
    );
    return rows[0] ? documentFromRow(rows[0]) : null;
  } finally {
    connection.disconnectSync();
  }
}

async function countDocumentRecords(docId: string) {
  const connection = await connectDb();
  try {
    const rows = await queryRows<{ pages: string | number; chunks: string | number }>(
      connection,
      `select
        (select count(*) from pages where doc_id = $1) as pages,
        (select count(*) from chunks where doc_id = $1) as chunks`,
      [docId],
    );
    return {
      pages: Number(rows[0]?.pages ?? 0),
      chunks: Number(rows[0]?.chunks ?? 0),
    };
  } finally {
    connection.disconnectSync();
  }
}

async function countAllRecords() {
  const connection = await connectDb();
  try {
    const rows = await queryRows<{ documents: string | number; pages: string | number; chunks: string | number }>(
      connection,
      `select
        (select count(*) from documents) as documents,
        (select count(*) from pages) as pages,
        (select count(*) from chunks) as chunks`,
    );
    return {
      documents: Number(rows[0]?.documents ?? 0),
      pages: Number(rows[0]?.pages ?? 0),
      chunks: Number(rows[0]?.chunks ?? 0),
    };
  } finally {
    connection.disconnectSync();
  }
}

function documentFromRow(row: Record<string, unknown>): DocumentRecord {
  return {
    doc_id: String(row.doc_id),
    title: String(row.title),
    authors: parseJsonArray(row.authors_json),
    tags: parseJsonArray(row.tags_json),
    source_path: String(row.source_path),
    canonical_pdf_name: String(row.canonical_pdf_name),
    file_sha256: String(row.file_sha256),
    page_count: Number(row.page_count),
    created_at: String(row.created_at),
  };
}

function parseJsonArray(value: unknown) {
  if (typeof value !== 'string') return [];
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

async function removeRenderedArtifacts(document: DocumentRecord) {
  await fs.rm(path.join(renderDir, slugify(knowledgeBaseIdentity().name), document.doc_id), { recursive: true, force: true });
  await fs.rm(path.join(renderDir, document.doc_id), { recursive: true, force: true });
}

async function withIndexWriteLock<T>(operation: () => Promise<T>) {
  const run = indexWriteQueue.then(operation, operation);
  indexWriteQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function sha256File(filePath: string) {
  const hash = createHash('sha256');
  hash.update(await fs.readFile(filePath));
  return hash.digest('hex');
}

function sha256Text(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

async function getPageCount(pdfPath: string) {
  const { stdout } = await execFileAsync(pdfinfo, [pdfPath]);
  const match = stdout.match(/^Pages:\s+(\d+)/m);
  if (!match) throw new Error(`Could not read page count from ${pdfPath}`);
  return Number(match[1]);
}

async function extractPageText(pdfPath: string, page: number, tempDir: string) {
  const output = path.join(tempDir, `page-${String(page).padStart(4, '0')}.txt`);
  try {
    await execFileAsync(pdftotext, ['-layout', '-enc', 'UTF-8', '-f', String(page), '-l', String(page), pdfPath, output]);
    return (await fs.readFile(output, 'utf8')).trim();
  } finally {
    await fs.rm(output, { force: true });
  }
}

async function extractPageTextWithOptionalOcr(input: {
  pdfPath: string;
  page: number;
  tempDir: string;
  ocrMode: OcrMode;
  ocrLanguage: string;
  ocrDpi: number;
  ocrAllowed: boolean;
}) {
  const text = await extractPageText(input.pdfPath, input.page, input.tempDir);
  if (text.trim()) {
    return { text, ocr_attempted: false, ocr_succeeded: false };
  }
  if (input.ocrMode === 'never') {
    return { text, ocr_attempted: false, ocr_succeeded: false };
  }
  if (!input.ocrAllowed) {
    return {
      text,
      ocr_attempted: false,
      ocr_succeeded: false,
      warning: 'OCR page limit reached before all empty-text pages were processed.',
    };
  }
  const ocr = await ocrPage(input.pdfPath, input.page, input.tempDir, input.ocrLanguage, input.ocrDpi);
  if (!ocr.available && input.ocrMode === 'required') {
    throw new Error(ocr.warning);
  }
  return ocr;
}

async function ocrPage(pdfPath: string, page: number, tempDir: string, language: string, dpi: number) {
  const prefix = path.join(tempDir, `ocr-page-${String(page).padStart(4, '0')}`);
  const imagePath = `${prefix}.png`;
  try {
    await execFileAsync(pdftoppm, ['-f', String(page), '-l', String(page), '-r', String(dpi), '-singlefile', '-png', pdfPath, prefix]);
    const { stdout } = await execFileAsync(tesseract, [imagePath, 'stdout', '-l', language]);
    const text = stdout.trim();
    return {
      text,
      ocr_attempted: true,
      ocr_succeeded: Boolean(text),
      available: true,
      ...(text ? {} : { warning: 'OCR ran but produced no text for at least one page.' }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      text: '',
      ocr_attempted: true,
      ocr_succeeded: false,
      available: false,
      warning: `OCR requested but unavailable or failed. Install/configure tesseract or set KB_MCP_TESSERACT. Details: ${message}`,
    };
  } finally {
    await fs.rm(imagePath, { force: true });
  }
}

function splitText(text: string, chunkSize: number, chunkOverlap: number) {
  const clean = text.replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + chunkSize);
    if (end < clean.length) {
      const paragraphBreak = clean.lastIndexOf('\n\n', end);
      const sentenceBreak = Math.max(clean.lastIndexOf('. ', end), clean.lastIndexOf('。', end));
      const splitAt = paragraphBreak > start + chunkSize / 2 ? paragraphBreak : sentenceBreak;
      if (splitAt > start + chunkSize / 2) end = splitAt + 1;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(0, end - chunkOverlap);
  }
  return chunks.filter(Boolean);
}

export function textSearch(index: KnowledgeIndex, docs: Map<string, DocumentRecord>, terms: string[], limit: number, filters: Filters) {
  const candidates = index.chunks.filter(chunk => {
    const doc = docs.get(chunk.doc_id);
    return doc && passesFilters(doc, filters);
  });
  if (!terms.length || !candidates.length) return [];

  const termStats = candidates.map(chunk => {
    const text = normalize(chunk.text);
    const frequencies = new Map<string, number>();
    for (const term of terms) {
      const count = countTerm(text, term);
      if (count) frequencies.set(term, count);
    }
    return {
      chunk,
      frequencies,
      length: tokenizeForLength(text).length,
    };
  });

  const docCount = termStats.length;
  const avgDocLength = termStats.reduce((sum, item) => sum + item.length, 0) / Math.max(1, docCount);
  const documentFrequency = new Map<string, number>();
  for (const term of terms) {
    documentFrequency.set(term, termStats.filter(item => item.frequencies.has(term)).length);
  }

  const k1 = 1.5;
  const b = 0.75;
  const scored: Array<ChunkRecord & { bm25_score: number; matched_terms: string[] }> = [];
  for (const item of termStats) {
    let bm25Score = 0;
    const matched_terms: string[] = [];
    for (const [term, frequency] of item.frequencies.entries()) {
      const df = documentFrequency.get(term) ?? 0;
      if (df <= 0) continue;
      const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
      const denominator = frequency + k1 * (1 - b + b * (item.length / Math.max(1, avgDocLength)));
      bm25Score += idf * ((frequency * (k1 + 1)) / denominator);
      matched_terms.push(term);
    }
    if (bm25Score > 0) scored.push({ ...item.chunk, bm25_score: bm25Score, matched_terms });
  }

  return scored.sort((a, b) => b.bm25_score - a.bm25_score).slice(0, limit);
}

async function textSearchDb(terms: string[], limit: number, filters: Filters, docs: Map<string, DocumentRecord>) {
  const candidateDocIds = [...docs.values()]
    .filter(doc => passesFilters(doc, filters))
    .map(doc => doc.doc_id);
  if (!terms.length || !candidateDocIds.length) return [];

  const connection = await connectDb();
  try {
    const docPlaceholders = candidateDocIds.map((_, index) => `$${index + 1}`).join(', ');
    const termPlaceholders = terms.map((_, index) => `$${candidateDocIds.length + index + 1}`).join(', ');
    const values = [...candidateDocIds, ...terms];

    const corpusRows = await queryRows<{ doc_count: string | number; avg_doc_length: string | number }>(
      connection,
      `select count(*) as doc_count, avg(token_count) as avg_doc_length
       from chunks
       where doc_id in (${docPlaceholders})`,
      candidateDocIds,
    );
    const docCount = Number(corpusRows[0]?.doc_count ?? 0);
    const avgDocLength = Number(corpusRows[0]?.avg_doc_length ?? 0);
    if (!docCount || !avgDocLength) return [];

    const dfRows = await queryRows<{ term: string; document_frequency: string | number }>(
      connection,
      `select ct.term, count(distinct ct.chunk_id) as document_frequency
       from chunk_terms ct
       join chunks c on c.chunk_id = ct.chunk_id
       where c.doc_id in (${docPlaceholders}) and ct.term in (${termPlaceholders})
       group by ct.term`,
      values,
    );
    const documentFrequency = new Map(dfRows.map(row => [row.term, Number(row.document_frequency)]));

    const matchRows = await queryRows<ChunkRecord & {
      term: string;
      frequency: string | number;
      token_count: string | number;
    }>(
      connection,
      `select c.chunk_id, c.doc_id, c.page, c.chunk_index, c.text, c.token_count, ct.term, ct.frequency
       from chunk_terms ct
       join chunks c on c.chunk_id = ct.chunk_id
       where c.doc_id in (${docPlaceholders}) and ct.term in (${termPlaceholders})`,
      values,
    );

    const byChunk = new Map<string, ChunkRecord & { length: number; frequencies: Map<string, number> }>();
    for (const row of matchRows) {
      const existing = byChunk.get(row.chunk_id) ?? {
        chunk_id: row.chunk_id,
        doc_id: row.doc_id,
        page: Number(row.page),
        chunk_index: Number(row.chunk_index),
        text: row.text,
        length: Number(row.token_count),
        frequencies: new Map<string, number>(),
      };
      existing.frequencies.set(row.term, Number(row.frequency));
      byChunk.set(row.chunk_id, existing);
    }

    const k1 = 1.5;
    const b = 0.75;
    const scored: Array<ChunkRecord & { bm25_score: number; matched_terms: string[] }> = [];
    for (const item of byChunk.values()) {
      let bm25Score = 0;
      const matched_terms: string[] = [];
      for (const [term, frequency] of item.frequencies.entries()) {
        const df = documentFrequency.get(term) ?? 0;
        if (df <= 0) continue;
        const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
        const denominator = frequency + k1 * (1 - b + b * (item.length / Math.max(1, avgDocLength)));
        bm25Score += idf * ((frequency * (k1 + 1)) / denominator);
        matched_terms.push(term);
      }
      if (bm25Score > 0) {
        scored.push({
          chunk_id: item.chunk_id,
          doc_id: item.doc_id,
          page: item.page,
          chunk_index: item.chunk_index,
          text: item.text,
          bm25_score: bm25Score,
          matched_terms,
        });
      }
    }

    return scored.sort((a, b) => b.bm25_score - a.bm25_score).slice(0, limit);
  } finally {
    connection.disconnectSync();
  }
}

function chunkTermFrequencies(text: string) {
  const terms = extractQueryTerms(text).terms;
  const frequencies = new Map<string, number>();
  for (const term of terms) {
    const count = countTerm(text, term);
    if (count) frequencies.set(term, count);
  }
  return frequencies;
}

function overlapSearch(index: KnowledgeIndex, docs: Map<string, DocumentRecord>, query: string, limit: number, filters: Filters) {
  const queryTerms = new Set(extractQueryTerms(query).terms);
  return index.chunks
    .filter(chunk => {
      const doc = docs.get(chunk.doc_id);
      return doc && passesFilters(doc, filters);
    })
    .map(chunk => {
      const terms = new Set(extractQueryTerms(chunk.text).terms);
      const overlap = [...queryTerms].filter(term => terms.has(term)).length;
      return { ...chunk, overlapScore: overlap / Math.max(1, queryTerms.size) };
    })
    .filter(item => item.overlapScore > 0)
    .sort((a, b) => b.overlapScore - a.overlapScore)
    .slice(0, limit);
}

async function getSemanticIndexStatus() {
  const connection = await connectDb();
  try {
    const rows = await queryRows<{ indexed_chunks: number; total_chunks: number }>(connection, `
      select
        (select count(*)::integer from semantic_index) as indexed_chunks,
        (select count(*)::integer from chunks) as total_chunks
    `);
    const indexedChunks = Number(rows[0]?.indexed_chunks ?? 0);
    const totalChunks = Number(rows[0]?.total_chunks ?? 0);
    return {
      ready: indexedChunks > 0 && indexedChunks === totalChunks,
      indexed_chunks: indexedChunks,
      total_chunks: totalChunks,
      message: indexedChunks > 0
        ? `Semantic LanceDB side index is incomplete (${indexedChunks}/${totalChunks} chunks indexed); semantic matches are not used for answerability.`
        : 'Semantic LanceDB side index is not populated; search is using DuckDB lexical evidence only.',
    };
  } finally {
    connection.disconnectSync();
  }
}

function enrichChunk(
  index: KnowledgeIndex,
  docs: Map<string, DocumentRecord>,
  item: ChunkRecord & { score: number; match_type: string; matched_terms: string[]; bm25_score?: number; overlap_score?: number },
  includeText: boolean,
  contextWindow: number,
) {
  const doc = mustGetDoc(docs, item.doc_id);
  const result: Record<string, unknown> = {
    chunk_id: item.chunk_id,
    doc_id: item.doc_id,
    title: doc.title,
    page: item.page,
    score: item.score,
    match_type: item.match_type,
    matched_terms: item.matched_terms,
    citation: citation(doc, item.page),
  };
  if (item.bm25_score !== undefined) result.bm25_score = item.bm25_score;
  if (item.overlap_score !== undefined) result.overlap_score = item.overlap_score;
  if (includeText) result.text = item.text;
  if (contextWindow) result.context = neighborChunks(index, item.doc_id, item.chunk_index, contextWindow);
  return result;
}

export function buildResearchContextItems(input: {
  index: KnowledgeIndex;
  docs: Map<string, DocumentRecord>;
  queryResults: Array<Record<string, any>>;
  maxItems: number;
  minItemsIfAvailable?: number;
  deduplicateBy: DeduplicateBy;
  includeText: boolean;
  evidenceTextTokens: number;
  includeBooks: boolean;
  includePapers: boolean;
  includeTerms: boolean;
}) {
  const candidates: Array<Record<string, any>> = [];
  const seen = new Set<string>();
  for (const queryResult of input.queryResults) {
    const sourceResults = [
      ...(queryResult.results ?? []),
      ...(queryResult.partial_results ?? []),
    ];
    for (const result of sourceResults) {
      if (!result?.chunk_id || !result?.doc_id) continue;
      const doc = input.docs.get(result.doc_id);
      if (!doc) continue;
      const docKind = classifyDocumentKind(doc);
      if (docKind === 'book' && !input.includeBooks) continue;
      if (docKind === 'paper' && !input.includePapers) continue;
      const key = dedupeKey(result, input.deduplicateBy);
      if (seen.has(key)) continue;
      seen.add(key);
      const chunk = input.index.chunks.find(item => item.chunk_id === result.chunk_id);
      if (!chunk) continue;
      const matchedTerms = [...new Set<string>((result.matched_terms ?? []).map(String))].sort();
      const grade = classifyResearchEvidence(result, doc, matchedTerms, chunk.text);
      const contribution = contributionForEvidenceGrade(grade);
      const neighborContext = neighborChunks(input.index, chunk.doc_id, chunk.chunk_index, 1)
        .filter(item => item.chunk_id !== chunk.chunk_id)
        .map(item => ({
          chunk_id: item.chunk_id,
          page: item.page,
          text: truncateToApproxTokens(item.text, Math.max(120, Math.floor(input.evidenceTextTokens / 3))),
        }));
      const item: Record<string, any> = {
        item_id: 0,
        evidence_grade: grade,
        answerability_contribution: contribution,
        group: groupForResearchItem(grade, docKind),
        doc_kind: docKind,
        doc_id: doc.doc_id,
        title: doc.title,
        authors: doc.authors,
        tags: doc.tags,
        page: chunk.page,
        chunk_id: chunk.chunk_id,
        match_type: result.match_type ?? 'text',
        score: result.score ?? null,
        bm25_score: result.bm25_score ?? null,
        overlap_score: result.overlap_score ?? null,
        matched_queries: [queryResult.query].filter(Boolean),
        matched_terms: matchedTerms,
        why_relevant: whyRelevant(grade, matchedTerms, queryResult.query, docKind),
        how_to_use_for_reasoning: howToUseForReasoning(grade, matchedTerms),
        citation: citation(doc, chunk.page),
      };
      if (input.includeText) {
        item.evidence_text = truncateToApproxTokens(chunk.text, input.evidenceTextTokens);
        item.neighbor_context = neighborContext;
      }
      candidates.push(item);
    }
  }

  const targetCount = Math.max(input.maxItems, input.minItemsIfAvailable ?? 0);
  const sorted: Array<Record<string, any>> = candidates
    .sort((a, b) => researchItemRank(b) - researchItemRank(a))
    .slice(0, targetCount)
    .slice(0, input.maxItems)
    .map((item, index) => ({ ...item, item_id: index + 1 }));

  return {
    items: sorted,
    grouped_items: {
      papers: sorted.filter(item => item.group === 'papers'),
      books_or_textbooks: sorted.filter(item => item.group === 'books_or_textbooks'),
      technical_tools: sorted.filter(item => item.group === 'technical_tools'),
      weak_related: sorted.filter(item => item.group === 'weak_related'),
    },
  };
}

async function collectTechnicalSearchResults(input: {
  dbName: string | null;
  queries: string[];
  topK: number;
  includeText: boolean;
}) {
  const outputs = [];
  for (const query of input.queries) {
    outputs.push(await searchTechnicalResults({
      db_name: input.dbName,
      query: termSearchQuery(query),
      doc_kind: 'all',
      result_types: ['theorem', 'proposition', 'lemma', 'corollary', 'claim', 'definition', 'assumption'],
      top_k: input.topK,
      include_text: input.includeText,
      include_formula_context: true,
      include_related_definitions: true,
      definition_context_window: 3,
      max_scan_results: 50000,
    }));
  }
  return outputs;
}

function termSearchQuery(query: string) {
  const technicalTerms = [
    'theorem',
    'proposition',
    'lemma',
    'definition',
    'characterization',
    'necessary sufficient',
    'equilibrium',
    'incentive compatibility',
    'Bayes plausibility',
    'posterior martingale',
    'privacy constraint',
    'verifiable disclosure',
    'hard evidence',
    'unraveling',
  ];
  return `${query} ${technicalTerms.join(' ')}`;
}

function buildTechnicalEvidenceItems(input: {
  technicalQueryResults: Array<Record<string, any>>;
  evidenceTextTokens: number;
}) {
  const items: Array<Record<string, any>> = [];
  const seen = new Set<string>();
  for (const queryResult of input.technicalQueryResults) {
    for (const result of queryResult.results ?? []) {
      const key = result.result_id ?? `${result.doc_id}:${result.result_label}:${result.page_start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const baseScore = Number(result.score ?? 0);
      const adjustedScore = baseScore + technicalModelPrimitiveBonus(result);
      items.push({
        item_id: 0,
        item_type: 'technical_result',
        evidence_grade: 'term_or_result',
        answerability_contribution: 'helps_formalize',
        group: 'technical_tools',
        doc_kind: result.doc_kind,
        doc_id: result.doc_id,
        title: result.title,
        authors: [],
        page: result.page_start,
        page_start: result.page_start,
        page_end: result.page_end,
        chunk_id: result.chunk_ids?.[0] ?? null,
        chunk_ids: result.chunk_ids ?? [],
        result_id: result.result_id,
        result_type: result.result_type,
        result_number: result.result_number,
        result_label: result.result_label,
        section_title: result.section_title,
        match_type: 'technical_result',
        score: adjustedScore,
        technical_result_score: baseScore,
        model_primitive_bonus: adjustedScore - baseScore,
        matched_queries: [queryResult.query].filter(Boolean),
        matched_terms: result.matched_terms ?? [],
        match_fields: result.match_fields ?? [],
        formula_refs: result.formula_refs ?? [],
        formula_context: result.formula_context ?? [],
        related_definitions: result.related_definitions ?? [],
        nearby_terms: result.nearby_terms ?? [],
        assumption_text: result.assumption_text ?? null,
        conclusion_text: result.conclusion_text ?? null,
        why_relevant: whyTechnicalResultRelevant(result),
        how_to_use_for_reasoning: howToUseTechnicalResult(result),
        evidence_text: truncateToApproxTokens(result.statement_text ?? result.statement_preview ?? '', input.evidenceTextTokens),
        proof_text: result.proof_text ? truncateToApproxTokens(result.proof_text, Math.max(250, Math.floor(input.evidenceTextTokens / 2))) : null,
        citation: result.citation,
        extraction_method: result.extraction_method,
      });
    }
  }
  return items.sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));
}

function technicalModelPrimitiveBonus(result: Record<string, any>) {
  const text = [
    result.title,
    result.result_label,
    result.section_title,
    result.statement_text,
    result.assumption_text,
    result.conclusion_text,
    ...(result.nearby_terms ?? []),
    ...(result.matched_terms ?? []),
  ].filter(Boolean).join(' ').toLowerCase();
  const directTerms = [
    'disclosure',
    'verifiable',
    'hard evidence',
    'message',
    'messages',
    'possibility',
    'possibility set',
    'true state',
    'private history',
    'perfect bayesian equilibrium',
    'pbe',
    'belief',
    'sender',
    'revealing',
    'unraveling',
  ];
  return directTerms.filter(term => text.includes(term)).length * 12;
}

function mergeEvidenceItems(input: {
  contextItems: Array<Record<string, any>>;
  technicalItems: Array<Record<string, any>>;
  maxItems: number;
  includeTerms: boolean;
}) {
  const termQuota = input.includeTerms ? Math.min(input.technicalItems.length, Math.max(0, Math.min(6, Math.floor(input.maxItems * 0.3)))) : 0;
  const selectedTechnical = input.technicalItems.slice(0, termQuota);
  const selectedKeys = new Set(selectedTechnical.map(item => item.result_id ?? `${item.doc_id}:${item.page}:${item.result_label}`));
  const remainingSlots = Math.max(0, input.maxItems - selectedTechnical.length);
  const selectedContext = input.contextItems.slice(0, remainingSlots);
  const overflowTechnical = input.technicalItems
    .slice(termQuota)
    .filter(item => !selectedKeys.has(item.result_id ?? `${item.doc_id}:${item.page}:${item.result_label}`));
  const combined: Array<Record<string, any>> = [...selectedContext, ...selectedTechnical, ...overflowTechnical]
    .slice(0, input.maxItems)
    .sort((a, b) => researchItemRank(b) - researchItemRank(a))
    .map((item, index) => ({ ...item, item_id: index + 1 }));
  return {
    items: combined,
    grouped_items: {
      papers: combined.filter(item => item.group === 'papers'),
      books_or_textbooks: combined.filter(item => item.group === 'books_or_textbooks'),
      technical_tools: combined.filter(item => item.group === 'technical_tools'),
      terms_or_results: combined.filter(item => item.item_type === 'technical_result'),
      weak_related: combined.filter(item => item.group === 'weak_related'),
    },
  };
}

function whyTechnicalResultRelevant(result: Record<string, any>) {
  const fields = [
    result.result_label,
    result.section_title,
    ...(result.matched_terms ?? []),
    ...(result.nearby_terms ?? []),
  ].filter(Boolean).slice(0, 12).join(', ');
  return `This extracted ${result.result_type ?? 'technical result'} matches term/result-level search fields (${fields}). It may provide a formal definition, proposition, lemma, or characterization useful for modeling or proving part of the custom problem.`;
}

function howToUseTechnicalResult(result: Record<string, any>) {
  const label = result.result_label ?? result.result_type ?? 'technical result';
  return `Use ${label} as a term-level tool candidate. Check its assumptions (${result.assumption_text ?? 'not automatically identified'}) and conclusion (${result.conclusion_text ?? 'not automatically identified'}) before applying it to the custom model.`;
}

export function buildFollowupQueries(problem: string, previousQueries: string[], items: Array<Record<string, any>>) {
  const termScores = new Map<string, number>();
  for (const item of items) {
    const gradeWeight = item.evidence_grade === 'direct_model_primitive' ? 4
      : item.evidence_grade === 'technical_tool' ? 3
        : item.evidence_grade === 'background' ? 2
          : 1;
    for (const term of item.matched_terms ?? []) {
      const normalizedTerm = String(term).toLowerCase();
      if (normalizedTerm.length < 4 || stopwords.has(normalizedTerm)) continue;
      termScores.set(normalizedTerm, (termScores.get(normalizedTerm) ?? 0) + gradeWeight);
    }
    for (const titleTerm of extractQueryTerms(String(item.title ?? '')).terms.slice(0, 4)) {
      if (titleTerm.length < 4 || stopwords.has(titleTerm)) continue;
      termScores.set(titleTerm, (termScores.get(titleTerm) ?? 0) + Math.max(1, gradeWeight - 1));
    }
  }
  const topTerms = [...termScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([term]) => term)
    .slice(0, 16);
  const problemTerms = extractQueryTerms(problem).terms
    .filter(term => term.length >= 4 && !stopwords.has(term))
    .slice(0, 10);
  const termBank = [...new Set([...topTerms, ...problemTerms])];
  const directTerms = termBank.filter(term => /disclosure|verifiable|evidence|message|privacy|type|state|theta|observer|infer|revealing|private|communication/.test(term));
  const technicalTerms = termBank.filter(term => /bayes|posterior|martingale|plausibility|persuasion|mechanism|dynamic|incentive|belief|constraint|history|sequential/.test(term));
  const queries = [
    [...new Set([...directTerms.slice(0, 8), 'disclosure', 'verifiable evidence', 'privacy constraint'])].join(' '),
    [...new Set([...technicalTerms.slice(0, 8), 'Bayes plausibility', 'posterior belief', 'public signals'])].join(' '),
    'hard evidence disclosure game possibility set true state sender type messages',
    'privacy preserving communication observer cannot infer type public message',
    'dynamic communication histories privacy constraint incentive compatibility disclosure',
    'Bayesian persuasion posterior martingale information disclosure public signals',
    'verifiable information unraveling disclosure game withholding evidence',
    'two sided private information communication verifiable disclosure privacy',
  ];
  const previous = new Set(previousQueries.map(query => normalize(query).replace(/\s+/g, ' ').trim()));
  return [...new Set(queries.map(query => query.replace(/\s+/g, ' ').trim()).filter(Boolean))]
    .filter(query => !previous.has(normalize(query).replace(/\s+/g, ' ').trim()))
    .slice(0, 8);
}

function dedupeKey(result: Record<string, any>, deduplicateBy: DeduplicateBy) {
  if (deduplicateBy === 'doc') return String(result.doc_id);
  if (deduplicateBy === 'page') return `${result.doc_id}:p${result.page}`;
  return String(result.chunk_id);
}

function classifyDocumentKind(doc: DocumentRecord) {
  const haystack = `${doc.title} ${doc.tags.join(' ')} ${doc.source_path}`.toLowerCase();
  if (doc.tags.includes('book') || /book|textbook|handbook|mwg|mas-colell|microeconomic theory/.test(haystack)) return 'book';
  return 'paper';
}

function classifyResearchEvidence(result: Record<string, any>, doc: DocumentRecord, matchedTerms: string[], chunkText: string) {
  const text = `${doc.title} ${matchedTerms.join(' ')} ${chunkText}`.toLowerCase();
  const technicalCoreTerms = ['bayes', 'bayesian', 'posterior', 'martingale', 'plausibility', 'persuasion', 'mechanism', 'dynamic mechanism', 'incentive compatibility', 'belief'];
  const directTerms = ['disclosure', 'verifiable', 'hard evidence', 'message', 'messages', 'type', 'theta', 'possibility', 'privacy', 'private information', 'infer', 'observer'];
  const technicalTerms = [...technicalCoreTerms, 'dynamic', 'sequential', 'communication', 'incentive', 'constraint', 'belief'];
  const directHits = directTerms.filter(term => text.includes(term)).length;
  const technicalHits = technicalTerms.filter(term => text.includes(term)).length;
  const technicalCoreHits = technicalCoreTerms.filter(term => text.includes(term)).length;
  if (technicalCoreHits >= 2 && directHits < 5) return 'technical_tool';
  if (directHits >= 3) return 'direct_model_primitive';
  if (technicalHits >= 2) return 'technical_tool';
  if (classifyDocumentKind(doc) === 'book') return 'background';
  return 'weak_related';
}

function contributionForEvidenceGrade(grade: string) {
  if (grade === 'direct_model_primitive') return 'helps_formalize';
  if (grade === 'technical_tool') return 'helps_formalize';
  return 'only_background';
}

function groupForResearchItem(grade: string, docKind: string) {
  if (grade === 'weak_related') return 'weak_related';
  if (grade === 'technical_tool') return 'technical_tools';
  if (docKind === 'book') return 'books_or_textbooks';
  return 'papers';
}

function whyRelevant(grade: string, matchedTerms: string[], query: string, docKind: string) {
  const terms = matchedTerms.length ? matchedTerms.slice(0, 8).join(', ') : 'the generated query terms';
  if (grade === 'direct_model_primitive') {
    return `This ${docKind} item matches model-primitives from the user problem, including ${terms}. It is relevant as source material for states, types, messages, disclosure, privacy, or observability constraints.`;
  }
  if (grade === 'technical_tool') {
    return `This ${docKind} item matches technical terms such as ${terms}. It may supply a modeling or proof tool, but it should not be treated as direct evidence that solves the custom problem.`;
  }
  if (grade === 'background') {
    return `This textbook/book item matches ${terms}. It is useful for definitions, standard notation, or background setup rather than direct support for the proposed custom model.`;
  }
  return `This item only weakly matches ${terms}. Use it as a low-confidence bibliographic/background lead, not as direct support.`;
}

function howToUseForReasoning(grade: string, matchedTerms: string[]) {
  const terms = matchedTerms.join(', ');
  if (grade === 'direct_model_primitive') {
    return `Use this item to formalize primitives and constraints suggested by the query terms (${terms}), then check separately whether incentives/equilibrium/privacy requirements follow.`;
  }
  if (grade === 'technical_tool') {
    return `Use this as a candidate technical tool or analogy (${terms}); keep it separate from direct evidence and verify assumptions before applying it.`;
  }
  if (grade === 'background') {
    return `Use this to define standard objects, notation, or benchmark results (${terms}); it does not by itself answer the problem.`;
  }
  return 'Use only as a possible lead for further search; do not use it as support for an answer unless additional direct evidence is found.';
}

function researchItemRank(item: Record<string, any>) {
  const gradeWeight: Record<string, number> = {
    direct_model_primitive: 4,
    term_or_result: 3.5,
    technical_tool: 3,
    background: 2,
    weak_related: 1,
  };
  return (gradeWeight[item.evidence_grade] ?? 0) * 1000
    + Number(item.score ?? 0) * 100
    + Number(item.bm25_score ?? 0);
}

function truncateToApproxTokens(text: string, tokens: number) {
  const limit = Math.max(100, tokens * 4);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trim()}...[truncated]`;
}

function neighborChunks(index: KnowledgeIndex, docId: string, chunkIndex: number, contextWindow: number) {
  if (contextWindow <= 0) return [];
  return index.chunks
    .filter(chunk => chunk.doc_id === docId && chunk.chunk_index >= chunkIndex - contextWindow && chunk.chunk_index <= chunkIndex + contextWindow)
    .sort((a, b) => a.chunk_index - b.chunk_index);
}

export function extractQueryTerms(query: string): QueryAnalysis {
  const normalized = normalize(query);
  const terms: string[] = [];
  const phrase_terms: string[] = [];
  const key_terms: string[] = [];
  const warnings: string[] = [];
  for (const phrase of normalized.match(/[a-zA-Z][a-zA-Z0-9_\\]*(?:-[a-zA-Z0-9_\\]+)+/g) ?? []) {
    const collapsed = phrase.replaceAll('-', '');
    phrase_terms.push(phrase, collapsed);
    key_terms.push(phrase, collapsed);
    terms.push(phrase, collapsed);
  }
  for (const term of normalized.match(/[a-zA-Z0-9_\\]+/g) ?? []) {
    if (term.length < 3 && term !== 'ot') continue;
    if (stopwords.has(term)) continue;
    key_terms.push(term);
    terms.push(term);
  }
  const cjkTerms = extractCjkNgrams(normalized);
  terms.push(...cjkTerms);
  if (key_terms.length === 0 && cjkTerms.length > 0) {
    key_terms.push(...cjkTerms);
    warnings.push('No English or technical-symbol query terms were extracted; using CJK bigram/trigram terms for lexical search.');
  } else if (containsCjk(normalized) && cjkTerms.length === 0) {
    warnings.push('Chinese text was present, but no CJK search terms could be extracted.');
  }
  if (terms.length === 0) {
    warnings.push('No usable search terms were extracted from the query; search will return not_found.');
  }
  return {
    terms: [...new Set(terms)],
    phrase_terms: [...new Set(phrase_terms)],
    key_terms: [...new Set(key_terms)],
    warnings,
  };
}

function normalize(text: string) {
  return text.toLowerCase().replace(/[–—−]/g, '-');
}

export function countTerm(text: string, term: string) {
  const normalizedText = normalize(text);
  const normalizedTerm = normalize(term);
  if (containsCjk(normalizedTerm)) return normalizedText.split(normalizedTerm).length - 1;
  if (normalizedTerm.includes('-') || normalizedTerm.includes('\\')) return normalizedText.split(normalizedTerm).length - 1;
  return normalizedText.match(new RegExp(`(?<![a-zA-Z0-9_])${escapeRegExp(normalizedTerm)}(?![a-zA-Z0-9_])`, 'g'))?.length ?? 0;
}

function extractCjkNgrams(text: string) {
  const terms: string[] = [];
  for (const segment of text.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    for (const size of [2, 3]) {
      for (let index = 0; index <= segment.length - size; index += 1) {
        terms.push(segment.slice(index, index + size));
      }
    }
  }
  return [...new Set(terms)];
}

function containsCjk(text: string) {
  return /[\u4e00-\u9fff]/.test(text);
}

function tokenizeForLength(text: string) {
  return text.match(/[a-zA-Z0-9_\\]+|[\u4e00-\u9fff]/g) ?? [];
}

export function gradeEvidence(
  results: Array<ChunkRecord & { matched_terms: string[] }>,
  query: QueryAnalysis,
): { evidence_grade: EvidenceGrade; missing_terms: string[] } {
  const matchedByAnyChunk = new Set(results.flatMap(item => item.matched_terms));
  const phraseMatchedInOneChunk = results.some(item => {
    const matched = new Set(item.matched_terms);
    return query.phrase_terms.some(term => matched.has(term));
  });
  if (phraseMatchedInOneChunk) {
    return { evidence_grade: 'exact_phrase', missing_terms: [] };
  }

  if (query.phrase_terms.length > 0) {
    const missingPhraseTerms = query.phrase_terms.filter(term => !matchedByAnyChunk.has(term));
    if (matchedByAnyChunk.size > 0) {
      return { evidence_grade: 'partial_terms', missing_terms: missingPhraseTerms };
    }
    return { evidence_grade: 'none', missing_terms: query.phrase_terms };
  }

  const requiredTerms = query.key_terms;
  const directChunk = results.find(item => {
    const matched = new Set(item.matched_terms);
    return requiredTerms.length > 0 && requiredTerms.every(term => matched.has(term));
  });
  if (directChunk) {
    return { evidence_grade: 'all_key_terms', missing_terms: [] };
  }

  if (matchedByAnyChunk.size > 0) {
    const bestChunkMatched = bestMatchedRequiredTerms(results, requiredTerms);
    const missingTerms = requiredTerms.filter(term => !bestChunkMatched.has(term));
    return { evidence_grade: 'partial_terms', missing_terms: missingTerms };
  }
  return { evidence_grade: 'none', missing_terms: query.key_terms };
}

function bestMatchedRequiredTerms(results: Array<ChunkRecord & { matched_terms: string[] }>, requiredTerms: string[]) {
  let best = new Set<string>();
  for (const result of results) {
    const matched = new Set(result.matched_terms.filter(term => requiredTerms.includes(term)));
    if (matched.size > best.size) best = matched;
  }
  return best;
}

function passesFilters(doc: DocumentRecord, filters: Filters) {
  if (filters.doc_id && doc.doc_id !== filters.doc_id) return false;
  if (filters.tags?.length && !filters.tags.every(tag => doc.tags.includes(tag))) return false;
  return true;
}

function citation(doc: DocumentRecord, page: number) {
  const prefix = doc.authors.length ? `${doc.authors.join(', ')}, ${doc.title}` : doc.title;
  return `${prefix}, p. ${page}`;
}

function mustGetDoc(docs: Map<string, DocumentRecord>, docId: string) {
  const doc = docs.get(docId);
  if (!doc) throw new Error(`Document not found: ${docId}`);
  return doc;
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'document';
}

function normalizeDbName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'kb';
}

function standardPdfFileName(docId: string, fileSha256: string) {
  return `${slugify(docId)}-${fileSha256.slice(0, 8)}.pdf`;
}

export function answerabilityMessage(status: KbStatus, strict: boolean) {
  if (status === 'supported') return 'The knowledge base contains direct textual evidence. The agent may answer only from the cited evidence.';
  if (status === 'related_only') return 'The knowledge base contains weakly related material, but it does not directly support an answer. Do not answer from the knowledge base; ask whether the user wants independent model reasoning.';
  if (strict) return 'No direct textual evidence was found in the indexed knowledge base. Ask the user whether to proceed with general AI reasoning before answering.';
  return 'No direct textual evidence was found; non-strict search may still return exploratory analogies.';
}

export function answerPolicy(status: KbStatus) {
  const canAnswerFromKb = status === 'supported';
  return {
    can_answer_from_kb: canAnswerFromKb,
    must_ask_user_before_reasoning: !canAnswerFromKb,
    allowed_next_steps: canAnswerFromKb
      ? ['answer_from_kb_evidence', 'ask_user_for_general_reasoning_if_needed']
      : ['report_no_direct_kb_answer', 'ask_user_before_independent_reasoning'],
  };
}

export function buildMethodBoundaryCheck(input: {
  profile: KnowledgeBaseProfile;
  method_check_queries?: string[];
  query_results?: Array<Record<string, any>>;
  min_supported_queries?: number;
}) {
  const methodCheckQueries = (input.method_check_queries ?? []).map(query => query.trim()).filter(Boolean);
  if (methodCheckQueries.length === 0) {
    return {
      status: 'not_requested' as MethodBoundaryCheckStatus,
      can_answer_with_labeled_method_guided_reasoning: false,
      reason: 'No method_check_queries were provided.',
    };
  }
  if (!input.profile.allow_method_guided_independent_reasoning) {
    return {
      status: 'not_allowed_by_profile' as MethodBoundaryCheckStatus,
      can_answer_with_labeled_method_guided_reasoning: false,
      reason: 'The selected knowledge-base profile does not allow method-guided independent reasoning.',
      method_check_queries: methodCheckQueries,
    };
  }

  const queryResults = input.query_results ?? [];
  const methodEvidence = queryResults
    .map(result => methodEvidenceFromQueryResult(result))
    .filter((item): item is NonNullable<ReturnType<typeof methodEvidenceFromQueryResult>> => item !== null);
  const supportedQueries = methodEvidence.map(item => item.query);
  const required = Math.min(
    methodCheckQueries.length,
    Math.max(1, input.min_supported_queries ?? methodCheckQueries.length),
  );
  const status: MethodBoundaryCheckStatus = supportedQueries.length >= required
    ? 'within_corpus_methods'
    : supportedQueries.length > 0
      ? 'partial_method_support'
      : 'not_supported';

  return {
    status,
    can_answer_with_labeled_method_guided_reasoning: status === 'within_corpus_methods',
    reason: status === 'within_corpus_methods'
      ? 'The candidate solution methods were checked against the selected knowledge base and met the configured support threshold. This does not mean the original problem itself has direct corpus evidence.'
      : status === 'partial_method_support'
        ? 'Only some candidate solution methods were directly found in the selected knowledge base.'
        : 'The candidate solution methods were not directly found in the selected knowledge base.',
    method_check_queries: methodCheckQueries,
    min_supported_queries: required,
    supported_queries: supportedQueries,
    method_evidence: methodEvidence,
    unsupported_queries: methodCheckQueries.filter(query => !supportedQueries.includes(query)),
  };
}

function methodEvidenceFromQueryResult(result: Record<string, any>) {
  const query = String(result.query ?? '').trim();
  if (!query) return null;
  const answerability = result.answerability ?? {};
  const matchedTerms = [...new Set<string>((answerability.matched_terms ?? []).map((term: unknown) => String(term)))];
  const citations = [
    ...(result.results ?? []),
    ...(result.partial_results ?? []),
  ]
    .map((item: Record<string, unknown>) => String(item.citation ?? ''))
    .filter(Boolean)
    .slice(0, 3);

  if (answerability.status === 'supported') {
    return {
      query,
      support_level: 'direct_method_evidence',
      matched_terms: matchedTerms,
      citations,
    };
  }

  if (answerability.status !== 'related_only' || answerability.evidence_grade !== 'partial_terms') {
    return null;
  }

  const queryTerms = new Set(extractQueryTerms(query).key_terms);
  const significantMatches = matchedTerms.filter(term => {
    const normalized = normalize(term);
    return queryTerms.has(normalized)
      && normalized.length >= 4
      && !stopwords.has(normalized)
      && !methodCheckGenericTerms.has(normalized);
  });
  const hasCoreMethodTerm = significantMatches.some(term => methodCheckCoreTerms.has(normalize(term)));
  if (significantMatches.length >= 2 || hasCoreMethodTerm) {
    return {
      query,
      support_level: 'method_term_evidence',
      matched_terms: significantMatches,
      citations,
    };
  }

  return null;
}

function searchTermsMessage(status: KbStatus, supportType: 'direct_evidence' | 'method_guided_corpus_check' | 'none' = 'none') {
  if (status === 'supported') {
    if (supportType === 'method_guided_corpus_check') {
      return 'The original problem was not directly solved by a corpus source. The candidate solution methods were checked against the selected knowledge base, so the agent may answer only with clearly labeled independent/method-guided reasoning and must state that no direct KB answer was found.';
    }
    return 'At least one generated query found direct textual evidence in the knowledge base. Use only those cited results for knowledge-base-grounded discussion.';
  }
  if (status === 'related_only') {
    return 'Generated queries found only weakly related material. Do not answer from the knowledge base; ask whether to proceed with independent model reasoning as a separate step.';
  }
  return 'No generated query found direct textual evidence in the knowledge base. Ask whether to proceed with independent model reasoning outside the knowledge base.';
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function exists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
