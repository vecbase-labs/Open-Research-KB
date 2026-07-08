# 检索与证据

[首页](../README.zh-CN.md) · [English](search-and-evidence.md) · 上一页：[核心概念](concepts.zh-CN.md) · 下一页：[开发说明](development.zh-CN.md)

## 默认检索

`search` 默认使用：

```json
{
  "mode": "text"
}
```

这表示 DuckDB-backed BM25 文本检索。它是当前最稳定、最容易解释的路径。

## 检索模式

| 模式 | 含义 |
|---|---|
| `text` | BM25 文本检索，当前默认模式。 |
| `overlap` | 探索性的词项重叠检索。 |
| `hybrid` | BM25 加词项重叠；不是标准 BM25 + 向量混合检索。 |
| `semantic` | 为未来 LanceDB 向量 side index 预留。 |
| `vector` | `semantic` 的废弃别名。 |

当前项目没有默认启用 embedding 检索。语义向量检索需要额外构建 embedding side index，并涉及模型选择、速度、可复现性和本地算力问题。

## Answerability

OpenShelf 不把“搜到相关内容”等同于“可以回答”。检索结果会返回 answerability 元数据：

| 状态 | 含义 | 推荐行为 |
|---|---|---|
| `supported` | 找到直接文本证据。 | 基于引用证据回答。 |
| `related_only` | 找到相关材料，但不足以支持答案。 | 说明限制，再询问或标注独立推理。 |
| `not_found` | 没有找到可用证据。 | 先说明知识库没有证据。 |

这对研究型资料库很重要，因为相关段落、定义、定理和结论之间常常不能直接互相替代。

Closed corpus 场景通常要求“答案必须来自库内证据”，因此 answerability 更严格。Open research corpus 可以允许额外推理，但必须明确区分：哪些内容来自知识库，哪些内容是独立推理。

## Agent 决策流程

OpenShelf 的主要交互对象是带 MCP 工具的 LLM agent。用户通常不需要知道具体调用哪个工具，而是用自然语言指定知识库和问题。

推荐 agent 行为：

1. 解析用户指定的 `db_name`，或在多个知识库存在时要求用户选择。
2. 优先调用 `search` 或 `search_terms`，必要时调用 `search_technical_results`。
3. 当 `answerability.status` 为 `supported` 时，基于引用证据直接回答。
4. 当状态为 `related_only` 或 `not_found` 时，说明知识库没有足够直接证据，并询问用户是否允许继续推理。
5. 如果用户允许继续推理，并且 profile 是 `closed_corpus`，先调用 `check_reasonable` 审核推理是否仍在语料边界内。
6. 如果 profile 是 `open_research`，可以继续独立推理，但必须明确标注库内证据和独立推理的边界。

这个流程使 OpenShelf 既能作为检索系统使用，也能作为 agent 的证据边界和推理审计层。

## Top K 和指标

`top_k` 表示检索排序后返回的前 K 个结果。常见指标包括：

```text
Recall@1   gold evidence 是否出现在第 1 个结果
Recall@5   gold evidence 是否出现在前 5 个结果
Recall@10  gold evidence 是否出现在前 10 个结果
MRR@10     第一个相关结果在前 10 内的位置倒数
```

这些指标适合评价“能否找到标准答案所在原文”。但 technical result 索引可能返回结构化定理、定义或证明对象，它的目标不完全等同于命中 gold answer 原文，因此需要额外评价体系。

## Technical Result 检索

当需要 theorem、lemma、definition、proposition 等结构化对象时：

1. 先正常入库 PDF，生成页面 chunk。
2. 用户确认需要术语级检索后，再调用 `build_technical_index`。
3. 使用 `search_technical_results` 查询结构化结果。

这个流程会保留 technical result 和原始 chunk/page 的关联，方便回看来源。

上一页：[核心概念](concepts.zh-CN.md) · 下一页：[开发说明](development.zh-CN.md)
