#!/usr/bin/env python3
"""
One-shot codemod: replace hard-coded colour literals in the frontend with
theme-aware CSS custom properties so the UI can render in both dark and
light bunq themes.  Kept in-repo for auditability of the migration.
"""
import re, pathlib, collections

ROOT = pathlib.Path(__file__).resolve().parent.parent / "packages/frontend/src"

# (file, 1-based line, old, new) — applied first, protects colours that must
# NOT follow the theme (white text sitting on a saturated tile, dark text on a
# bright accent button, SVG masking fills, ...).
LINE_FIXES = [
    ("App.tsx", 283, "'#000'", "'var(--text-on-bright)'"),
    ("App.tsx", 466, "'#000'", "'var(--text-on-bright)'"),
    ("App.tsx", 828, "'#fff'", "'var(--text-on-accent)'"),
    ("App.tsx", 858, "'#fff'", "'var(--text-on-accent)'"),
    ("components/CardsPanel.tsx", 291, "'#fff'", "'var(--text-on-accent)'"),
    ("components/InsightsScreen.tsx", 433, "'#fff'", "'var(--text-on-accent)'"),
    ("components/InsightsScreen.tsx", 622, "'#fff'", "'var(--text-on-accent)'"),
    ("components/InsightsScreen.tsx", 804, "'#fff'", "'var(--text-on-accent)'"),
    ("components/InsightsScreen.tsx", 820, "'#fff'", "'var(--text-on-accent)'"),
    ("components/InterventionCard.tsx", 161, "'#000000'", "'var(--text-on-bright)'"),
    ("components/ForecastChart.tsx", 335, '"#000000"', '"var(--bg-base)"'),
    ("components/ForecastChart.tsx", 345, "'#000'", "'var(--bg-base)'"),
    ("components/ReceiptScanner.tsx", 453, "'#000'", "'var(--bg-base)'"),
]

# plain literal -> token (applied everywhere)
SIMPLE = [
    ("rgba(9,9,9,0.92)",    "var(--bg-header)"),
    ("rgba(9,9,9,0.80)",    "var(--bg-header-alt)"),
    ("rgba(12,12,20,0.92)", "var(--bg-elevated)"),
    ("#0d0d12",             "var(--bg-elevated)"),
    ("#0d0d0d",             "var(--bg-elevated)"),
]

# hex -> token (word-boundary aware, case-insensitive)
HEX = [
    ("#ffffff", "var(--text-primary)"),
    ("#fff",    "var(--text-primary)"),
    ("#000000", "var(--bg-base)"),
    ("#000",    "var(--bg-base)"),
    ("#00bfff", "var(--accent-cyan)"),
    ("#00ff95", "var(--accent-green)"),
    ("#E2E8F0", "var(--text-strong)"),
    ("#CBD5E1", "var(--text-soft)"),
]

WHITE_RE = re.compile(r"rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*([0-9.]+)\s*\)")

def ink_token(alpha: str) -> str:
    a = float(alpha)
    return "var(--ink-%s)" % ("%.3f" % a).split(".")[1].rstrip("0").ljust(3, "0")

def main() -> None:
    counts = collections.Counter()
    alphas = set()

    for path in sorted(ROOT.rglob("*.tsx")):
        rel = str(path.relative_to(ROOT))
        lines = path.read_text().split("\n")

        for f, ln, old, new in LINE_FIXES:
            if f == rel and old in lines[ln - 1]:
                lines[ln - 1] = lines[ln - 1].replace(old, new)
                counts["protected"] += 1

        src = "\n".join(lines)

        for old, new in SIMPLE:
            if old in src:
                counts[old] += src.count(old)
                src = src.replace(old, new)

        def _white(m: "re.Match[str]") -> str:
            alphas.add(m.group(1))
            counts["ink"] += 1
            return ink_token(m.group(1))
        src = WHITE_RE.sub(_white, src)

        for old, new in HEX:
            pat = re.compile(re.escape(old) + r"(?![0-9a-fA-F])", re.I)
            src, n = pat.subn(new, src)
            counts[old] += n

        path.write_text(src)

    print("alphas:", " ".join(sorted(alphas, key=float)))
    for k, v in counts.most_common():
        print(f"{v:5d}  {k}")

if __name__ == "__main__":
    main()
