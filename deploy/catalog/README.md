# Catalog — vendored third-party local skills/MCP

产品随包分发的精选能力目录。**只收 MIT/Apache-2.0/BSD**（客户采购尽调零成本档），
每项必须保留上游 LICENSE.txt 并在 `import-catalog.mjs` 顶部记录 upstream 仓库 + pinned commit。

- `skills/` — 技能源码（含各自 LICENSE.txt），zip 上传进平台
- MCP stdio 二进制不放在此目录，统一烘进 `deploy/Dockerfile.runtime`（内网 runtime 不能拉包）

## 已收录（anthropics/skills @ 34040c9, 2026-09-10, Apache-2.0）

skill-creator, mcp-builder, web-artifacts-builder, frontend-design, canvas-design,
theme-factory, algorithmic-art, internal-comms

## 已排除及原因（审查记录）

- `docx` `pdf` `pptx` `xlsx` — Anthropic 专有协议，禁止再分发/转卖（卖产品场景直接违约）
- `doc-coauthoring` — 无 LICENSE 文件，版权状态不明
- `academy-guide` — 多行 YAML frontmatter（平台解析器只支持单行）+ 场景小众
- `brand-guidelines` — Anthropic 品牌专用，对客户无通用价值
- `slack-gif-creator` `webapp-testing` `claude-api` — 依赖外网服务/重型浏览器/单一厂商 API
