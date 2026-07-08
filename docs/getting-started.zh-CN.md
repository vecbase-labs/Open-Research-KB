# 快速开始

[首页](../README.zh-CN.md) · [English](getting-started.md) · 下一页：[核心概念](concepts.zh-CN.md)

本页说明如何在本地启动 OpenShelf、接入 Codex MCP、创建知识库并导入第一个 PDF。

## 1. 安装依赖

```bash
npm install
```

入库 PDF 前请确保本地安装了 Poppler：

```text
pdftotext
pdfinfo
pdftoppm
```

如果需要 OCR，还需要安装 Tesseract。默认不会自动 OCR。

## 2. 启动 MCP 服务器

```bash
npm run openshelf-mcp
```

该命令通过 stdio 启动 MCP server，供 Codex 或其他 MCP client 调用。

## 3. 配置 Codex MCP

把下面配置加入 Codex MCP 配置文件，并把 `/path/to/OpenShelf` 替换成你的本地仓库路径：

```toml
[mcp_servers.openshelf]
command = "npm"
args = ["--prefix", "/path/to/OpenShelf", "run", "--silent", "openshelf-mcp"]
```

全新安装会自动使用默认知识库：

```text
db_name: default
duckdb_path: data/index/kb_default.duckdb
```

## 4. 作为 Codex 插件安装

OpenShelf 也可以作为 Codex 插件安装。插件 manifest 位于 `.codex-plugin/plugin.json`，MCP server 配置位于 `.mcp.json`。

本地安装：

```bash
codex plugin marketplace add /path/to/OpenShelf
codex plugin add openshelf@openshelf-local
```

安装后新开 Codex thread，让 Codex 重新加载插件提供的 skill 和 MCP tools。

插件模式下默认数据目录是：

```text
~/.openshelf/data
```

这可以避免知识库写入 Codex 的插件缓存目录。如果你已有 OpenShelf `.duckdb` 文件，在新对话里让 agent 调用 `create_db_from_exist` 注册即可。

## 5. 作为 Claude Code 插件安装

OpenShelf 也支持 Claude Code 插件。Claude Code 使用 `.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json` 和根目录 `.mcp.json`。

本地安装：

```bash
claude plugin marketplace add /path/to/OpenShelf
claude plugin install openshelf@openshelf-local
```

安装后重启 Claude Code 或开启新会话。Claude Code 会导入名为 `openshelf` 的 MCP server。

## 6. 创建或注册知识库

创建新知识库：

```json
{
  "db_name": "research_corpus",
  "path": "/path/to/pdf-folder",
  "tags": ["research"]
}
```

注册已有 OpenShelf DuckDB 文件：

```json
{
  "db_name": "shared_corpus",
  "duckdb_path": "/path/to/kb_shared_corpus.duckdb"
}
```

`create_db_from_exist` 只更新 catalog，不复制 DuckDB 文件，也不重新入库 PDF。

## 7. 添加一个 PDF

命令行方式：

```bash
npm run create-document -- '{"pdf_path":"<path-to-book.pdf>","title":"Book Title","authors":["Author"],"tags":["book"]}'
```

MCP 工具方式：

```json
{
  "pdf_path": "/path/to/book.pdf",
  "title": "Book Title",
  "authors": ["Author"],
  "tags": ["book"]
}
```

如果有多个知识库，调用检索或入库工具时应显式传入 `db_name`。

## 8. 运行 smoke test

使用任意可搜索文本 PDF：

```bash
KB_MCP_SMOKE_PDF=<path-to-sample.pdf> npm run smoke:pdf
```

## PDF 要求

默认只接受能直接抽取文本的 PDF。LaTeX 生成的论文、带文本层的电子书通常可以入库；扫描件、图片型 PDF、无法复制粘贴文字的 PDF 会被拒绝。

拒绝时会返回类似：

```json
{
  "status": "rejected",
  "index_status": "not_indexed",
  "rejection_reason": "no_searchable_text"
}
```

默认设置：

```text
ocr: "never"
require_searchable: true
```

如确实需要处理扫描件，可以显式设置：

```json
{
  "ocr": "auto"
}
```

上一页：[首页](../README.zh-CN.md) · 下一页：[核心概念](concepts.zh-CN.md)
