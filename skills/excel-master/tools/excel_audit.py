#!/usr/bin/env python3
"""excel_audit.py — 审计 xlsx 的"公式覆盖"问题(数据血缘检查)。

目的:LLM 写完 xlsx 后,本工具扫一遍每个 sheet,标记"应该是公式但写成了
静态值"的 candidate,让 LLM 自己裁决要不要修。

**设计:code 负责结构分类 + 启发式粗筛,LLM 负责语义裁决**——
- code 只能看出"是不是公式"(机械)
- "这个值该不该是公式"(语义)只能 LLM 自己判断
- 所以 code 只做"候选清单",不下定论

用法:
    # 人类 / chat 可读报告(默认)
    python3 excel_audit.py 年度总结.xlsx

    # JSON 给 LLM 二次裁决
    python3 excel_audit.py 年度总结.xlsx --json --candidate-only

    # 详细 JSON(含所有 cell,LLM 需要更细粒度时用)
    python3 excel_audit.py 年度总结.xlsx --json --all-cells

**启发式规则**:
- sheet 名含"原始"/"raw"/"源"/"source" + 0 公式 → 原始层,跳过
- sheet 名含"汇总"/"大盘"/"计算"/"聚合"/"报表" + 公式占比 < 30% → 计算层疑似,标记
- 单 cell 数字值 > 100 + 周围 (±2 行) 无公式邻居 → 潜在聚合值,标记
- sheet 名含"图表"/"chart" → 图表 sheet,跳过

LLM 拿到 candidate 清单后做语义判断,不会仅依赖本工具自动改 xlsx。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

try:
    from openpyxl import load_workbook
except ImportError:
    print("openpyxl not installed; pip install openpyxl>=3.1", file=sys.stderr)
    sys.exit(2)


# ─── Excel error values (canonical strings) ─────────────────────────
# Source: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-xlsx/
# openpyxl returns these as plain string cell values when reading with
# data_only=True. They are deterministic and don't need LLM judgment —
# always flag them as a hard FAIL.
EXCEL_ERRORS = {
    "#DIV/0!",   # division by zero
    "#REF!",     # invalid cell reference
    "#VALUE!",   # wrong argument type
    "#NAME?",    # unrecognized function/name
    "#N/A",      # value not available
    "#NUM!",     # invalid numeric value
    "#NULL!",    # invalid intersection
    "#GETTING_DATA",  # async data load
    "#SPILL!",   # dynamic array spill blocked
    "#CALC!",    # calculation engine error (newer Excel)
}


# ─── Heuristic patterns (case-insensitive substring match) ─────────────
RAW_SHEET_NAMES = ("原始", "raw", "源", "源数据", "source", "data")
CALC_SHEET_NAMES = ("汇总", "大盘", "计算", "聚合", "报表", "summary", "summary")
CHART_SHEET_NAMES = ("图表", "chart", "visual", "可视化")


def _name_matches_any(name: str, patterns: tuple[str, ...]) -> bool:
    lower = name.lower()
    return any(p.lower() in lower for p in patterns)


# ─── Cell classification ──────────────────────────────────────────────
def _is_formula(cell) -> bool:
    v = cell.value
    return isinstance(v, str) and v.startswith("=")


def _is_static_value(cell) -> bool:
    """A static value is anything not a formula and not empty."""
    v = cell.value
    if v is None or v == "":
        return False
    return not _is_formula(cell)


def _is_error_value(cell) -> bool:
    """Hard error: cell contains a canonical Excel error string.

    These are deterministic — no LLM judgment needed. Always flagged.
    """
    v = cell.value
    return isinstance(v, str) and v in EXCEL_ERRORS


def _is_static_div_by_zero(formula: str) -> bool:
    """Detect obvious static division-by-zero in a formula string.

    Example: `=B5/0`, `=SUM(A:A)/0`, `=A1/(0)`
    Negative matches: `=B5/10`, `=B5/0.5`, `=B5/(B6*0.3)`
    """
    # /0 not followed by a digit or . (so /0.5, /10 etc don't match)
    return bool(re.search(r"/0(?![.\d])", formula))


# ─── Formula reference extraction ─────────────────────────────────────
# Match: =Sheet1!A1  or  =Sheet1!A1:B5  or  ='Sheet 1'!A1
# Match: =T_Table[Col]  (structured references, simplified)
_SHEET_REF = re.compile(
    r"'([^']+)'!([A-Z]+\d+(?::[A-Z]+\d+)?)"  # 'Sheet'!A1:B2
    r"|"
    r"([A-Za-z_][\w]*?)!([A-Z]+\d+(?::[A-Z]+\d+)?)"  # Sheet!A1:B2
    r"|"
    r"([A-Za-z_][\w]*?)\[([^\]]+)\]"  # Table[Col]
)


def _parse_formula_refs(formula: str) -> list[dict[str, str]]:
    """Extract sheet references from a formula string. Best-effort."""
    refs: list[dict[str, str]] = []
    for m in _SHEET_REF.finditer(formula):
        if m.group(1):  # 'Sheet'!A1:B2
            refs.append({"sheet": m.group(1), "range": m.group(2), "kind": "cross_sheet"})
        elif m.group(3):  # Sheet!A1:B2
            refs.append({"sheet": m.group(3), "range": m.group(4), "kind": "cross_sheet"})
        elif m.group(5):  # Table[Col]
            refs.append({"table": m.group(5), "col": m.group(6), "kind": "table"})
    return refs


# ─── Walk + classify one sheet ───────────────────────────────────────
def _walk_sheet(ws, ws_values=None) -> dict[str, Any]:
    """Return: cells, formulas, static_values, formula_refs, errors.

    `ws_values` is an optional second Worksheet loaded with data_only=True;
    if provided, we cross-reference cell coordinates to detect cached
    Excel error values (#DIV/0! etc.) that the formula load can't see.
    """
    cells: list[dict[str, Any]] = []
    formulas: list[dict[str, Any]] = []
    static_values: list[dict[str, Any]] = []
    formula_refs: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    # Pre-index value ws by coordinate for O(1) lookup
    value_map: dict[str, Any] = {}
    if ws_values is not None:
        for row in ws_values.iter_rows():
            for c in row:
                if c.value is not None:
                    value_map[c.coordinate] = c.value

    for row in ws.iter_rows():
        for cell in row:
            if cell.value is None or cell.value == "":
                continue
            entry = {
                "cell": cell.coordinate,
                "row": cell.row,
                "col": cell.column,
            }

            # Hard error detection (always flag, no LLM needed)
            cached = value_map.get(cell.coordinate)
            if isinstance(cached, str) and cached in EXCEL_ERRORS:
                entry["error"] = cached
                # try to recover the formula text (might be missing if data_only load)
                formula_text = (
                    str(cell.value) if _is_formula(cell) else None
                )
                errors.append({
                    "cell": cell.coordinate,
                    "error": cached,
                    "formula": formula_text,
                })
                # still record under formulas/static for accounting
                if _is_formula(cell):
                    entry["formula"] = str(cell.value)
                    formulas.append(entry)
                    refs = _parse_formula_refs(str(cell.value))
                    for r in refs:
                        r["from_cell"] = cell.coordinate
                        formula_refs.append(r)
                else:
                    entry["value"] = cell.value
                    static_values.append(entry)
                cells.append(entry)
                continue

            if _is_formula(cell):
                entry["formula"] = str(cell.value)
                # also flag static div-by-zero within the formula text
                if _is_static_div_by_zero(str(cell.value)):
                    errors.append({
                        "cell": cell.coordinate,
                        "error": "static_div_by_zero",
                        "formula": str(cell.value),
                    })
                formulas.append(entry)
                refs = _parse_formula_refs(str(cell.value))
                for r in refs:
                    r["from_cell"] = cell.coordinate
                    formula_refs.append(r)
            else:
                entry["value"] = cell.value
                static_values.append(entry)
            cells.append(entry)
    return {
        "name": ws.title,
        "max_row": ws.max_row or 0,
        "max_col": ws.max_column or 0,
        "cells": cells,
        "formulas": formulas,
        "static_values": static_values,
        "formula_refs": formula_refs,
        "errors": errors,
    }


# ─── Heuristics: classify each sheet ────────────────────────────────
def _classify_sheet(sheet: dict[str, Any]) -> dict[str, Any]:
    name = sheet["name"]
    n_formula = len(sheet["formulas"])
    n_static = len(sheet["static_values"])
    n_errors = len(sheet["errors"])

    # Rule 0 (highest priority): any hard error → always flag, regardless of sheet name
    if n_errors > 0:
        return {
            "verdict": "has_errors",
            "reason": f"发现 {n_errors} 个 Excel 错误 cell(#DIV/0! 等),必须修复",
            "candidate_cells": [],
            "errors": sheet["errors"],
        }

    # Rule 1: chart sheets → skip
    if _name_matches_any(name, CHART_SHEET_NAMES):
        return {
            "verdict": "skip_chart",
            "reason": "图表 sheet 本应无公式,跳过",
            "candidate_cells": [],
        }

    # Rule 2: raw layer → confirm-correct
    if _name_matches_any(name, RAW_SHEET_NAMES) and n_formula == 0:
        return {
            "verdict": "raw_layer",
            "reason": "原始数据层,全静态值是预期",
            "candidate_cells": [],
        }

    # Rule 3: calc layer, formula ratio is suspicious
    if _name_matches_any(name, CALC_SHEET_NAMES):
        if n_static > 0 and n_formula / max(n_formula + n_static, 1) < 0.3:
            # Mark all "large number" static cells as candidates
            candidates = _flag_large_static_cells(sheet)
            return {
                "verdict": "review_calc",
                "reason": f"计算/汇总层但公式占比仅 {n_formula}/{n_formula + n_static} (<30%)",
                "candidate_cells": candidates,
            }

    # Rule 4: default — flag large static values (LLM decides)
    candidates = _flag_large_static_cells(sheet)
    if candidates:
        return {
            "verdict": "review_generic",
            "reason": "发现可能是聚合结果的静态值,需 LLM 裁决",
            "candidate_cells": candidates,
        }

    return {
        "verdict": "ok",
        "reason": "公式覆盖或数据特征符合预期",
        "candidate_cells": [],
    }


def _flag_large_static_cells(sheet: dict[str, Any]) -> list[dict[str, Any]]:
    """Flag cells whose numeric value > 100 and have no formula neighbors.

    "No formula neighbors" = no formula cell in the same column ±2 rows.
    These are *candidates* — LLM decides if they're intentional.
    """
    flagged: list[dict[str, Any]] = []
    for sv in sheet["static_values"]:
        v = sv["value"]
        if not isinstance(v, (int, float)) or v <= 100:
            continue
        # Check for formula neighbors
        has_neighbor = False
        for f in sheet["formulas"]:
            if f["col"] == sv["col"] and abs(f["row"] - sv["row"]) <= 2:
                has_neighbor = True
                break
        if has_neighbor:
            continue

        # Build row context (same row, ±2 cols)
        row_ctx = []
        for c in sheet["cells"]:
            if c["row"] == sv["row"] and abs(c["col"] - sv["col"]) <= 2:
                row_ctx.append({
                    "cell": c["cell"],
                    "value": c.get("value"),
                    "formula": c.get("formula"),
                })
        # Column header (row 1 of same column)
        col_header = None
        for c in sheet["cells"]:
            if c["row"] == 1 and c["col"] == sv["col"]:
                col_header = c.get("value") or c.get("formula")
                break

        flagged.append({
            "cell": sv["cell"],
            "value": v,
            "column_header": col_header,
            "row_context": row_ctx,
            "hint": "value > 100 with no formula neighbors — likely an aggregation that should be a formula",
        })
    return flagged


# ─── Top-level audit ────────────────────────────────────────────────
def audit(path: Path) -> dict[str, Any]:
    # Load twice: once for formulas (default), once for cached values
    # so we can detect #DIV/0! etc. that the formula load can't surface.
    wb_formulas = load_workbook(str(path), data_only=False, read_only=False)
    try:
        wb_values = load_workbook(str(path), data_only=True, read_only=False)
    except Exception:  # pragma: no cover
        wb_values = None

    sheet_results: list[dict[str, Any]] = []
    total_candidates = 0
    total_violations = 0
    total_errors = 0

    for name in wb_formulas.sheetnames:
        ws_vals = wb_values[name] if wb_values and name in wb_values.sheetnames else None
        sheet = _walk_sheet(wb_formulas[name], ws_vals)
        classification = _classify_sheet(sheet)
        sheet_results.append({
            "name": name,
            "n_formula": len(sheet["formulas"]),
            "n_static": len(sheet["static_values"]),
            "n_cells": len(sheet["cells"]),
            "n_errors": len(sheet["errors"]),
            "verdict": classification["verdict"],
            "reason": classification["reason"],
            "candidate_cells": classification["candidate_cells"],
            "errors": classification.get("errors", []),
        })
        if classification["verdict"] == "has_errors":
            total_errors += len(classification.get("errors", []))
        if classification["verdict"] in ("review_calc", "review_generic"):
            total_violations += len(classification["candidate_cells"])
        total_candidates += len(classification["candidate_cells"])

    # Hard errors take priority over formula-coverage judgement
    if total_errors > 0:
        overall = "FAIL"
    elif total_violations == 0:
        overall = "PASS"
    elif total_violations <= 5:
        overall = "PASS_WITH_NOTES"
    else:
        overall = "NEEDS_REVIEW"

    return {
        "path": str(path.resolve()),
        "overall": overall,
        "n_sheets": len(sheet_results),
        "total_candidates": total_candidates,
        "total_violations": total_violations,
        "total_errors": total_errors,
        "sheets": sheet_results,
    }


# ─── Output formats ─────────────────────────────────────────────────
def format_pretty(result: dict[str, Any]) -> str:
    lines = [
        f"=== Excel Audit: {result['path']} ===",
        f"overall: {result['overall']}",
        f"sheets: {result['n_sheets']}  candidates: {result['total_candidates']}  errors: {result['total_errors']}",
        "",
    ]
    for s in result["sheets"]:
        ratio = (
            f"{s['n_formula']}/{s['n_formula'] + s['n_static']}"
            if s["n_formula"] + s["n_static"] > 0
            else "0/0"
        )
        marker = {
            "ok": "✓",
            "raw_layer": "✓ raw",
            "skip_chart": "✓ chart",
            "review_calc": "⚠ review",
            "review_generic": "⚠ review",
            "has_errors": "✗ ERROR",
        }.get(s["verdict"], "?")
        lines.append(f"[{s['name']}] {marker}  formulas {ratio}  | {s['reason']}")
        # Hard errors — must be fixed
        for e in s.get("errors", []):
            formula = e.get("formula") or "(no formula)"
            lines.append(
                f"    ✗ {e['cell']}  error={e['error']}  formula={formula[:60]}"
            )
        for c in s["candidate_cells"]:
            col = c["column_header"] or "?"
            ctx = " ".join(
                f"{rc['cell']}={rc.get('value') or rc.get('formula') or ''}"
                for rc in c["row_context"][:3]
            )
            lines.append(
                f"    {c['cell']}  value={c['value']}  col={col}  ctx=[{ctx}]"
            )
        if s.get("errors") or s["candidate_cells"]:
            lines.append("")
    return "\n".join(lines)


def format_json(result: dict[str, Any], candidate_only: bool, all_cells: bool) -> str:
    """JSON output. candidate_only=True hides per-cell manifest (only flagged)."""
    if candidate_only and not all_cells:
        # Slim format for LLM second-pass judgment
        slim = {
            "path": result["path"],
            "overall": result["overall"],
            "total_violations": result["total_violations"],
            "total_errors": result["total_errors"],
            "sheets": [
                {
                    "name": s["name"],
                    "verdict": s["verdict"],
                    "reason": s["reason"],
                    "errors": s.get("errors", []),
                    "candidate_cells": s["candidate_cells"],
                }
                for s in result["sheets"]
                if s.get("errors") or s["candidate_cells"]
            ],
        }
        return json.dumps(slim, ensure_ascii=False, indent=2)
    return json.dumps(result, ensure_ascii=False, indent=2, default=str)


# ─── CLI ─────────────────────────────────────────────────────────────
def main() -> int:
    p = argparse.ArgumentParser(description="Audit xlsx formula coverage")
    p.add_argument("xlsx", help="path to .xlsx")
    p.add_argument("--json", action="store_true", help="JSON format")
    p.add_argument(
        "--candidate-only",
        action="store_true",
        help="JSON: only output flagged candidate cells (LLM second-pass format)",
    )
    p.add_argument(
        "--all-cells",
        action="store_true",
        help="JSON: include every cell (not just flagged). Use for debugging.",
    )
    args = p.parse_args()

    path = Path(args.xlsx)
    if not path.exists():
        print(f"file not found: {path}", file=sys.stderr)
        return 1

    result = audit(path)
    if args.json:
        print(format_json(result, args.candidate_only, args.all_cells))
    else:
        print(format_pretty(result))
    # Non-zero exit if FAIL (hard errors) or NEEDS_REVIEW (candidates)
    # — lets CI / agent scripts fail loudly
    return 0 if result["overall"] not in ("NEEDS_REVIEW", "FAIL") else 2


if __name__ == "__main__":
    sys.exit(main())