#!/usr/bin/env python3
"""Weekly checker for Kyoto Marathon 2027 official runner guide updates.

Targets Run-Navigator's ``app/src/main/assets/races/kyoto-2027/race.json``
instead of the legacy Kyoto-Run repository.
"""

from __future__ import annotations

import argparse
import json
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RACE_JSON = ROOT / "app" / "src" / "main" / "assets" / "races" / "kyoto-2027" / "race.json"

URLS = [
    "https://kyoto-marathon.com/info/",
    "https://kyoto-marathon.com/en/info/",
    "https://kyoto-marathon.com/news/",
]

KEYWORDS = (
    "参加案内",
    "program",
    "関門",
    "給水",
    "cutoff",
    "runner",
    "handbook",
    "2027",
)

PDF_RE = re.compile(r'https?://[^\s"\'<>]+\.pdf|/[^\s"\'<>]+\.pdf', re.IGNORECASE)
LINK_RE = re.compile(
    r'<a\s+[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)
TAG_RE = re.compile(r"<[^>]+>")


def fetch_html(url: str, timeout: int = 20) -> tuple[str, str | None]:
    """Fetch HTML text from URL, returning (html, error_message)."""
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Run-Navigator-Kyoto-Watch/1.0 (+https://github.com/ZLO-25/Run-Navigator)"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return raw.decode("utf-8", errors="replace"), None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return "", str(exc)


def extract_hits(base_url: str, html: str) -> dict:
    """Extract PDF links and keyword-matched links from fetched HTML."""
    pdfs = sorted(set(PDF_RE.findall(html)))
    matches: list[dict[str, str]] = []
    seen: set[str] = set()
    for href, body in LINK_RE.findall(html):
        text = " ".join(TAG_RE.sub(" ", body).split())
        combined = f"{href} {text}".lower()
        if any(kw in combined for kw in KEYWORDS):
            key = f"{href}|{text}"
            if key not in seen:
                seen.add(key)
                matches.append({"href": href, "text": text[:120]})
    return {"url": base_url, "pdfs": pdfs[:20], "matches": matches[:25]}


def build_report(offline: bool = False) -> dict:
    """Build structured report comparing Kyoto 2027 official pages to race.json."""
    race = json.loads(RACE_JSON.read_text(encoding="utf-8"))
    pages: list[dict] = []
    errors: list[str] = []
    signals_2027: list[str] = []

    if not offline:
        for url in URLS:
            html, err = fetch_html(url)
            if err:
                errors.append(f"{url}: {err}")
                continue
            info = extract_hits(url, html)
            pages.append(info)
            for pdf in info["pdfs"]:
                if "2027" in pdf or "program" in pdf.lower():
                    signals_2027.append(f"PDF: {pdf}")
            for item in info["matches"]:
                txt = f"{item['text']} ({item['href']})"
                if "2027" in txt and any(
                    k in txt.lower() for k in ("参加案内", "handbook", "guide", "program", "関門", "給水", "水站")
                ):
                    signals_2027.append(txt)

    return {
        "checked_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "target_file": str(RACE_JSON.relative_to(ROOT)).replace("\\", "/"),
        "current_schedule_checked": race.get("schedule", {}).get("checked"),
        "cutoffs_count": len(race.get("cutoffs", [])),
        "water_stations_count": len(race.get("aid", {}).get("stations", [])),
        "pages_checked": len(pages),
        "errors": errors,
        "signals_2027": sorted(set(signals_2027))[:20],
        "has_guide_signal": bool(signals_2027),
        "pages": pages,
    }


def format_markdown(report: dict) -> str:
    """Format report as plain Markdown for GitHub Actions summary or Issues."""
    lines = [
        "## 京都馬拉松 2027 官方指南週檢結果",
        "",
        f"- 目標賽事包：`{report['target_file']}`（目前 `schedule.checked`：`{report['current_schedule_checked']}`）",
        f"- 目前設定：{report['cutoffs_count']} 個關門點、{report['water_stations_count']} 處水站",
        f"- 檢查時間（UTC）：`{report['checked_at_utc']}`",
        "",
    ]
    if report["signals_2027"]:
        lines.append("### 偵測到 2027 指南／相關PDF或關鍵字")
        for s in report["signals_2027"]:
            lines.append(f"- {s}")
        lines.extend(
            [
                "",
                "### 更新步驟（Run-Navigator）",
                "1. 對照官方公告與 `app/src/main/assets/races/kyoto-2027/race.json`（`cutoffs`、`aid`、`time`、`schedule.checked`）。",
                "2. 執行 `python3 tools/build_races.py` 重新產生 `app/src/main/assets/races.js`。",
                "3. 執行 `python3 tools/build_races.py --check` 與 `node tools/selftest.js`，確認通過後發佈 PR 重編 APK。",
            ]
        )
    else:
        lines.append("本次未偵測到新的 2027 官方參加案內 PDF／關門變動關鍵字。")
    if report["errors"]:
        lines.append("")
        lines.append("### 連線錯誤")
        for e in report["errors"]:
            lines.append(f"- {e}")
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--offline", action="store_true", help="Skip HTTP fetch; validate local race.json state.")
    ap.add_argument("--json-out", type=Path, help="Optional path to write JSON report.")
    args = ap.parse_args()

    report = build_report(offline=args.offline)
    md = format_markdown(report)
    print(md)
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
