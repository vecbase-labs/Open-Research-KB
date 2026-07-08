# OpenShelf

[English](README.md) · [Codex 插件](#codex-插件) · [Claude Code 插件](#claude-code-插件) · [快速开始](docs/getting-started.zh-CN.md) · [核心概念](docs/concepts.zh-CN.md) · [检索与证据](docs/search-and-evidence.zh-CN.md) · [工具参考](docs/tool-reference.md)

OpenShelf 是一个本地优先的 MCP 服务器，用于从本地文件夹构建可查询知识库。它把带文本层的 PDF 索引到 DuckDB 中，向智能体提供证据约束的检索工具，并帮助区分“知识库直接支持的回答”和“需要额外推理的回答”。

OpenShelf 适合研究论文、教材、技术文档和本地资料库。与生物/药学等需要标准化流程（综述-猜想-编程-实验-写实验报告）的科研场景不同，Openshelf更适合以下两类场景：
- 数学/经济学等需要基于背景知识进行数理推导的科研场景。
- 需要让推理局限于某一范围内，例如求解高中数学题时不应该使用高中之外的知识；中国的律师报告不应该使用国外法律体系的知识。

## 为什么做 OpenShelf

很多 RAG 工具把“搜到相关文本”和“可以回答问题”混在一起。OpenShelf 的目标更窄：

- 从本地资料生成轻量化的 DuckDB 知识库。
- 默认使用 DuckDB-backed BM25 进行基于页面和术语的文本检索。
- 把页面 chunk、术语 chunk 和原始页证据保留下来。
- 区分 closed corpus 和 open research corpus 的使用边界。
- 在返回结果时标注 `supported`、`related_only` 或 `not_found`。
- 允许通过分享 `.duckdb` 文件直接共享知识库。

## 功能概览

| 能力 | 说明 |
|---|---|
| 本地入库 | 将可复制文本的 PDF 导入 DuckDB。 |
| 多知识库 | 通过 `db_name` 管理多个硬隔离知识库。 |
| 术语索引 | 入库后由用户选择是否为 theorem、lemma、definition、proposition 等生成 technical result 索引。 |
| 语料边界 | 用知识库的 profile 区分 closed corpus （局限于知识库内推理） 和 open research corpus （允许开放推理）。 |
| 已有库注册 | 用 `create_db_from_exist` 注册已有的 .duckdb 文件。 |
| 文本检索 | 默认 `mode: "text"`，基于 BM25 文本检索。 支持向量化和混合检索|
| 证据判断 | 返回 `supported`、`related_only`、`not_found`。 |
| 页面回看 | 支持获取 chunk、页面文本和渲染页面图片。 |


## 快速开始

```bash
npm install
npm run openshelf-mcp
```

在 Codex MCP 配置中加入：

```toml
[mcp_servers.openshelf]
command = "npm"
args = ["--prefix", "/path/to/OpenShelf", "run", "--silent", "openshelf-mcp"]
```

添加一个可搜索 PDF：

```bash
npm run create-document -- '{"pdf_path":"<path-to-book.pdf>","title":"Book Title","authors":["Author"],"tags":["book"]}'
```

完整步骤见 [快速开始](docs/getting-started.zh-CN.md)。

## Codex 插件

本仓库本身也是一个 Codex 插件根目录，包含：

```text
.codex-plugin/plugin.json  插件 manifest
.mcp.json                  OpenShelf MCP server 配置
skills/openshelf/          Codex 使用 OpenShelf 的 agent 指南
.agents/plugins/           本地 marketplace 配置
```

本地安装方式：

```bash
codex plugin marketplace add /path/to/OpenShelf
codex plugin add openshelf@openshelf-local
```

安装后新开一个 Codex thread，让 Codex 加载插件提供的 OpenShelf MCP 工具。

插件模式下，OpenShelf 默认把知识库数据保存在 `~/.openshelf/data`，不会写入 Codex 插件缓存目录。已有 `.duckdb` 文件可以用 `create_db_from_exist` 注册进插件使用的 catalog。

## Claude Code 插件

本仓库也支持 Claude Code 插件结构，包含：

```text
.claude-plugin/plugin.json       Claude Code 插件 manifest
.claude-plugin/marketplace.json  Claude Code 本地 marketplace
.mcp.json                        Claude Code 加载的 OpenShelf MCP server
```

本地安装方式：

```bash
claude plugin marketplace add /path/to/OpenShelf
claude plugin install openshelf@openshelf-local
```

安装后重启 Claude Code 或开启新会话。Claude Code 会导入名为 `openshelf` 的 MCP server。插件数据默认保存在 Claude 的 `${CLAUDE_PLUGIN_DATA}/data` 中；已有 `.duckdb` 文件可以用 `create_db_from_exist` 注册。

## 推荐工作流

OpenShelf 面向的是带 MCP 工具的 LLM agent，而不是要求用户手动执行每个检索步骤。典型流程是：

1. 用户用自然语言指定知识库和问题，例如“用 `research_corpus` 回答这个问题”。
2. Agent 根据问题选择 `search`、`search_terms` 或 `search_technical_results`。
3. 如果结果是 `supported`，agent 基于引用证据直接回答。
4. 如果结果是 `related_only` 或 `not_found`，agent 先说明知识库证据不足，并询问用户是否允许继续推理。
5. 用户允许继续推理后，如果知识库是 closed corpus，agent 需要用 `check_reasonable` 审核推理是否超出语料边界；如果是 open research corpus，agent 可以继续，但必须标注哪些内容来自知识库、哪些是独立推理。
6. 如果用户需要定理、定义、命题级检索，agent 可以建议在已入库文档上调用 `build_technical_index` 生成术语 chunk。

## PDF 入库要求

默认只接受能直接抽取文本的 PDF。LaTeX 生成的论文 PDF、带文本层的电子书通常可以入库；扫描件、图片型 PDF、不能复制粘贴文字的 PDF 会被拒绝。

默认设置：

```text
ocr: "never"
require_searchable: true
```

如果需要处理扫描件，必须显式开启 OCR。OCR 依赖本地 Tesseract，且对公式、表格和复杂排版不稳定。

详见 [快速开始：PDF 要求](docs/getting-started.zh-CN.md#pdf-要求)。

## 核心工具

| 工具 | 用途 |
|---|---|
| `create_db` | 创建命名 DuckDB 知识库，可选地批量导入 PDF。 |
| `create_db_from_exist` | 注册已有 OpenShelf DuckDB 文件，不复制、不重新入库。 |
| `list_db` | 列出可用知识库和 profile。 |
| `create_document` | 添加一个可搜索 PDF，默认拒绝无文本层 PDF。 |
| `search` | 检索 chunk 并返回证据判断。 |
| `search_terms` | 面向技术问题或领域问题的两阶段检索。 |
| `build_technical_index` | 构建 theorem、lemma、definition 等术语索引。 |
| `search_technical_results` | 搜索结构化 technical result。 |
| `get_chunk` / `get_page_text` / `get_page_image` | 回看 chunk、页面文本和页面图片。 |

完整 schema 见 [工具参考](docs/tool-reference.md)。

## 文档

| 页面 | 内容 |
|---|---|
| [快速开始](docs/getting-started.zh-CN.md) | 安装、MCP 配置、入库、smoke test、PDF 要求。 |
| [核心概念](docs/concepts.zh-CN.md) | 知识库、DuckDB 文件、closed/open profile、页面 chunk、术语 chunk。 |
| [检索与证据](docs/search-and-evidence.zh-CN.md) | BM25、检索模式、answerability、技术结果索引。 |
| [工具参考](docs/tool-reference.md) | MCP 工具输入输出 schema。 |
| [开发说明](docs/development.zh-CN.md) | 本地数据、测试、Git 忽略策略。 |

## 开发

```bash
npm run typecheck
npm run test:unit
```

运行时数据默认保留在本地并被 Git 忽略：

```text
data/index/        DuckDB 数据库和 catalog
data/pdfs/         可选 PDF 暂存目录
data/rendered/     页面图片缓存
data/test_outputs/ 测试输出
```

下一页：[快速开始](docs/getting-started.zh-CN.md)
