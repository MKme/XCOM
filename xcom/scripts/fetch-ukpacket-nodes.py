"""Fetch Packet Radio nodes/BBS from nodes.ukpacketradio.network and regenerate
repeaterbook/modules/packet-radio/packet-data.js.

This is intended for maintaining an offline snapshot of *real* nodes and BBS
entries (no placeholders).

Usage:
  python scripts/fetch-ukpacket-nodes.py
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import requests


ROOT = Path(__file__).resolve().parents[1]
OUT_FILE = ROOT / "modules" / "packet-radio" / "packet-data.js"
SOURCE_URL = "https://nodes.ukpacketradio.network/packet-network-map.html?rfonly=0"
DATA_URL = "https://nodes.ukpacketradio.network/api/nodedata/geojson?linkType=RF&linkType=Internet&linkType=Other&linkType=PrivateNet"


@dataclass
class PacketItem:
    id: int
    type: str  # node|bbs
    callsign: str
    name: str
    location: str
    country: str
    lat: float
    lng: float
    freq: str
    baud: str
    # Optional detailed channel list (RF ports). Each entry is:
    #   { freq: '<MHz string>', baud: '<baud string>', raw: '<source snippet>' }
    # Stored in packet-data.js so the UI can display multiple frequencies.
    channels: list[dict[str, str]]
    mode: str
    status: str
    notes: str


def _http_get_text(url: str, timeout_s: int = 45) -> str:
    r = requests.get(
        url,
        timeout=timeout_s,
        headers={
            "User-Agent": "VE3YLO-Offline-Communication-Suite/PacketRadioFetcher",
            "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
        },
    )
    r.raise_for_status()
    return r.text


def _http_get_json(url: str, timeout_s: int = 45) -> Any:
    r = requests.get(
        url,
        timeout=timeout_s,
        headers={
            "User-Agent": "VE3YLO-Offline-Communication-Suite/PacketRadioFetcher",
            "Accept": "application/json,text/plain,*/*",
        },
    )
    r.raise_for_status()
    return r.json()


def _absolutize(base_url: str, maybe_relative: str) -> str:
    if maybe_relative.startswith("http://") or maybe_relative.startswith("https://"):
        return maybe_relative
    if maybe_relative.startswith("//"):
        return "https:" + maybe_relative
    # relative
    return "https://nodes.ukpacketradio.network/" + maybe_relative.lstrip("/")


def _find_data_urls_from_html(html: str) -> list[str]:
    """The map uses a relative fetch() to an API endpoint (not a .json URL).

    We keep this function for resilience, but default to DATA_URL.
    """
    candidates = set(
        re.findall(
            r"api/nodedata/geojson\?[^\"\'\s>]+",
            html,
            flags=re.I,
        )
    )
    urls = [_absolutize(SOURCE_URL, c) for c in candidates]
    # Always include our known-good endpoint.
    urls.append(DATA_URL)
    return sorted(set(urls))


def _extract_points_from_geojson(obj: Any) -> Iterable[dict[str, Any]]:
    if not isinstance(obj, dict):
        return []
    if obj.get("type") == "FeatureCollection":
        for f in obj.get("features") or []:
            if not isinstance(f, dict):
                continue
            geom = f.get("geometry") or {}
            if (geom.get("type") or "").lower() != "point":
                continue
            coords = geom.get("coordinates")
            if not (isinstance(coords, list) and len(coords) >= 2):
                continue
            lng, lat = coords[0], coords[1]
            props = f.get("properties") or {}
            yield {
                "lat": lat,
                "lng": lng,
                "properties": props,
                "feature": f,
            }
    # Some endpoints might just return arrays
    if isinstance(obj.get("data"), list):
        for row in obj["data"]:
            if isinstance(row, dict):
                yield {"properties": row}


def _guess_type(display_text: str) -> str:
    s = (display_text or "").lower()
    # Basic heuristics: mailbox/bbs keywords.
    if "bbs" in s or "mailbox" in s:
        return "bbs"
    return "node"


def _pick(props: dict[str, Any], *keys: str) -> str:
    for k in keys:
        v = props.get(k)
        if v is None:
            continue
        if isinstance(v, (int, float)):
            return str(v)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def _fmt_mhz(v: float) -> str:
    # keep up to 6 decimals, trim trailing zeros
    return f"{v:.6f}".rstrip("0").rstrip(".")


def _to_mhz_str(raw_num: str, unit: str | None) -> str | None:
    """Convert a numeric string (potentially comma decimal) to MHz string."""
    if not raw_num:
        return None
    s = raw_num.strip().replace(",", ".")
    try:
        v = float(s)
    except Exception:
        return None
    u = (unit or "").lower().strip()
    if u == "khz":
        v = v / 1000.0
    # For bare numbers, assume MHz.
    if not (0.5 <= v <= 500.0):
        return None
    return _fmt_mhz(v)


def _extract_channels(display_text: str) -> list[dict[str, str]]:
    """Extract frequency/baud pairs from a node's displayText.

    Returns a list like:
      [{"freq": "144.95", "baud": "1200", "raw": "..."}, ...]

    We try to be conservative (avoid software versions like LINBPQ 6.0.25.16).
    """
    raw = display_text or ""
    s = _strip_html(raw)
    s_l = s.lower()

    # Split into chunks by "port" and common separators. This lets us bind a
    # baud token to a nearby frequency token.
    chunks = re.split(r"\bport\b|\s-\s|\|", s_l)

    channels: list[dict[str, str]] = []

    # Helpers to pull a baud from a chunk.
    def _baud_in(chunk: str) -> str:
        m = re.search(r"\b(\d{2,5})\s*(?:baud|bd|bps|b/s)\b", chunk, flags=re.I)
        if m:
            return m.group(1)
        mk = re.search(r"\b(\d{1,2})k(\d)\b", chunk, flags=re.I)
        if mk:
            return str(int(mk.group(1)) * 1000 + int(mk.group(2)) * 100)
        return ""

    # Try explicit MHz/kHz in each chunk.
    for ch in chunks:
        baud = _baud_in(ch)
        # 7052.75kHz / 7.0516MHz
        for m in re.finditer(r"\b(\d{1,5}[\.,]\d{1,6})\s*(mhz|khz)\b", ch, flags=re.I):
            mhz = _to_mhz_str(m.group(1), m.group(2))
            if not mhz:
                continue
            channels.append({"freq": mhz, "baud": baud, "raw": m.group(0)})

        # Also allow bare MHz-like numbers *when RF context exists in this chunk*.
        if re.search(r"\b(?:afsk|fsk|bpsk|qpsk|il2p|fx25|ax25|aprs|vara|ardop|fm|usb|lsb|vhf|uhf|hf)\b", ch):
            for m in re.finditer(r"\b(\d{1,3}[\.,]\d{1,6})\b", ch):
                # Skip if this looks like part of a dotted software version.
                before = ch[max(0, m.start() - 1) : m.start()]
                after = ch[m.end() : min(len(ch), m.end() + 1)]
                if before == "." or after == ".":
                    continue
                mhz = _to_mhz_str(m.group(1), None)
                if not mhz:
                    continue
                channels.append({"freq": mhz, "baud": baud, "raw": m.group(1)})

    # De-dupe while preserving order.
    seen: set[tuple[str, str]] = set()
    uniq: list[dict[str, str]] = []
    for c in channels:
        key = (c.get("freq", ""), c.get("baud", ""))
        if key in seen:
            continue
        seen.add(key)
        uniq.append(c)

    return uniq


def _parse_freq_baud(display_text: str) -> tuple[str, str, list[dict[str, str]]]:
    """Extract channels, and also provide a best-effort primary freq/baud."""
    channels = _extract_channels(display_text)
    # Pick first channel with a frequency; prefer one that also has baud.
    primary = None
    for c in channels:
        if c.get("freq") and c.get("baud"):
            primary = c
            break
    if not primary:
        primary = next((c for c in channels if c.get("freq")), None)
    return (
        (primary.get("freq") if primary else ""),
        (primary.get("baud") if primary else ""),
        channels,
    )


def _as_float(v: Any) -> float | None:
    try:
        f = float(v)
        if f != f:  # NaN
            return None
        return f
    except Exception:
        return None


def _strip_html(html: str) -> str:
    if not html:
        return ""
    # remove tags
    s = re.sub(r"<[^>]+>", " ", html)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _build_items(points: Iterable[dict[str, Any]]) -> list[PacketItem]:
    items: list[PacketItem] = []
    next_id = 1
    for p in points:
        props = p.get("properties") or {}
        feature = p.get("feature") or {}
        lat = _as_float(p.get("lat") or props.get("lat") or props.get("latitude"))
        lng = _as_float(p.get("lng") or props.get("lng") or props.get("lon") or props.get("longitude"))
        if lat is None or lng is None:
            continue

        callsign = _pick(props, "title") or _pick(feature, "node", "callsign")
        # Filter out anything without a plausible callsign.
        if not re.search(r"[A-Z0-9]{3,}", callsign.upper()):
            continue

        display_text = feature.get("displayText") or feature.get("display") or ""
        typ = _guess_type(display_text)
        freq, baud, channels = _parse_freq_baud(display_text)

        # There is no explicit location string in the GeoJSON; keep it blank for now.
        location = ""
        country = ""
        title = callsign.strip()
        notes = _strip_html(display_text)
        status = "online" if "age:" in (display_text or "").lower() else "unknown"

        items.append(
            PacketItem(
                id=next_id,
                type=typ,
                callsign=callsign.strip(),
                name=title or callsign.strip(),
                location=location,
                country=country,
                lat=float(lat),
                lng=float(lng),
                freq=freq,
                baud=baud,
                channels=channels,
                mode="AX.25",
                status=status,
                notes=notes,
            )
        )
        next_id += 1

    # de-dupe by callsign+lat+lng
    seen = set()
    uniq: list[PacketItem] = []
    for it in items:
        key = (it.callsign.upper(), round(it.lat, 5), round(it.lng, 5), it.type)
        if key in seen:
            continue
        seen.add(key)
        uniq.append(it)
    return uniq


def _js_escape(s: str) -> str:
    return (
        s.replace("\\", "\\\\")
        .replace("`", "\\`")
        .replace("${", "\\${")
    )


def _write_packet_data_js(items: list[PacketItem]) -> None:
    now = time.strftime("%Y-%m-%d")
    lines: list[str] = []
    lines.append("// Packet Radio dataset (nodes + BBS) and helpers")
    lines.append(f"// Source: {SOURCE_URL}")
    lines.append(f"// Snapshot date: {now}")
    lines.append("// NOTE: This file is generated by scripts/fetch-ukpacket-nodes.py")
    lines.append("")
    lines.append("// Type values: 'node' | 'bbs'")
    lines.append("const packetNodeData = [")
    for it in items:
        lines.append("  {")
        lines.append(f"    id: {it.id},")
        lines.append(f"    type: '{_js_escape(it.type)}',")
        lines.append(f"    callsign: '{_js_escape(it.callsign)}',")
        lines.append(f"    name: '{_js_escape(it.name)}',")
        lines.append(f"    location: '{_js_escape(it.location)}',")
        lines.append(f"    country: '{_js_escape(it.country)}',")
        lines.append(f"    lat: {it.lat},")
        lines.append(f"    lng: {it.lng},")
        lines.append(f"    freq: '{_js_escape(it.freq)}',")
        lines.append(f"    baud: '{_js_escape(it.baud)}',")
        # New: channels[] for multi-frequency nodes
        if it.channels:
            lines.append("    channels: [")
            for ch in it.channels:
                cfreq = _js_escape(ch.get("freq", ""))
                cbaud = _js_escape(ch.get("baud", ""))
                craw = _js_escape(ch.get("raw", ""))
                lines.append(f"      {{ freq: '{cfreq}', baud: '{cbaud}', raw: '{craw}' }},")
            lines.append("    ],")
        else:
            lines.append("    channels: [],")
        lines.append(f"    mode: '{_js_escape(it.mode)}',")
        lines.append(f"    status: '{_js_escape(it.status)}',")
        lines.append(f"    notes: '{_js_escape(it.notes)}'")
        lines.append("  },")
    lines.append("];\n")

    # Keep the manually-curated frequency table below (does not need regeneration)
    # If OUT_FILE already contains it, preserve it.
    existing = OUT_FILE.read_text(encoding="utf-8") if OUT_FILE.exists() else ""
    m = re.search(r"const packetCommonFrequencies = \[.*?\];\n\nfunction normalizePacketItem\(", existing, flags=re.S)
    if m:
        tail = existing[m.start():]
        lines.append(tail)
    else:
        # Fallback: include a minimal common frequency table and helpers
        lines.append("// Common packet-related frequencies (starter set; always verify local bandplan)")
        lines.append("const packetCommonFrequencies = [")
        lines.append("  { band: '2m', usage: 'Packet (general / node)', freq: '145.010', notes: 'Very common in many regions; confirm your local plan.' },")
        lines.append("  { band: '2m', usage: 'Packet (alternate)', freq: '145.030', notes: 'Alternate packet frequency in some areas.' },")
        lines.append("  { band: '2m', usage: 'BBS / mailbox (example)', freq: '145.050', notes: 'Often region-specific; confirm locally.' },")
        lines.append("  { band: '2m', usage: 'APRS', freq: '144.390', notes: 'North America APRS. (144.800 in much of the rest of the world.)' },")
        lines.append("  { band: '70cm', usage: 'Packet (general / node)', freq: '445.925', notes: 'Common 70cm packet channel in some plans.' },")
        lines.append("  { band: 'HF', usage: 'Winlink (example)', freq: 'varies', notes: 'Winlink uses multiple HF/VHF channels; see local channel lists.' }")
        lines.append("];\n")
        lines.append("function normalizePacketItem(raw) { return raw; }")
        lines.append("function validatePacketItem(item) { return { ok: true }; }")
        lines.append("function getPacketNodesInRadius(centerLat, centerLng, radiusKm, nodes = packetNodeData) { return nodes; }")

    OUT_FILE.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    html = _http_get_text(SOURCE_URL)
    urls = _find_data_urls_from_html(html)
    if not urls:
        raise SystemExit("Could not find any JSON/GEOJSON endpoints in the map HTML")

    # Try each candidate endpoint until we find one that looks like node/BBS points.
    all_points: list[dict[str, Any]] = []
    for u in urls:
        try:
            obj = _http_get_json(u)
        except Exception:
            continue
        pts = list(_extract_points_from_geojson(obj))
        if len(pts) < 10:
            # likely not the right dataset
            continue
        all_points = pts
        print(f"Using dataset: {u} (points={len(pts)})")
        break

    if not all_points:
        raise SystemExit(
            "Found JSON/GEOJSON references but none yielded enough point features. "
            "The site may have changed its data format."
        )

    items = _build_items(all_points)
    if len(items) < 10:
        raise SystemExit(f"Parsed too few items ({len(items)}). Refusing to overwrite dataset.")

    # Ensure we ONLY output real nodes: no placeholder callsigns
    bad = [i for i in items if i.callsign.upper() in {"VE3BBS", "W1NODE", "VE3YLO-7"}]
    if bad:
        print("Warning: dataset includes entries matching old placeholders; they will be kept only if they exist in source.")

    _write_packet_data_js(items)
    print(f"Wrote {len(items)} items to {OUT_FILE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
