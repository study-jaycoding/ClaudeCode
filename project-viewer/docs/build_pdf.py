"""USAGE.md + 스크린샷 → HTML → (Chrome headless) → PDF.

실행: python build_pdf.py
산출물: docs/USAGE.html, docs/USAGE.pdf
"""

import re
import subprocess
import sys
from pathlib import Path

import markdown

ROOT = Path(__file__).resolve().parent.parent  # project-viewer/
DOCS = ROOT / "docs"
DOCS.mkdir(exist_ok=True)
(DOCS / "screenshots").mkdir(exist_ok=True)

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"


def build_html() -> Path:
    md = (ROOT / "USAGE.md").read_text(encoding="utf-8")

    # 스크린샷 삽입 — "## 1. 화면 한눈에 보기" 섹션 위에 메인 화면 이미지
    md = md.replace(
        "## 1. 화면 한눈에 보기",
        '## 1. 화면 한눈에 보기\n\n'
        '![Project Viewer 메인 화면](screenshots/main.png)\n\n'
        '*전체 화면 구성 — 상단 헤더(프로젝트 선택), 좌측 사이드바(3개 탭), 우측 그리드, 하단 Spotlight 패널*\n'
    )

    body = markdown.markdown(md, extensions=["tables", "fenced_code"])

    html = f"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>Project Viewer 사용법</title>
<style>
  @page {{ size: A4; margin: 20mm 18mm; }}
  body {{
    font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif;
    line-height: 1.7;
    color: #1f2533;
    max-width: 100%;
    margin: 0;
  }}
  h1 {{
    color: #1a1f2e;
    border-bottom: 3px solid #2196f3;
    padding-bottom: 8px;
    margin-top: 0;
  }}
  h2 {{
    color: #1a1f2e;
    border-bottom: 1px solid #d0d4de;
    padding-bottom: 4px;
    margin-top: 28px;
    page-break-after: avoid;
  }}
  h3 {{ color: #2a3144; margin-top: 18px; page-break-after: avoid; }}
  p, li {{ font-size: 11pt; }}
  code {{
    background: #f0f2f7;
    padding: 1px 5px;
    border-radius: 3px;
    font-family: 'Consolas', 'Courier New', monospace;
    font-size: 10pt;
  }}
  pre {{
    background: #f0f2f7;
    padding: 10px 14px;
    border-radius: 5px;
    overflow-x: hidden;
    white-space: pre-wrap;
    word-wrap: break-word;
    font-family: 'Consolas', 'Courier New', monospace;
    font-size: 9.5pt;
    line-height: 1.5;
    page-break-inside: avoid;
  }}
  pre code {{ background: transparent; padding: 0; font-size: inherit; }}
  table {{
    border-collapse: collapse;
    margin: 10px 0;
    width: 100%;
    font-size: 10pt;
    page-break-inside: avoid;
  }}
  th, td {{
    border: 1px solid #c7cad3;
    padding: 5px 9px;
    text-align: left;
    vertical-align: top;
  }}
  th {{ background: #e9ecf3; font-weight: 600; }}
  tr:nth-child(even) td {{ background: #fafbfd; }}
  img {{
    max-width: 100%;
    border: 1px solid #c7cad3;
    border-radius: 5px;
    margin: 14px 0;
    display: block;
    page-break-inside: avoid;
  }}
  blockquote {{
    border-left: 4px solid #2196f3;
    background: #f0f6fc;
    padding: 8px 14px;
    color: #2a3144;
    margin: 12px 0;
    page-break-inside: avoid;
  }}
  blockquote p {{ margin: 0; }}
  hr {{ border: none; border-top: 1px solid #d0d4de; margin: 26px 0; }}
  em {{ color: #555; font-size: 10pt; }}
  ul, ol {{ padding-left: 22px; }}
  li {{ margin: 3px 0; }}
  a {{ color: #2196f3; text-decoration: none; }}
  a:hover {{ text-decoration: underline; }}
  /* 키 단축키 표 안 키 강조 */
  td code {{ background: #2a3144; color: #fff; padding: 1px 6px; }}
</style>
</head>
<body>
{body}
</body>
</html>"""

    out = DOCS / "USAGE.html"
    out.write_text(html, encoding="utf-8")
    print(f"[OK] HTML: {out}")
    return out


def build_pdf(html_path: Path) -> Path:
    out = DOCS / "USAGE.pdf"
    file_url = html_path.resolve().as_uri()
    cmd = [
        CHROME,
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        "--no-pdf-header-footer",
        f"--print-to-pdf={out}",
        file_url,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        print("STDERR:", result.stderr[-500:])
        sys.exit(1)
    print(f"[OK] PDF:  {out} ({out.stat().st_size // 1024} KB)")
    return out


if __name__ == "__main__":
    html_path = build_html()
    build_pdf(html_path)
