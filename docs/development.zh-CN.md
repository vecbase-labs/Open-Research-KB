# 开发说明

[首页](../README.zh-CN.md) · [English](development.md) · 上一页：[检索与证据](search-and-evidence.zh-CN.md)

## 常用命令

```bash
npm run typecheck
npm run test:unit
```

可选 smoke test：

```bash
KB_MCP_SMOKE_PDF=<path-to-sample.pdf> npm run smoke:pdf
```

## 本地数据

运行时数据默认保留在本地，并被 Git 忽略：

```text
data/index/        DuckDB 数据库和数据库 catalog
data/pdfs/         可选 PDF 暂存目录
data/rendered/     缓存的页面图片
data/test_outputs/ 测试输出
```

每个知识库是一个独立 DuckDB 文件，例如：

```text
data/index/kb_default.duckdb
```

## 入库依赖

PDF 文本抽取依赖 Poppler：

```text
pdftotext
pdfinfo
pdftoppm
```

OCR 依赖 Tesseract，但默认关闭。建议优先使用带文本层的 PDF。

## 代码边界

主要代码：

```text
src-ts/server.ts  MCP 工具注册
src-ts/store.ts   入库、检索、DuckDB catalog、证据判断
tests/            单元测试
scripts/          smoke test 和辅助脚本
docs/             用户文档和工具参考
```

## Git 策略

仓库不应提交：

```text
node_modules/
data/index/*.duckdb
data/rendered/
data/test_outputs/
本地日志和环境文件
```

如果需要共享知识库，优先共享 `.duckdb` 文件本身，然后用 `create_db_from_exist` 注册。

上一页：[检索与证据](search-and-evidence.zh-CN.md) · 回到：[首页](../README.zh-CN.md)
