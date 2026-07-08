# Open Research KB

[English README](README.md)

Open Research KB 是一个本地优先的 MCP 服务器，用于从 PDF 构建和查询知识库。它把可搜索 PDF 索引到 DuckDB 中，向智能体暴露带证据约束的检索工具，并帮助区分“知识库中有依据的回答”和“独立推理”。

## 功能

- 将带文本层的 PDF 文件导入本地 DuckDB 知识库。
- 通过 `db_name` 管理多个命名知识库。
- 默认使用 DuckDB-backed BM25 文本检索。
- 返回保守的可回答性标签：`supported`、`related_only`、`not_found`。
- 可获取原始 chunk、页面文本和渲染后的页面图片，方便核对引用。
- 可用 `check_reasonable` 检查独立推理是否超出封闭语料库边界。
- PDF、DuckDB 索引和页面缓存默认都保留在本地，不提交到仓库。

## 快速开始

安装依赖：

```bash
npm install
```

通过 stdio 启动 MCP 服务器：

```bash
npm run kb-mcp-ts
```

添加一个 PDF：

```bash
npm run create-document -- '{"pdf_path":"<path-to-book.pdf>","title":"Book Title","authors":["Author"],"tags":["book"]}'
```

运行可选 smoke test。请使用一个可搜索文本 PDF：

```bash
KB_MCP_SMOKE_PDF=<path-to-sample.pdf> npm run smoke:pdf
```

## Codex MCP 配置

把服务器加入 Codex MCP 配置：

```toml
[mcp_servers.kb]
command = "npm"
args = ["--prefix", "/path/to/ResearchKB", "run", "--silent", "kb-mcp-ts"]
```

全新安装会自动使用名为 `default` 的默认知识库，路径为 `data/index/kb_default.duckdb`。如果需要多个知识库，可以用 `create_db` 创建，例如 `research_corpus` 或 `textbook_corpus`。

## 常见工作流

1. 用 `create_document` 或 `ingest_pdf` 添加 PDF。
2. 用 `search` 或 `search_terms` 检索语料。
3. 用 `get_chunk`、`get_page_text` 或 `get_page_image` 检查来源证据。
4. 只有当 `answerability.status` 为 `supported` 时，才把知识库内容当作回答依据。
5. 如果证据较弱或缺失，需要明确标注独立推理；当封闭语料库边界重要时，使用 `check_reasonable` 检查推理是否越界。

## PDF 入库要求

默认情况下，系统只接受能直接抽取文本的 PDF。也就是说，LaTeX 生成的论文 PDF、带文本层的电子书通常可以入库；扫描件、图片型 PDF、无法复制粘贴文字的 PDF 会被拒绝，并返回：

```json
{
  "status": "rejected",
  "index_status": "not_indexed",
  "rejection_reason": "no_searchable_text"
}
```

默认设置是：

```text
ocr: "never"
require_searchable: true
```

如果确实需要处理扫描件，可以显式启用 OCR：

```json
{
  "ocr": "auto"
}
```

OCR 依赖本地 Tesseract，且对公式、表格和复杂排版的效果可能不稳定。

## 工具

| 工具 | 用途 |
|---|---|
| `create_db` | 创建命名 DuckDB 知识库，也可以从 PDF 文件或目录批量入库。 |
| `list_db` | 列出可用知识库和对应 profile。 |
| `set_active_db` | 设置当前会话默认知识库。 |
| `create_document` | 添加一个可搜索 PDF，默认拒绝无文本层 PDF。 |
| `ingest_pdf` | 将本地 PDF 导入指定知识库。 |
| `list_documents` | 按标题、路径或标签列出已索引文档。 |
| `search` | 搜索 chunk 并返回可回答性元数据。默认是 BM25 文本检索。 |
| `search_terms` | 面向技术问题或领域问题的两阶段检索工作流。 |
| `check_reasonable` | 检查独立推理是否仍在指定语料库范围内。 |
| `build_technical_index` | 预览或构建 theorem、lemma、definition 等结构化技术结果索引。 |
| `search_technical_results` | 搜索结构化技术结果及附近定义。 |
| `get_chunk` | 获取一个 chunk，可附带相邻上下文和页面图片。 |
| `get_page_text` | 返回指定 PDF 页面的抽取文本。 |
| `get_page_image` | 渲染或读取缓存的页面图片。 |

完整输入输出 schema 见 [docs/tool-reference.md](docs/tool-reference.md)。

## 检索模式

`search` 默认使用：

```json
{
  "mode": "text"
}
```

含义是 DuckDB-backed BM25 文本检索。当前支持的模式：

| 模式 | 含义 |
|---|---|
| `text` | BM25 文本检索，当前默认模式。 |
| `overlap` | 探索性的词项重叠检索。 |
| `hybrid` | BM25 加词项重叠检索；这不是标准的 BM25 + 向量混合检索。 |
| `semantic` | 为未来 LanceDB 向量索引预留；只有构建 embedding side index 后才可真正参与检索。 |
| `vector` | `semantic` 的废弃别名。 |

当前项目中真正稳定可用的是 `text`。语义向量检索和重排器是后续高级能力，不是默认路径。

## 证据策略

Open Research KB 有意采用保守策略。词面命中不等于可以直接回答。

| 状态 | 含义 | 推荐智能体行为 |
|---|---|---|
| `supported` | 找到了直接文本证据。 | 只基于引用证据回答。 |
| `related_only` | 找到弱相关材料，但不足以支持答案。 | 说明限制，再决定是否进行独立推理。 |
| `not_found` | 没有找到可用证据。 | 先说明知识库没有证据，再询问是否允许独立推理。 |

## Term / Technical Result Index

普通入库会生成：

```text
documents
pages
chunks
chunk_terms
embedding_jobs
```

如果需要 theorem、lemma、definition、proposition 等结构化检索，可以之后单独调用 `build_technical_index`。它会生成：

```text
technical_results
technical_result_links
```

这个索引适合查找定理、定义、命题和证明相关材料，不应该简单地用普通 RAG 的 gold answer recall 来评价。

## 存储

运行时数据保留在本地，并被 Git 忽略：

```text
data/index/        DuckDB 数据库和数据库 catalog
data/pdfs/         可选的本地 PDF 暂存目录
data/rendered/     缓存的页面图片
data/test_outputs/
```

每个知识库都是单独的 DuckDB 文件，例如 `data/index/kb_default.duckdb`。入库时不会把原始 PDF 复制到仓库，只会在数据库元数据里记录原始路径。页面图片按需生成，并缓存到 `data/rendered`。

入库前请安装 Poppler：

```text
pdftotext
pdfinfo
pdftoppm
```

如果需要 OCR，还需要安装并配置 Tesseract。

## 开发

```bash
npm run typecheck
npm run test:unit
```

本仓库默认不包含生成的 PDF、图片、DuckDB 文件、渲染页面、日志、本地环境和 `node_modules`。
