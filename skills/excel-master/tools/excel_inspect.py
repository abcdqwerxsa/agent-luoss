#!/usr/bin/env python3
"""excel_inspect.py — 解析 xlsx 结构,JSON 输出到 stdout。

用法:
    python3 excel_inspect.py <file.xlsx> [--pretty] [--sample N] [--data-only]

输出字段:
    path, sheet_count, sheets[{name, max_row, max_col, headers, sample_rows,
                                formula_count, merged, col_widths, charts}]

设计要点:
- 不依赖 pandas,只用 openpyxl(降低镜像体积)
- data_only=False 读公式字符串(默认);--data-only 时读最近一次 Excel 重算的值
- 大文件不读全部行,只 sample 前 N 行(默认 5)
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

try:
    from openpyxl import load_workbook
except ImportError:
    print("openpyxl not installed; pip install openpyxl>=3.1", file=sys.stderr)
    sys.exit(2)


def cell_payload(cell) -> dict[str, Any]:
    v = cell.value
    return {
        "value": v,
        "is_formula": isinstance(v, str) and v.startswith("="),
        "type": type(v).__name__,
        "number_format": cell.number_format or "General",
    }


def inspect_sheet(ws, sample_n: int) -> dict[str, Any]:
    max_row = ws.max_row or 0
    max_col = ws.max_column or 0

    # Headers (row 1)
    headers: list[str] = []
    for c in range(1, max_col + 1):
        v = ws.cell(row=1, column=c).value
        headers.append("" if v is None else str(v))

    # Sample rows
    sample_rows: list[list[dict[str, Any]]] = []
    if max_row > 1:
        last = min(max_row, 1 + sample_n)
        for r in range(2, last + 1):
            row_data = [cell_payload(ws.cell(row=r, column=c)) for c in range(1, max_col + 1)]
            sample_rows.append(row_data)

    # 全表公式计数(单独扫一遍,避免重复)
    formula_count = 0
    for r in range(1, max_row + 1):
        for c in range(1, max_col + 1):
            v = ws.cell(row=r, column=c).value
            if isinstance(v, str) and v.startswith("="):
                formula_count += 1

    merged = sorted(str(mr) for mr in ws.merged_cells.ranges)

    col_widths = {
        col: float(ws.column_dimensions[col].width)
        for col in ws.column_dimensions
        if ws.column_dimensions[col].width
    }

    chart_count = len(getattr(ws, "_charts", []) or [])

    return {
        "name": ws.title,
        "max_row": max_row,
        "max_col": max_col,
        "headers": headers,
        "sample_rows": sample_rows,
        "formula_count": formula_count,
        "merged_count": len(merged),
        "merged_sample": merged[:5],
        "col_widths": col_widths,
        "chart_count": chart_count,
    }


def main() -> int:
    p = argparse.ArgumentParser(description="Inspect an xlsx file's structure")
    p.add_argument("xlsx", help="path to .xlsx")
    p.add_argument("--pretty", action="store_true", help="indent JSON output")
    p.add_argument("--sample", type=int, default=5, help="sample rows per sheet (default 5)")
    p.add_argument(
        "--data-only",
        action="store_true",
        help="read cached calculated values instead of formula strings",
    )
    args = p.parse_args()

    path = Path(args.xlsx)
    if not path.exists():
        print(f"file not found: {path}", file=sys.stderr)
        return 1

    wb = load_workbook(str(path), data_only=args.data_only, read_only=False)
    sheets = [inspect_sheet(wb[name], args.sample) for name in wb.sheetnames]

    out = {
        "path": str(path.resolve()),
        "sheet_count": len(sheets),
        "sheets": sheets,
    }

    json.dump(
        out,
        sys.stdout,
        ensure_ascii=False,
        indent=2 if args.pretty else None,
        default=str,
    )
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())