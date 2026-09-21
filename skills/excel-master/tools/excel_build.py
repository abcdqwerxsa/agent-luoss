#!/usr/bin/env python3
"""excel_build.py — 从 JSON spec 构建 xlsx(数据 + 公式 + 样式)。

Spec 格式:
{
  "sheets": [
    {
      "name": "趋势数据",                   # sheet 名
      "title": "...",                       # 可选,A1 合并单元格标题
      "headers": ["col1", "col2", ...],     # 表头,写第 1 行
      "rows": [[v1, v2, ...], ...],         # 数据行,从第 2 行开始;空字符串/""
      "formulas": [                         # 显式公式
        {"cell": "C3", "formula": "=(B3-B2)/B2", "number_format": "0.00%"}
      ],
      "column_widths": {"A": 12, "B": 22},   # 可选
      "summary_cell": "A20"                  # 可选,把 summary_text 写到此处
    }
  ],
  "summary_text": "趋势总结..."              # 可选,顶层总结写到每个 sheet 的 summary_cell
}

样式默认:表头加粗 + 底色 #D9E2F3 + 居中 + 边框;数据行左对齐 + 边框。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

try:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
except ImportError:
    print("openpyxl not installed", file=sys.stderr)
    sys.exit(2)


HEADER_FILL = PatternFill("solid", fgColor="D9E2F3")
HEADER_FONT = Font(bold=True)
THIN = Side(border_style="thin", color="B0B0B0")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)
LEFT = Alignment(horizontal="left", vertical="center", wrap_text=True)


def style_header_row(ws, max_col: int) -> None:
    for c in range(1, max_col + 1):
        cell = ws.cell(row=1, column=c)
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = CENTER
        cell.border = BORDER


def style_data_row(ws, row: int, max_col: int) -> None:
    for c in range(1, max_col + 1):
        cell = ws.cell(row=row, column=c)
        cell.alignment = LEFT
        cell.border = BORDER


def write_sheet(ws, sheet: dict[str, Any], summary_text: str) -> dict[str, Any]:
    headers: list[str] = list(sheet.get("headers", []))
    rows: list[list[Any]] = list(sheet.get("rows", []))
    formulas: list[dict[str, Any]] = list(sheet.get("formulas", []))
    title: str | None = sheet.get("title")
    col_widths: dict[str, float] = sheet.get("column_widths", {}) or {}
    summary_cell: str | None = sheet.get("summary_cell")

    max_col = len(headers)

    # 表头
    for c, h in enumerate(headers, start=1):
        ws.cell(row=1, column=c, value=h)
    style_header_row(ws, max_col)

    # 数据行
    for ri, row in enumerate(rows, start=2):
        for ci, v in enumerate(row, start=1):
            if v == "" or v is None:
                # 跳过空值,留给公式列显式写
                continue
            ws.cell(row=ri, column=ci, value=v)
        style_data_row(ws, ri, max_col)

    # 公式
    for f in formulas:
        cell = ws[f["cell"]]
        cell.value = f["formula"]
        if "number_format" in f:
            cell.number_format = f["number_format"]
        if "alignment" in f:
            cell.alignment = Alignment(**f["alignment"])

    # 列宽
    for col, w in col_widths.items():
        ws.column_dimensions[col].width = w

    # 标题(合并到表头行之上,需要一行空隙)
    if title:
        ws.insert_rows(1)
        ws.cell(row=1, column=1, value=title)
        ws.merge_cells(
            start_row=1, start_column=1, end_row=1, end_column=max(1, max_col)
        )
        c = ws.cell(row=1, column=1)
        c.font = Font(bold=True, size=14)
        c.alignment = CENTER

    # 总结
    if summary_cell and summary_text:
        ws[summary_cell] = summary_text
        ws[summary_cell].alignment = Alignment(wrap_text=True, vertical="top")

    return {
        "name": ws.title,
        "rows_written": len(rows),
        "headers": len(headers),
        "formulas_written": len(formulas),
        "summary_written": bool(summary_cell and summary_text),
    }


def main() -> int:
    p = argparse.ArgumentParser(description="Build an xlsx from a JSON spec")
    p.add_argument("--spec", required=True, help="path to JSON spec")
    p.add_argument("--out", required=True, help="output .xlsx path")
    args = p.parse_args()

    spec_path = Path(args.spec)
    out_path = Path(args.out)
    if not spec_path.exists():
        print(f"spec not found: {spec_path}", file=sys.stderr)
        return 1

    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    summary_text = spec.get("summary_text", "")

    wb = Workbook()
    # Remove default sheet
    default_name = wb.active.title
    if default_name and not spec.get("sheets"):
        print("no sheets in spec", file=sys.stderr)
        return 1

    sheets_spec = list(spec.get("sheets", []))
    if sheets_spec:
        # Replace default sheet with first spec sheet
        first_ws = wb.active
        first_ws.title = sheets_spec[0]["name"]
        write_sheet(first_ws, sheets_spec[0], summary_text)
        for s in sheets_spec[1:]:
            ws = wb.create_sheet(title=s["name"])
            write_sheet(ws, s, summary_text)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(str(out_path))

    json.dump(
        {
            "out": str(out_path.resolve()),
            "sheets_written": len(sheets_spec),
            "summary_attached": bool(summary_text),
        },
        sys.stdout,
        ensure_ascii=False,
    )
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())