# 核心概念

[首页](../README.zh-CN.md) · [English](concepts.md) · 上一页：[快速开始](getting-started.zh-CN.md) · 下一页：[检索与证据](search-and-evidence.zh-CN.md)

## 知识库

OpenShelf 的一个知识库对应一个物理 DuckDB 文件。多个知识库之间硬隔离，不做隐式 union search。

常见字段：

```text
db_name      逻辑名称，例如 default 或 research_corpus
duckdb_path  物理 DuckDB 文件路径
source_path  可选的原始资料目录
profile      对 closed/open 语料边界和推理策略的描述
```

如果系统中存在多个知识库，检索和读取工具会要求显式指定 `db_name`，或者先用 `set_active_db` 设置当前会话默认知识库。

## DuckDB 文件

OpenShelf 使用 DuckDB 存储文档、页面、chunk、词项统计和可选技术结果索引。知识库可以通过 `.duckdb` 文件共享：

```json
{
  "db_name": "shared_corpus",
  "duckdb_path": "/path/to/kb_shared_corpus.duckdb"
}
```

注册已有库时，OpenShelf 会校验该文件包含必要表；注册过程不会复制文件或重新入库。

## 页面 chunk

普通入库会生成：

```text
documents
pages
chunks
chunk_terms
embedding_jobs
semantic_index
```

页面 chunk 是默认检索对象。它们来自 PDF 页面文本切分，适合回答“原文是否直接支持这个问题”。

## Closed Corpus 与 Open Research Corpus

OpenShelf 用 profile 记录知识库的语料边界。这个边界不改变数据库内容，但会影响智能体应该如何解释检索结果。

| 类型 | 含义 | 推荐行为 |
|---|---|---|
| `closed_corpus` | 用户希望答案严格来自这个知识库，例如教材、课程材料、内部资料。 | 只有直接证据足够时才回答；证据不足时说明知识库没有支持。 |
| `open_research` | 知识库是研究上下文的一部分，例如论文库、项目文献库。 | 可以在清楚标注的情况下做独立推理，但要区分库内证据和外部推理。 |
| `hybrid` | 语料边界不明确，既可能需要库内证据，也可能需要额外推理。 | 优先检索库内证据；证据不足时询问用户是否继续推理。 |

OpenShelf 会根据 `db_name`、`source_path` 和 `tags` 推断 profile。例如教材类名字更容易被视为 closed corpus，研究语料更容易被视为 open research corpus。用户也可以通过命名和标签让知识库边界更明确。

## 术语 chunk / Technical Result

术语 chunk 不是默认入库时自动生成的回答材料，而是入库之后由用户按需选择生成的结构化索引。普通入库只生成页面 chunk；当用户明确需要定理、定义、命题或证明级检索时，再调用 `build_technical_index`。

术语 chunk 面向理论文档中的：

```text
theorem
lemma
proposition
definition
corollary
assumption
proof
```

调用 `build_technical_index` 后会写入：

```text
technical_results
technical_result_links
```

一个 technical result 通常包含结构化标题、结果类型、页码范围、statement、proof、关联 chunk ids 和附近术语。它适合查定理、定义、命题和证明依赖，不应该只用普通 RAG 的 gold-answer recall 评价。

## Profile

Profile 是 closed/open 边界的机器可读记录，例如：

- 教材库更像封闭语料，回答应尽量只用库内证据。
- 研究论文库更像开放研究语料，可以在明确标注后进行独立推理。

Profile 不改变 DuckDB 内容，只帮助智能体决定何时回答、何时说明证据不足、何时询问是否允许外部推理。

上一页：[快速开始](getting-started.zh-CN.md) · 下一页：[检索与证据](search-and-evidence.zh-CN.md)
