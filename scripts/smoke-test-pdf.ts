import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docId = 'sample-smoke-document';
const outputPath = path.join(root, 'data', 'test_outputs', 'sample_mcp_smoke.json');
const smokeDbPath = path.join(root, 'data', 'test_outputs', 'sample_mcp_smoke.duckdb');
const smokeCatalogPath = path.join(root, 'data', 'test_outputs', 'sample_mcp_smoke_catalog.json');

type JsonObject = Record<string, any>;

function parseResult(result: Awaited<ReturnType<Client['callTool']>>): JsonObject {
  if (result.isError) {
    throw new Error(result.content?.[0]?.type === 'text' ? result.content[0].text : 'Tool returned an error');
  }
  const block = result.content?.[0];
  if (!block || block.type !== 'text') return {};
  return JSON.parse(block.text);
}

function compact(value: unknown, maxText = 500): unknown {
  if (Array.isArray(value)) return value.slice(0, 3).map(item => compact(item, maxText));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compact(item, maxText)]));
  }
  if (typeof value === 'string' && value.length > maxText) return `${value.slice(0, maxText)}...[truncated]`;
  return value;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return parseResult(await client.callTool({ name, arguments: args }));
}

async function resolveSamplePdfPath() {
  const candidate = process.env.KB_MCP_SMOKE_PDF ?? process.argv[2];
  if (!candidate) {
    throw new Error('Set KB_MCP_SMOKE_PDF=/absolute/path/to/sample.pdf or pass a PDF path as the first argument.');
  }
  const pdfPath = path.resolve(candidate);
  try {
    await fs.access(pdfPath);
    return pdfPath;
  } catch {
    throw new Error(`Smoke test PDF not found: ${pdfPath}`);
  }
}

async function main() {
  const pdfPath = await resolveSamplePdfPath();
  await fs.rm(smokeDbPath, { force: true });
  await fs.rm(`${smokeDbPath}.wal`, { force: true });
  await fs.rm(smokeCatalogPath, { force: true });

  const client = new Client({ name: 'kb-smoke-test', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.env.npm_execpath ?? 'npm',
    args: ['--prefix', root, 'run', '--silent', 'kb-mcp-ts'],
    env: {
      ...process.env,
      KB_MCP_NAME: 'kb_smoke',
      KB_MCP_DUCKDB_PATH: smokeDbPath,
      KB_MCP_CATALOG_PATH: smokeCatalogPath,
      KB_MCP_DEFAULT_DB_NAME: 'default',
    },
  });

  const report: JsonObject = { pdf_path: pdfPath, doc_id: docId, tools: {} };
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const toolNames = tools.map(tool => tool.name);
    const expected = ['create_db', 'list_db', 'set_active_db', 'create_document', 'ingest_pdf', 'list_documents', 'search', 'search_math_problem', 'check_reasonable', 'build_technical_index', 'search_technical_results', 'get_chunk', 'get_page_text', 'get_page_image'];
    if (toolNames.join(',') !== expected.join(',')) throw new Error(`Unexpected tools: ${toolNames.join(',')}`);
    report.registered_tools = toolNames;

    const ingestInput = {
      pdf_path: pdfPath,
      doc_id: docId,
      title: 'Sample Smoke Document',
      authors: ['Sample Author'],
      tags: ['sample', 'smoke-test'],
      force: true,
      chunk_size: 1200,
      chunk_overlap: 180,
      render_pages: false,
      require_searchable: true,
    };
    const ingestOutput = await call(client, 'ingest_pdf', ingestInput);
    if (ingestOutput.status !== 'ingested' || ingestOutput.counts.pages <= 0 || ingestOutput.counts.chunks <= 0) {
      throw new Error('ingest_pdf assertions failed');
    }
    report.tools.ingest_pdf = { input: ingestInput, output: compact(ingestOutput) };

    const listOutput = await call(client, 'list_documents', { query: 'Sample Smoke', tags: ['sample'], limit: 5, offset: 0 });
    if (!listOutput.documents.some((doc: { doc_id: string }) => doc.doc_id === docId)) {
      throw new Error('list_documents assertions failed');
    }
    report.tools.list_documents = { output: compact(listOutput) };

    const pageTextOutput = await call(client, 'get_page_text', { doc_id: docId, page: 1, include_chunks: true });
    if (!pageTextOutput.text || !pageTextOutput.chunks?.length) throw new Error('get_page_text assertions failed');
    report.tools.get_page_text = { output: compact(pageTextOutput) };

    const firstChunkId = pageTextOutput.chunks[0].chunk_id;
    const chunkOutput = await call(client, 'get_chunk', { chunk_id: firstChunkId, context_window: 1 });
    if (chunkOutput.chunk.chunk_id !== firstChunkId) throw new Error('get_chunk assertions failed');
    report.tools.get_chunk = { output: compact(chunkOutput) };

    const searchOutput = await call(client, 'search', {
      query: pageTextOutput.text.slice(0, 120),
      mode: 'hybrid',
      top_k: 5,
      filters: { doc_id: docId, tags: ['sample'] },
      context_window: 1,
      include_text: false,
      strict: false,
    });
    if (!Array.isArray(searchOutput.results) && !Array.isArray(searchOutput.partial_results)) {
      throw new Error('search output shape assertions failed');
    }
    report.tools.search = { output: compact(searchOutput) };

    await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
    console.log(`PDF smoke test passed: ${outputPath}`);
  } finally {
    await client.close();
  }
}

await main();
