#!/usr/bin/env python3
"""excel_summary.py — 提取关键数字,辅助写趋势总结。

读 xlsx,找出数值列,计算总和、平均、CAGR、最近/最初值等。
JSON 输出到 stdout,模型据此写 chat 总结。

用法:
    python3 excel_summary.py <file.xlsx> [--sheet <name>]

输出字段:
    path, sheets[{name, columns[{key, label, count, sum, min, max, avg,
                                  first, last, cagr_pct}]}]
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
    print("openpyxl not installed", file=sys.stderr)
    sys.exit(2)


def col_letter(idx: int) -> str:
    s = ""
    n = idx
    while n > 0:
        n, rem = divmod(n - 1, 26)
        s = chr(ord("A") + rem) + s
    return s


def summarize_column(values: list[Any]) -> dict[str, Any]:
    nums: list[tuple[int, float]] = []
    for i, v in enumerate(values):
        if isinstance(v, (int, float)):
            nums.append((i, float(v)))
    if not nums:
        return {"count": 0, "sum": 0, "min": None, "max": None, "avg": None,
                 "last": None, "first": None, "cagr_pct": None}
    vals = [v for _, v in nums]
    s = sum(vals)
    mn = min(vals)
    mx = max(vals)
    avg = s / len(vals)
    first, last = vals[0], vals[-1]
    # 简单 CAGR(假设等间距);年数 = last_idx - first_idx
    if first > 0 and len(vals) >= 2:
        years = nums[-1][0] - nums[0][0]
        if years > 0:
            cagr = (last / first) ** (1.0 / years) - 1.0
            cagr_pct = round(cagr * 100, 2)
        else:
            cagr_pct = None
    else:
        cagr_pct = None
    return {
        "count": len(nums),
        "sum": round(s, 4),
        "min": mn,
        "max": mx,
        "avg": round(avg, 4),
        "first": first,
        "last": last,
        "cagr_pct": cagr_pct,
    }


def summarize_sheet(ws, sample_n: int = 50) -> dict[str, Any]:
    max_row = ws.max_row or 0
    max_col = ws.max_column or 0
    if max_row < 2:
        return {"name": ws.title, "skipped": "no data rows"}

    headers: list[str] = []
    for c in range(1, max_col + 1):
        v = ws.cell(row=1, column=c).value
        headers.append("" if v is None else str(v))

    # 收集每列前 sample_n 行的值
    last_row = min(max_row, 1 + sample_n)
    columns_data: list[dict[str, Any]] = []
    for c in range(1, max_col + 1):
        vals = [ws.cell(row=r, column=c).value for r in range(2, last_row + 1)]
        s = summarize_column(vals)
        s["key"] = col_letter(c)
        s["label"] = headers[c - 1] if c - 1 < len(headers) else ""
        columns_data.append(s)

    return {
        "name": ws.title,
        "max_row": max_row,
        "max_col": max_col,
        "columns": columns_data,
    }


def main() -> int:
    p = argparse.ArgumentParser(description="Summarize numeric columns in xlsx")
    p.add_argument("xlsx", help="path to .xlsx")
    p.add_argument("--sheet", default="", help="limit to a single sheet")
    p.add_argument("--sample", type=int, default=50)
    p.add_argument("--pretty", action="store_true")
    args = p.parse_args()

    path = Path(args.xlsx)
    if not path.exists():
        print(f"file not found: {path}", file=sys.stderr)
        return 1

    wb = load_workbook(str(path), data_only=True)
    names = [args.sheet] if args.sheet else wb.sheetnames
    sheets = []
    for n in names:
        if n not in wb.sheetnames:
            continue
        sheets.append(summarize_sheet(wb[n], args.sample))

    out = {"path": str(path.resolve()), "sheets": sheets}
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