import { ingestPdf } from '../src-ts/store.ts';

const raw = process.argv[2];
if (!raw) {
  throw new Error('Usage: npm run create-document -- \'{"pdf_path":"/abs/file.pdf","doc_id":"optional","title":"optional","tags":["book"],"ocr":"auto"}\'');
}

const input = JSON.parse(raw);
const result = await ingestPdf({
  ocr: 'auto',
  require_searchable: true,
  ...input,
});

console.log(JSON.stringify(result, null, 2));
