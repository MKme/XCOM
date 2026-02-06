"""Discover the data endpoint used by https://nodes.ukpacketradio.network packet map.

This avoids brittle shell one-liners by:
 - fetching the map HTML
 - enumerating referenced JS assets
 - scanning those assets for fetch/XHR URLs
 - writing a report to scripts/ukpacket-endpoint-report.txt

Usage:
  python scripts/discover-ukpacket-data-endpoint.py
"""

from __future__ import annotations

import re
from pathlib import Path

import requests


ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "scripts" / "ukpacket-endpoint-report.txt"
BASE = "https://nodes.ukpacketradio.network/"
MAP_URL = BASE + "packet-network-map.html?rfonly=0"


def get_text(url: str) -> str:
    r = requests.get(
        url,
        timeout=45,
        headers={
            "User-Agent": "VE3YLO-Offline-Communication-Suite/PacketRadioEndpointDiscovery",
            "Accept": "text/html,*/*;q=0.8",
        },
    )
    r.raise_for_status()
    return r.text


def absolutize(url: str) -> str:
    if url.startswith("http://") or url.startswith("https://"):
        return url
    if url.startswith("//"):
        return "https:" + url
    return BASE + url.lstrip("/")


def main() -> int:
    html = get_text(MAP_URL)
    scripts = sorted(
        {
            absolutize(m.group(1))
            for m in re.finditer(r"<script[^>]+src=\"([^\"]+)\"", html, flags=re.I)
        }
    )

    # Very common patterns for endpoints
    endpoint_re = re.compile(
        r"(?:fetch\(|XMLHttpRequest\(|open\(|axios\.|\$\.get\(|\$\.getJSON\(|\$\.ajax\(|getJSON\()\s*[\(\{\s]*[\"\']([^\"\']+)",
        flags=re.I,
    )

    # Also capture literal URLs
    url_re = re.compile(r"(?:https?:)?//[^\"\'\s>]+", flags=re.I)

    endpoints = set()
    all_urls = set()

    for s in scripts:
        try:
            js = get_text(s)
        except Exception:
            continue
        for m in endpoint_re.finditer(js):
            endpoints.add(absolutize(m.group(1)))
        for m in url_re.finditer(js):
            all_urls.add(absolutize(m.group(0)))

    # Also scan HTML for endpoints
    for m in endpoint_re.finditer(html):
        endpoints.add(absolutize(m.group(1)))
    for m in url_re.finditer(html):
        all_urls.add(absolutize(m.group(0)))

    endpoints = {u for u in endpoints if "nodes.ukpacketradio.network" in u}
    all_urls = {u for u in all_urls if "nodes.ukpacketradio.network" in u}

    lines = []
    lines.append(f"Map: {MAP_URL}")
    lines.append("")
    lines.append("Scripts:")
    lines.extend(["  " + s for s in scripts])
    lines.append("")
    lines.append("Candidate endpoints (from fetch/xhr patterns):")
    lines.extend(["  " + u for u in sorted(endpoints)])
    lines.append("")
    lines.append("All URLs found in HTML/JS (first 300):")
    for u in sorted(all_urls)[:300]:
        lines.append("  " + u)

    REPORT.write_text("\n".join(lines), encoding="utf-8")
    print(f"Wrote report: {REPORT}")
    print(f"Scripts found: {len(scripts)}; endpoints: {len(endpoints)}; urls: {len(all_urls)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

