import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { duckDbPath, ingestPdf, queryDuckDb, runDuckDb } from '../src-ts/store.ts';

const secondPdfPath = path.resolve('data/test_outputs/incremental-second.pdf');

async function resolveOtPdfPath() {
  const candidate = process.env.KB_MCP_SMOKE_PDF ?? process.argv[2];
  if (!candidate) {
    throw new Error('Set KB_MCP_SMOKE_PDF=/absolute/path/to/sample.pdf or pass a PDF path as the first argument.');
  }
  const pdfPath = path.resolve(candidate);
  try {
    await fs.access(pdfPath);
    return pdfPath;
  } catch {
    throw new Error(`Test PDF not found: ${pdfPath}`);
  }
}

async function queryOne<T>(sql: string, values?: unknown[]) {
  const rows = await queryDuckDb<T>(sql, values);
  return rows[0];
}

async function run() {
  await fs.rm(duckDbPath, { force: true });
  const pdfPath = await resolveOtPdfPath();
  await fs.copyFile(pdfPath, secondPdfPath);
  await fs.appendFile(secondPdfPath, '\n% kb incremental ingest test variant\n');

  const first = await ingestPdf({
    pdf_path: pdfPath,
    doc_id: 'incremental-a',
    title: 'Incremental A',
    authors: ['Sample Author'],
    tags: ['incremental-test'],
    force: true,
  });
  assert.equal(first.status, 'ingested');
  assert.ok(first.counts.pages > 0);
  assert.ok(first.counts.chunks > 0);

  const firstChunk = await queryOne<{ chunk_id: string; content_hash: string }>(
    'select chunk_id, content_hash from chunks where doc_id = $1 order by chunk_index limit 1',
    ['incremental-a'],
  );
  assert.ok(firstChunk.chunk_id);

  await runDuckDb(
    `insert into semantic_index
      (chunk_id, embedding_model, content_hash, vector_index_name, updated_at)
     values ($1, $2, $3, $4, $5)`,
    [firstChunk.chunk_id, 'test-embedding', firstChunk.content_hash, 'test-lancedb', new Date().toISOString()],
  );

  const second = await ingestPdf({
    pdf_path: secondPdfPath,
    doc_id: 'incremental-b',
    title: 'Incremental B',
    authors: ['Sample Author'],
    tags: ['incremental-test'],
    force: true,
  });
  assert.equal(second.status, 'ingested');

  const preservedAfterAppend = await queryOne<{ semantic_rows: string | number }>(
    'select count(*) as semantic_rows from semantic_index where chunk_id = $1',
    [firstChunk.chunk_id],
  );
  assert.equal(Number(preservedAfterAppend.semantic_rows), 1);

  const replaced = await ingestPdf({
    pdf_path: pdfPath,
    doc_id: 'incremental-a',
    title: 'Incremental A Replaced',
    authors: ['Sample Author'],
    tags: ['incremental-test', 'replaced'],
    force: true,
  });
  assert.equal(replaced.status, 'ingested');

  const semanticAfterReplace = await queryOne<{ semantic_rows: string | number }>(
    'select count(*) as semantic_rows from semantic_index where chunk_id = $1',
    [firstChunk.chunk_id],
  );
  assert.equal(Number(semanticAfterReplace.semantic_rows), 0);

  const counts = await queryOne<{
    documents: string | number;
    pages: string | number;
    chunks: string | number;
    embedding_jobs: string | number;
  }>(
    `select
      (select count(*) from documents) as documents,
      (select count(*) from pages) as pages,
      (select count(*) from chunks) as chunks,
      (select count(*) from embedding_jobs) as embedding_jobs`,
  );

  assert.equal(Number(counts.documents), 2);
  assert.equal(Number(counts.pages), first.counts.pages + second.counts.pages);
  assert.equal(Number(counts.chunks), first.counts.chunks + second.counts.chunks);
  assert.equal(Number(counts.embedding_jobs), Number(counts.chunks));
  console.log('Incremental ingest test passed.');
}

await run();
