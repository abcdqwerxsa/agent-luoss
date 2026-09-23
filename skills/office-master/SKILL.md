---
name: office-master
description: Create, read, edit and render Word (.docx), Excel (.xlsx) and PowerPoint (.pptx) documents via the officecli binary (Apache-2.0, vendored in the runtime image). Use for any office-document task - reports, decks, spreadsheets, batch edits - instead of hand-writing openpyxl/python-docx scripts.
---

# Office Master（OfficeCLI 文档专家）

`officecli` is pre-installed in this environment (self-contained binary, no
Office needed, works fully offline). It is ALWAYS preferred over ad-hoc
python-docx/openpyxl scripts: transactional batches, schema-driven, and it can
render what it produces.

## Command model

```bash
officecli <verb> <file> [args]     # add --json for machine-readable output
```

Core verbs: `create` (blank file) · `get <path>` · `query <selector>` ·
`add <parent> --type <t> --prop k=v` · `set <path> --prop k=v` · `remove` ·
`move` / `swap` · `batch --commands <json>` · `save` · `close` ·
`view <file> html|screenshot` · `validate` · `raw` / `raw-set` (XML escape hatch).

The CLI documents itself — schema-driven, always correct, use it before guessing:
```bash
officecli help pptx              # all elements for a format (also: docx, xlsx)
officecli help pptx add          # which elements accept 'add'
officecli help pptx textbox      # full element detail incl. valid props
officecli add --help             # verb flags
```

## Path conventions (verified)

- pptx: slides hang off the root → `add deck.pptx / --type slide`;
  shapes go under `/slide[N]` (singular). Types: shape, textbox, picture,
  table, chart, connector, group, video, audio, model3d, equation, notes, zoom.
- docx: body elements under `/body` — paragraph, heading, table, picture...
- xlsx: sheets by name → `/Sheet1`; `add sheet.xlsx / --type sheet --prop name=Data`.
- Sizes accept units: `36pt`, `1cm`, `6in`; booleans `true/false`.

## Typical flow (deck from scratch)

```bash
officecli create deck.pptx
officecli add deck.pptx / --type slide
officecli add deck.pptx '/slide[1]' --type textbox --prop text="季度回顾" --prop x=1cm --prop y=1cm --prop fontSize=36pt --prop bold=true
officecli add deck.pptx '/slide[1]' --type textbox --prop text="营收 +18%" --prop x=1cm --prop y=6cm
officecli save deck.pptx
officecli view deck.pptx html -o deck.html        # render check (no browser needed)
```

Batch (preferred for >3 operations — single transaction, rolls back on error):
```bash
officecli batch deck.pptx --commands '[
  {"command":"add","parent":"/","type":"slide"},
  {"command":"add","parent":"/slide[1]","type":"textbox","props":{"text":"标题","x":"1cm","y":"1cm","fontSize":"36pt"}}
]'
```

## Rules

- **Rendering in this environment**: no headless browser is installed, so
  `view screenshot` will fail — use `view <file> html` instead (standalone
  HTML with inlined assets; deliver it as an attachment if useful) and verify
  structure via `get`/`query`. Do NOT retry screenshot; do not try to install
  a browser.
- Create first: `officecli create <file>` for a new document; idempotent rerun
  pattern is `close → rm → create → batch`.
- Resident mode keeps the file in memory: before any NON-officecli program
  reads it, `officecli save <file>` first (own get/view always see edits).
- When visual quality matters, inspect the `view html` output's structure and
  deliver both the office file and the HTML preview.
- Numbers-heavy Excel computation may still use python; structure and edits go
  through officecli.
- Do not invent types/props: `officecli help <format> <element>` first.
