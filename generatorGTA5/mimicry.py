#!/usr/bin/env python3
"""Mimicry Generator — AmneziaWG × GTA V (CLI).

Генерирует параметры обфускации AmneziaWG (Jc/Jmin/Jmax, S1–S4, H1–H4,
I1–I5 и поля AWG 3.x) так, чтобы профиль начальных UDP-пакетов был похож на
GTA V multiplayer: FiveM (Quake-3 OOB + ENet, UDP 30120; сверено с исходниками citizenfx/fivem) или на размеры
датаграмм GTA Online (закрытый зашифрованный UDP, порт 6672).

Алгоритм совпадает с web-версией (index.html + app.js): при одинаковом
seed и настройках параметры совпадают, кроме HeaderProtectionKey — он
всегда создаётся криптографически случайным.
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import secrets
import sys
from typing import Any

OOB = "ffffffff"  # connectionless prefix: FiveM writes the int -1 (see NetLibrary::SendOutOfBand)
FIVEM_ENET_MTU = 1300  # g_maxMtu in NetLibraryImplV2.cpp: the client's ENet host MTU
MSG_END = 0xCA569E63  # HashRageString("msgEnd"): keepalive sent every 100 ms on channel 1

PROFILES: dict[str, dict[str, Any]] = {
    "fivem": {
        "label": "GTA V · FiveM (ENet / Q3 OOB)",
        "short": "FiveM / ENet",
        "transport": "UDP",
        "default_port": 30120,
    },
    "gtao": {
        "label": "GTA Online (opaque UDP)",
        "short": "GTA Online / opaque",
        "transport": "UDP",
        "default_port": 6672,
    },
}

MODE_LABELS = {"balanced": "Balanced", "stealth": "Stealth", "fast": "Fast"}

MODES: dict[str, dict[str, Any]] = {
    "fast": {
        "jc": [2, 4],
        "jmin": [32, 64],
        "jmax": [160, 400],
        "padding": "12-64",
        "timings": {
            "rekey_after": "120",
            "rekey_timeout": "5",
            "reject_after": "180",
            "keepalive_timeout": "10",
            "max_attempts": "8",
            "keepalive": "25",
        },
    },
    "balanced": {
        "jc": [4, 7],
        "jmin": [48, 96],
        "jmax": [300, 800],
        "padding": "16-128",
        "timings": {
            "rekey_after": "120-150",
            "rekey_timeout": "5-8",
            "reject_after": "190-240",
            "keepalive_timeout": "10-20",
            "max_attempts": "8-12",
            "keepalive": "20-30",
        },
    },
    "stealth": {
        "jc": [7, 12],
        "jmin": [64, 128],
        "jmax": [700, 1200],
        "padding": "32-256",
        "timings": {
            "rekey_after": "140-180",
            "rekey_timeout": "6-10",
            "reject_after": "220-280",
            "keepalive_timeout": "12-25",
            "max_attempts": "10-16",
            "keepalive": "20-30",
        },
    },
}

I_META: dict[str, list[tuple[str, str]]] = {
    "fivem": [
        ("i1", "OOB getinfo xyz · FF FF FF FF"),
        ("i2", "ENet CONNECT · 0x82 · MTU 1300"),
        ("i3", "ENet SEND_RELIABLE · ch 0 · token/guid"),
        ("i4", "ENet SEND_UNSEQUENCED · ch 1 · msgEnd"),
        ("i5", "ENet SEND_UNRELIABLE · ch 1 · msgRoute"),
    ],
    "gtao": [
        ("i1", "Opaque datagram · small"),
        ("i2", "Opaque datagram · medium"),
        ("i3", "Opaque datagram · large"),
        ("i4", "Opaque datagram · game-sized"),
        ("i5", "Opaque datagram · game-sized"),
    ],
}


# ---------------------------------------------------------------------------
# PRNG. This mirrors the JavaScript implementation (xmur3 + mulberry32) so the
# same seed and options produce the same values in the web app and in the CLI.
# ---------------------------------------------------------------------------

def _u32(value: int) -> int:
    return value & 0xFFFFFFFF


def _imul32(a: int, b: int) -> int:
    return _u32(a * b)


def xmur3(text: str):
    # JavaScript iterates UTF-16 code units; mirror that so the same seed
    # produces the same sequence in app.js and in this CLI (including emoji).
    raw = text.encode("utf-16-le", errors="surrogatepass")
    units = [raw[i] | (raw[i + 1] << 8) for i in range(0, len(raw), 2)]
    h = 1779033703 ^ len(units)
    for unit in units:
        h = _imul32(h ^ unit, 3432918353)
        h = _u32((h << 13) | (h >> 19))

    def next_rand() -> int:
        nonlocal h
        h = _imul32(h ^ (h >> 16), 2246822507)
        h = _imul32(h ^ (h >> 13), 3266489909)
        h ^= h >> 16
        return _u32(h)

    return next_rand


def mulberry32(seed: int):
    a = seed & 0xFFFFFFFF

    def next_rand() -> float:
        nonlocal a
        a = _u32(a + 0x6D2B79F5)
        t = _imul32(a ^ (a >> 15), 1 | a)
        t = _u32(_u32(t + _imul32(t ^ (t >> 7), 61 | t)) ^ t)
        t = _u32(t ^ (t >> 14))
        return t / 4294967296.0

    return next_rand


def make_rng(seed: str):
    return mulberry32(xmur3(seed)())


def rand_int(rng, low: int, high: int) -> int:
    if high < low:
        low, high = high, low
    return low + int(rng() * (high - low + 1))


def random_bytes_from_rng(rng, size: int) -> bytes:
    return bytes(int(rng() * 256) & 0xFF for _ in range(size))


def pick_distinct(rng, low: int, high: int, count: int) -> list[int]:
    """Pick `count` distinct integers without replacement, using the shared PRNG."""
    pool = list(range(low, high + 1))
    out: list[int] = []
    for _ in range(count):
        out.append(pool.pop(rand_int(rng, 0, len(pool) - 1)))
    return out


# ---------------------------------------------------------------------------
# Encoding helpers
# ---------------------------------------------------------------------------

def bytes_to_hex(data: bytes) -> str:
    return data.hex()


def u16be(value: int) -> str:
    return f"{(value >> 8) & 0xFF:02x}{value & 0xFF:02x}"


def u32be(value: int) -> str:
    value &= 0xFFFFFFFF
    return f"{(value >> 24) & 0xFF:02x}{(value >> 16) & 0xFF:02x}{(value >> 8) & 0xFF:02x}{value & 0xFF:02x}"


def ascii_hex(text: str) -> str:
    return text.encode("ascii").hex()


def u16le(value: int) -> str:
    value &= 0xFFFF
    return f"{value & 0xFF:02x}{(value >> 8) & 0xFF:02x}"


def u32le(value: int) -> str:
    value &= 0xFFFFFFFF
    return "".join(f"{(value >> shift) & 0xFF:02x}" for shift in (0, 8, 16, 24))


def joaat(text: str) -> int:
    """Jenkins one-at-a-time, case-sensitive. joaat("msgEnd") == 0xCA569E63,
    the msgEnd constant hard-coded in FiveM's NetLibraryImplV2.cpp."""
    h = 0
    for byte in text.encode("utf-8"):
        h = (h + byte) & 0xFFFFFFFF
        h = (h + (h << 10)) & 0xFFFFFFFF
        h ^= h >> 6
    h = (h + (h << 3)) & 0xFFFFFFFF
    h ^= h >> 11
    h = (h + (h << 15)) & 0xFFFFFFFF
    return h


_JS_TRIM_CHARS = (
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680"
    + "".join(chr(codepoint) for codepoint in range(0x2000, 0x200B))
    + "\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def js_trim(value: str) -> str:
    """Match ECMAScript String.trim() for input shared with the web UI."""
    return str(value).strip(_JS_TRIM_CHARS)


def is_ipv4(text: str) -> bool:
    # [0-9] instead of str.isdigit(): the latter accepts Unicode digits and
    # would diverge from the JavaScript \d regex used by the web version.
    parts = js_trim(text).split(".")
    if len(parts) != 4:
        return False
    for part in parts:
        if not re.fullmatch(r"[0-9]{1,3}", part) or (len(part) > 1 and part.startswith("0")):
            return False
        if int(part) > 255:
            return False
    return True


def is_test_net_ipv4(text: str) -> bool:
    """Return whether an IPv4 literal belongs to an RFC 5737 documentation block."""
    if not is_ipv4(text):
        return False
    octets = [int(part) for part in js_trim(text).split(".")]
    return (
        (octets[0] == 192 and octets[1] == 0 and octets[2] == 2)
        or (octets[0] == 198 and octets[1] == 51 and octets[2] == 100)
        or (octets[0] == 203 and octets[1] == 0 and octets[2] == 113)
    )


def normalize_header_key(value: str) -> str:
    """Accept a 32-byte HeaderProtectionKey as base64 or hex and return base64.

    awg-quick/awg-manager store keys in base64, while amneziawg-go UAPI uses
    hex internally. The CLI accepts either so copy-paste from either source
    works, but the generated .conf/JSON always contains base64.
    """
    text = value.strip()
    if len(text) == 64 and re.fullmatch(r"[0-9a-fA-F]{64}", text):
        return base64.b64encode(bytes.fromhex(text)).decode("ascii")
    try:
        raw = base64.b64decode(text, validate=True)
    except Exception as exc:  # noqa: BLE001 - normalize all decoding errors
        raise ValueError(
            "HeaderProtectionKey должен быть 32-байтным ключом в base64 или hex"
        ) from exc
    if len(raw) != 32:
        raise ValueError("HeaderProtectionKey должен быть 32-байтным ключом в base64 или hex")
    return base64.b64encode(raw).decode("ascii")


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------

def generate(
    profile: str,
    awg_version: int,
    mode: str,
    mtu: int,
    ip: str,
    port: int,
    seed: str,
    header_key: str | None = None,
) -> dict[str, Any]:
    # The web UI trims these inputs; mirror that so the PRNG seed matches.
    seed = js_trim(seed)
    ip = js_trim(ip)
    mode_cfg = MODES.get(mode, MODES["balanced"])
    rng = make_rng(f"{seed}|{profile}|{awg_version}|{mode}|{mtu}|{ip}|{port}")

    warnings: list[str] = []
    safe_ip = ip if is_ipv4(ip) else "192.0.2.1"
    if safe_ip != ip:
        warnings.append(f"IPv4 «{ip}» некорректен — для JSON используется 192.0.2.1.")
    if is_test_net_ipv4(safe_ip):
        warnings.append(
            f"{safe_ip} — адрес из TEST-NET, зарезервированный для документации, а не публичный адрес сервера. "
            "Замените его перед импортом JSON и подключением."
        )

    params: dict[str, Any] = {}

    # Junk train.
    jmax_hi = max(96, min(mode_cfg["jmax"][1], mtu - 40))
    jmax_lo = max(64, min(mode_cfg["jmax"][0], jmax_hi - 32))
    jmin_hi = max(32, min(mode_cfg["jmin"][1], jmax_lo - 32))
    jmin_lo = min(mode_cfg["jmin"][0], jmin_hi)
    params["jc"] = rand_int(rng, *mode_cfg["jc"])
    params["jmin"] = rand_int(rng, jmin_lo, jmin_hi)
    jmax_floor = min(jmax_hi, max(jmax_lo, params["jmin"] + 32))
    params["jmax"] = rand_int(rng, jmax_floor, jmax_hi)

    # Padding.
    s = make_s(rng, awg_version, mode, mtu)
    params.update(s)

    # Headers.
    if awg_version >= 3:
        params.update({"h1": "1", "h2": "2", "h3": "3", "h4": "4"})
    elif profile == "fivem":
        # Heuristic decoys taken from ENet command bytes that FiveM really uses:
        # CONNECT (0x82), VERIFY_CONNECT (0x83), SEND_UNSEQUENCED (0x49) and
        # the acknowledged data commands from 0x86. They are not parsed as
        # ENet by anyone: AWG only uses them as 32-bit message-type values.
        params.update({"h1": "130", "h2": "131", "h3": "73", "h4": "134-137"})
    else:
        # GTA Online is opaque; these are just distinct values >= 5.
        params.update({"h1": "200", "h2": "201", "h3": "202", "h4": "203-210"})

    # CPS signatures.
    if profile == "gtao":
        packets = gtao_packets(rng, mode, mtu)
    else:
        # Keep the challenge token and the ENet connectID stable without
        # consuming bytes from the RNG used for the packet-size profile.
        identity_rng = make_rng(
            f"{seed}|{profile}|{awg_version}|{mode}|{mtu}|{safe_ip}|{port}|gta-identity"
        )
        packets = fivem_packets(rng, mode, mtu, identity_rng)
    params.update(packets)

    # AWG 3.x extras.
    if awg_version >= 3:
        timings = mode_cfg["timings"]
        if header_key:
            key = normalize_header_key(header_key)
        else:
            key = base64.b64encode(secrets.token_bytes(32)).decode("ascii")
        params.update(
            {
                "header_protection_key": key,
                "content_padding_addition": mode_cfg["padding"],
                "random_trailers": "off" if mode == "fast" else "on",
                "disable_cookies": "on",
                "rekey_after_time": timings["rekey_after"],
                "rekey_timeout": timings["rekey_timeout"],
                "reject_after_time": timings["reject_after"],
                "keepalive_timeout": timings["keepalive_timeout"],
                "max_handshake_attempts": timings["max_attempts"],
                "keepalive": timings["keepalive"],
            }
        )
    else:
        params["keepalive"] = "25"

    ipkts = [
        {
            "key": key.upper(),
            "desc": desc,
            "cps": params[key],
            "size": cps_size(params[key]),
        }
        for key, desc in I_META[profile]
    ]

    result: dict[str, Any] = {
        "opts": {
            "seed": seed,
            "profile": profile,
            "version": awg_version,
            "mode": mode,
            "mtu": mtu,
            "ip": safe_ip,
            "port": port,
        },
        "params": params,
        "sizes": {
            "init": 148 + params["s1"],
            "response": 92 + params["s2"],
            "cookie": 64 + params["s3"],
            "s4": params["s4"],
        },
        "ipkts": ipkts,
        "warnings": [],
    }
    result["checks"] = build_checks(result)
    result["warnings"] = build_warnings(result, warnings)
    return result


def make_s(rng, awg_version: int, mode: str, mtu: int) -> dict[str, int]:
    if awg_version >= 3:
        if mode == "fast":
            # RandomTrailers is off here, so there is no need for equal
            # values.  Distinct S1-S4 remove the constant WireGuard-shaped
            # delta (148+S1) - (92+S2) = 56 bytes between Init and Response.
            s1, s2, s3, s4 = pick_distinct(rng, 12, 20, 4)
            return {"s1": s1, "s2": s2, "s3": s3, "s4": s4}

        # RandomTrailers is on.  Its receive path relaxes the length check to
        # ">= expected", so upstream requires S1=S2=S3=S4 or random trailers
        # make packet-type detection unreliable.  Header Protection itself
        # only requires S1-S4 >= 12; equality is a RandomTrailers requirement.
        if mode == "stealth":
            low, high = 24, 32
        else:
            low, high = 16, 28
        base = rand_int(rng, low, high)
        return {"s1": base, "s2": base, "s3": base, "s4": base}

    if mode == "fast":
        s1 = rand_int(rng, 16, 40)
        s2 = rand_int(rng, 16, 40)
        s3 = rand_int(rng, 8, 20)
        s4 = rand_int(rng, 0, 12)
    elif mode == "stealth":
        s1 = rand_int(rng, 72, 140)
        s2 = rand_int(rng, 72, 140)
        s3 = rand_int(rng, 24, 64)
        s4 = rand_int(rng, 20, 32)
    else:
        s1 = rand_int(rng, 40, 88)
        s2 = rand_int(rng, 40, 88)
        s3 = rand_int(rng, 16, 44)
        s4 = rand_int(rng, 8, 24)

    if s2 == s1 + 56:
        s2 = s2 + 1 if s2 < 1188 else s2 - 1

    return {
        "s1": min(s1, 1132),
        "s2": min(s2, 1188),
        "s3": min(s3, 1216),
        "s4": min(s4, 32),
    }


def _payload_cap(mtu: int) -> int:
    # UDP payload limit is MTU - 28; the largest FiveM template carries
    # 20 bytes of ENet + msgRoute headers around the random payload.
    return max(48, mtu - 48)


def fivem_packets(rng, mode: str, mtu: int, identity_rng) -> dict[str, str]:
    """What a FiveM client puts on the wire, in the order its code does it.

    Mirrors citizenfx/fivem: NetLibrary.cpp sends the connectionless
    "getinfo xyz" (int -1 + text); NetLibraryImplV2.cpp then calls
    enet_host_connect(host, addr, 2 channels, HashString(token)) on a host
    with MTU 1300 and no bandwidth limits, and on connect sends a reliable
    packet on channel 0: int 1 + "token=<uuid>&guid=<uint64>". Channel 1
    carries msgRoute (unreliable) and the msgEnd keepalive (unsequenced).
    ENet headers are public and big-endian; FiveM's own fields are
    little-endian. The msgRoute payload is random bytes.
    """
    raw_token = bytearray(random_bytes_from_rng(identity_rng, 16))
    raw_token[6] = (raw_token[6] & 0x0F) | 0x40  # random UUID v4, as boost::uuids
    raw_token[8] = (raw_token[8] & 0x3F) | 0x80
    t = raw_token.hex()
    token = f"{t[:8]}-{t[8:12]}-{t[12:16]}-{t[16:20]}-{t[20:]}"
    guid = int.from_bytes(random_bytes_from_rng(identity_rng, 8), "little")
    connect_id = bytes_to_hex(random_bytes_from_rng(identity_rng, 4))

    # 1. Connectionless query: FF FF FF FF + "getinfo xyz".
    i1 = f"<b 0x{OOB}><b 0x{ascii_hex('getinfo xyz')}>"

    # 2. ENet CONNECT. Header: peerID 0x0FFF | SENT_TIME flag, then sentTime.
    sent_connect = rand_int(rng, 0, 0xFFFF)
    connect_body = (
        u16be(0)               # outgoingPeerID: index of the client's only peer
        + "ff" + "ff"          # incoming / outgoing session ID
        + u32be(FIVEM_ENET_MTU)
        + u32be(65536)         # window size: no bandwidth limit
        + u32be(2)             # channel count
        + u32be(0) + u32be(0)  # incoming / outgoing bandwidth
        + u32be(5000)          # packet throttle interval
        + u32be(2) + u32be(2)  # throttle acceleration / deceleration
        + connect_id
        + u32be(joaat(token))  # data = HashString(token)
    )
    i2 = (
        f"<b 0x{u16be(0x8FFF)}><b 0x{u16be(sent_connect)}>"
        f"<b 0x82><b 0xff><b 0x{u16be(1)}><b 0x{connect_body}>"
    )

    # After VERIFY_CONNECT the datagram header carries the server-assigned
    # peerID and a 2-bit session ID.
    peer_header = 0x8000 | (rand_int(rng, 0, 3) << 12) | rand_int(rng, 0, 63)
    st3 = rand_int(rng, 0, 0xFFFF)
    st4 = rand_int(rng, 0, 0xFFFF)
    st5 = rand_int(rng, 0, 0xFFFF)

    # 3. First reliable packet on channel 0 (ENet SEND_RELIABLE|ACK, seq 1).
    payload3 = u32le(1) + ascii_hex(f"token={token}&guid={guid}")
    i3 = (
        f"<b 0x{u16be(peer_header)}><b 0x{u16be(st3)}>"
        f"<b 0x86><b 0x00><b 0x{u16be(1)}><b 0x{u16be(len(payload3) // 2)}>"
        f"<b 0x{payload3}>"
    )

    # 4. msgEnd keepalive: SEND_UNSEQUENCED (0x09|0x40), channel 1, group 1.
    i4 = (
        f"<b 0x{u16be(peer_header)}><b 0x{u16be(st4)}>"
        f"<b 0x49><b 0x01><b 0x{u16be(0)}><b 0x{u16be(1)}><b 0x{u16be(4)}>"
        f"<b 0x{u32le(MSG_END)}>"
    )

    # 5. msgRoute: SEND_UNRELIABLE, channel 1, unreliable seq 1;
    # body = hash(msgRoute) + netID(u16) + size(u16) + payload (random here).
    if mode == "fast":
        base = (64, 160)
    elif mode == "stealth":
        base = (192, 448)
    else:
        base = (128, 288)
    n5 = min(_payload_cap(mtu), rand_int(rng, base[1], base[1] + 128))
    net_id = rand_int(rng, 1, 255)
    i5 = (
        f"<b 0x{u16be(peer_header)}><b 0x{u16be(st5)}>"
        f"<b 0x07><b 0x01><b 0x{u16be(0)}><b 0x{u16be(1)}><b 0x{u16be(8 + n5)}>"
        f"<b 0x{u32le(joaat('msgRoute'))}><b 0x{u16le(net_id)}><b 0x{u16le(n5)}><r {n5}>"
    )
    return {"i1": i1, "i2": i2, "i3": i3, "i4": i4, "i5": i5}


def gtao_packets(rng, mode: str, mtu: int) -> dict[str, str]:
    """GTA Online's wire format is closed and encrypted, so only sizes are shaped."""
    if mode == "fast":
        ranges = [(32, 64), (64, 160), (128, 320), (96, 224), (160, 352)]
    elif mode == "stealth":
        ranges = [(64, 128), (128, 288), (288, 640), (192, 448), (320, 704)]
    else:
        ranges = [(48, 96), (96, 224), (192, 448), (128, 288), (224, 480)]
    cap = _payload_cap(mtu)
    out: dict[str, str] = {}
    for index, (low, high) in enumerate(ranges, start=1):
        out[f"i{index}"] = f"<r {min(cap, rand_int(rng, low, high))}>"
    return out


# ---------------------------------------------------------------------------
# CPS parsing / validation
# ---------------------------------------------------------------------------

CPS_TAG_RE = re.compile(r"<([a-z]+)(?:\s+([^>]*))?>")


def cps_size(spec: str) -> int:
    pos = 0
    total = 0
    while pos < len(spec):
        match = CPS_TAG_RE.match(spec, pos)
        if not match:
            raise ValueError(f"CPS: неизвестный тег в позиции {pos}")
        tag = match.group(1).lower()
        arg = (match.group(2) or "").strip()

        if tag == "t":
            total += 4
        elif tag == "b":
            value = arg[2:] if arg.lower().startswith("0x") else arg
            if not value or len(value) % 2 or not re.fullmatch(r"[0-9a-fA-F]+", value):
                raise ValueError("CPS: некорректный тег <b>")
            total += len(value) // 2
        elif tag in ("r", "rc", "rd"):
            if not arg.isdigit():
                raise ValueError(f"CPS: некорректный размер <{tag}>")
            size = int(arg)
            if size < 0 or size > 1000:
                raise ValueError(f"CPS: некорректный размер <{tag}>")
            total += size
        elif tag == "dz":
            if not arg.isdigit():
                raise ValueError("CPS: некорректный размер <dz>")
            total += int(arg)
        elif tag in ("d", "ds"):
            # Dynamic content: size depends on the source data, which is empty
            # for the packets this generator produces.
            total += 0
        else:
            raise ValueError(f"CPS: неизвестный тег <{tag}>")

        pos = match.end()

    return total


def parse_h_range(value: str) -> tuple[int, int] | None:
    match = re.fullmatch(r"(\d+)(?:-(\d+))?", value.strip())
    if not match:
        return None
    low = int(match.group(1))
    high = int(match.group(2)) if match.group(2) is not None else low
    if low > high:
        return None
    return low, high


def ranges_overlap(a: tuple[int, int], b: tuple[int, int]) -> bool:
    return a[0] <= b[1] and b[0] <= a[1]


def build_checks(result: dict[str, Any]) -> list[dict[str, Any]]:
    params = result["params"]
    opts = result["opts"]
    out: list[dict[str, Any]] = []

    def add(ok: bool, text: str, detail: str = "") -> None:
        out.append({"ok": bool(ok), "text": text, "detail": detail})

    add(1 <= params["jc"] <= 128, "Jc в диапазоне 1–128", f"Jc = {params['jc']}")
    add(
        0 <= params["jmin"] < params["jmax"] and params["jmax"] + 28 <= opts["mtu"],
        "Jmin < Jmax, junk-пакеты влезают в MTU",
        f"{params['jmin']} < {params['jmax']}; {params['jmax']} + 28 <= {opts['mtu']}",
    )

    limits = [("S1", params["s1"], 1132), ("S2", params["s2"], 1188), ("S3", params["s3"], 1216), ("S4", params["s4"], 32)]
    add(
        all(0 <= value <= maximum for _, value, maximum in limits),
        "S1–S4 в допустимых пределах",
        " · ".join(f"{name}={value}<={maximum}" for name, value, maximum in limits),
    )
    add(
        params["s1"] + 56 != params["s2"],
        "S1 + 56 ≠ S2",
        f"{params['s1']} + 56 = {params['s1'] + 56}, S2 = {params['s2']}",
    )
    add(
        params["s3"] != params["s2"] + 28,
        "S3 ≠ S2 + 28",
        f"{params['s2']} + 28 = {params['s2'] + 28}, S3 = {params['s3']}",
    )
    add(
        params["s3"] != params["s1"] + 84,
        "S3 ≠ S1 + 84",
        f"{params['s1']} + 84 = {params['s1'] + 84}, S3 = {params['s3']}",
    )

    h_ranges = [parse_h_range(params[f"h{i}"]) for i in range(1, 5)]
    parsed = all(r is not None for r in h_ranges)
    overlap = False
    if parsed:
        for i in range(4):
            for j in range(i + 1, 4):
                if ranges_overlap(h_ranges[i], h_ranges[j]):
                    overlap = True
    add(
        parsed and not overlap,
        "H1–H4 корректны и не пересекаются",
        " · ".join(
            f"H{i + 1}={r[0] if r[0] == r[1] else f'{r[0]}-{r[1]}'}"
            for i, r in enumerate(h_ranges)
            if r is not None
        ),
    )

    if opts["version"] >= 3:
        s_values = [params[f"s{i}"] for i in range(1, 5)]
        add(
            all(value >= 12 for value in s_values),
            "S1–S4 >= 12 для Header Protection",
            "S1..S4 = " + ", ".join(str(value) for value in s_values),
        )
        if params["random_trailers"] == "on":
            add(
                len(set(s_values)) == 1,
                "S1–S4 совпадают при RandomTrailers = on",
                "разные значения ломают определение типа пакета в receive-path",
            )
        else:
            add(
                len(set(s_values)) == 4,
                "S1–S4 различны при RandomTrailers = off",
                "убирает постоянную разницу Init/Response в 56 байт",
            )

        rekey = parse_h_range(params["rekey_after_time"])
        rekey_timeout = parse_h_range(params["rekey_timeout"])
        reject = parse_h_range(params["reject_after_time"])
        keepalive_timeout = parse_h_range(params["keepalive_timeout"])
        parsed_timings = all(x is not None for x in (rekey, rekey_timeout, reject, keepalive_timeout))
        ordered = parsed_timings and rekey[1] < reject[0] - keepalive_timeout[0] - rekey_timeout[0]
        add(
            bool(ordered),
            "RekeyAfterTime раньше RejectAfterTime с запасом",
            f"RekeyAfterTime={params['rekey_after_time']}, RejectAfterTime={params['reject_after_time']}, "
            f"KeepaliveTimeout={params['keepalive_timeout']}, RekeyTimeout={params['rekey_timeout']}",
        )
    else:
        add(
            parsed and all(r[0] >= 5 for r in h_ranges if r is not None),
            "H1–H4 >= 5 для AWG 2.0",
            "значения 1–4 зарезервированы под стандартный WireGuard",
        )

    oversized = [p for p in result["ipkts"] if p["size"] > opts["mtu"] - 28]
    add(
        not oversized,
        "I1–I5 не превышают MTU − 28",
        " · ".join(f"{p['key']}={p['size']}" for p in result["ipkts"]) + f"; лимит {opts['mtu'] - 28}",
    )
    if opts["profile"] == "fivem":
        fields = re.findall(r"<b 0x([0-9a-fA-F]+)>", params["i2"])
        raw = "".join(fields)
        enet_mtu = int(raw[24:32], 16) if len(raw) >= 32 else None
        add(
            enet_mtu == FIVEM_ENET_MTU,
            "ENet CONNECT: MTU = 1300, как у клиента FiveM",
            f"MTU в I2={enet_mtu if enet_mtu is not None else 'нет'}; ожидается {FIVEM_ENET_MTU}",
        )
        add(
            params["i1"] == f"<b 0x{OOB}><b 0x{ascii_hex('getinfo xyz')}>",
            "I1 = FF FF FF FF + «getinfo xyz»",
            "",
        )
    return out


def build_warnings(result: dict[str, Any], initial: list[str]) -> list[str]:
    opts = result["opts"]
    out: list[str] = list(initial)

    if opts["profile"] == "fivem":
        if opts["port"] != 30120:
            out.append(
                f"Endpoint слушает UDP {opts['port']}, а не 30120 (порт FiveM по умолчанию). "
                "Совпадение слабее: DPI видит нестандартный порт."
            )
        else:
            out.append(
                "Порт 30120 может быть занят настоящим FiveM-сервером. "
                "Используйте отдельный IP или NAT, чтобы не конфликтовать."
            )
        out.append(
            "Профиль повторяет последовательность клиента FiveM по исходникам (getinfo xyz → ENet CONNECT → "
            "первый reliable-пакет → msgEnd/msgRoute), но реальный клиент перед этим делает HTTP-запрос "
            "initConnect, ждёт ответы сервера и шифрует/упаковывает игровые данные: payload здесь случайный."
        )
    if opts["profile"] == "gtao":
        if opts["port"] not in (6672, 61455, 61456, 61457, 61458):
            out.append(
                f"Endpoint слушает UDP {opts['port']}. GTA Online обычно использует UDP 6672 и 61455–61458: "
                "совпадение с портом будет слабее."
            )
        out.append(
            "Протокол GTA Online закрытый и шифрованный: профиль шаблонами I1–I5 повторяет только "
            "размеры датаграмм и порт, а не их структуру. Это слабая имитация."
        )
    out.append(
        "MTU 1280 работает почти везде; MTU 1352 даёт запас до 1492 (PPPoE) и подходит для IPv6. "
        "MTU 1280 снижает риск проблем с размером пакетов, но сам по себе не делает VPN незаметным. "
        "Рекомендуется включать RandomTrailers (AWG 3.1)."
    )
    out.append(
        "CPS-пакеты I1–I5 отправляются подряд клиентом перед AWG-handshake, без ответов "
        "сервера между ними. Поэтому последовательность не соответствует полноценной сессии "
        "GTA V; AWG-сервер не отвечает игровыми пакетами."
    )
    out.append(
        "I1–I5 и J-пакеты отправляются перед каждым AWG-рукопожатием — первым и повторными, — "
        "но не перед каждым пакетом данных. RekeyAfterTime в AWG 3.1 задаёт временной порог "
        "для rekey; точное расписание зависит от работы туннеля. Затем идёт AWG/WireGuard-трафик: S4, "
        "ContentPaddingAddition и RandomTrailers меняют его оформление, но не превращают "
        "его в игровой сеанс GTA V."
    )
    if opts["version"] == 2:
        out.append(
            "AWG 2.0 использует заданные значения/диапазоны H1–H4 без Header Protection. "
            "Версия 3.1 с HeaderProtectionKey дополнительно скрывает служебные поля."
        )
    else:
        out.append(
            "HeaderProtectionKey создаётся криптографически случайным при каждой генерации "
            "и не повторяется по seed. Сервер и клиент должны использовать один и тот же ключ."
        )
        out.append(
            "DisableCookies = on отключает отправку Cookie Reply и ослабляет защиту от handshake-флуда. "
            "На публичном сервере используйте этот параметр только если осознанно принимаете этот риск."
        )
        if result["params"]["random_trailers"] == "on":
            out.append(
                "RandomTrailers вместе с S1–S4/Jc/I может заметно снижать скорость в текущих сборках "
                "amneziawg-go. Если туннель медленный, выберите режим Fast или отключите RandomTrailers."
            )
    if opts["mtu"] > 1420:
        out.append(
            "MTU больше 1420 может фрагментироваться на части провайдеров. "
            "Jmax и I-пакеты уже ограничены, но проверьте путь до сервера."
        )
    out.append(
        "S1–S4 и H1–H4 должны совпадать на клиенте и сервере. "
        "Jc, Jmin, Jmax и I1–I5 — клиентские параметры, но их можно продублировать без вреда."
    )
    out.append(
        "I1–I5 — снимок протокола. После крупного обновления FiveM/GTA V или изменения DPI "
        "сигнатуры стоит перегенерировать."
    )
    out.append(
        "Генератор не гарантирует обход DPI: он лишь делает профиль трафика ближе к GTA V. "
        "Проверяйте на своём провайдере."
    )

    # Preserve order but drop duplicates.
    seen: set[str] = set()
    unique: list[str] = []
    for warning in out:
        if warning not in seen:
            seen.add(warning)
            unique.append(warning)
    return unique


# ---------------------------------------------------------------------------
# Text builders
# ---------------------------------------------------------------------------

def build_client_conf(result: dict[str, Any]) -> str:
    params = result["params"]
    opts = result["opts"]
    profile = PROFILES[opts["profile"]]

    lines = [
        f"# Mimicry Generator · {profile['label']} · AWG {opts['version']}.x",
        f"# mode: {MODE_LABELS[opts['mode']]} · seed: {safe_comment_value(opts['seed'])}",
        "# S1-S4 и H1-H4 должны совпадать с сервером.",
        "",
        "[Interface]",
        "PrivateKey = <PRIVATE_KEY>",
        "Address = 10.8.0.2/32",
        "DNS = 1.1.1.1",
        f"MTU = {opts['mtu']}",
        "",
        "# --- обфускация ---",
        f"Jc = {params['jc']}",
        f"Jmin = {params['jmin']}",
        f"Jmax = {params['jmax']}",
        f"S1 = {params['s1']}",
        f"S2 = {params['s2']}",
        f"S3 = {params['s3']}",
        f"S4 = {params['s4']}",
        f"H1 = {params['h1']}",
        f"H2 = {params['h2']}",
        f"H3 = {params['h3']}",
        f"H4 = {params['h4']}",
        "",
        "# --- сигнатуры перед рукопожатием (клиент) ---",
        f"I1 = {params['i1']}",
        f"I2 = {params['i2']}",
        f"I3 = {params['i3']}",
        f"I4 = {params['i4']}",
        f"I5 = {params['i5']}",
    ]

    if opts["version"] >= 3:
        lines += [
            "",
            "# --- AWG 3.1 ---",
            f"HeaderProtectionKey = {params['header_protection_key']}",
            f"ContentPaddingAddition = {params['content_padding_addition']}",
            f"RandomTrailers = {params['random_trailers']}",
            "# DisableCookies = on отключает Cookie Reply и ослабляет защиту от handshake-флуда.",
            f"DisableCookies = {params['disable_cookies']}",
            f"RekeyAfterTime = {params['rekey_after_time']}",
            f"RekeyTimeout = {params['rekey_timeout']}",
            f"RejectAfterTime = {params['reject_after_time']}",
            f"KeepaliveTimeout = {params['keepalive_timeout']}",
            f"MaxHandshakeAttempts = {params['max_handshake_attempts']}",
        ]

    lines += [
        "",
        "[Peer]",
        "PublicKey = <SERVER_PUBLIC_KEY>",
        "PresharedKey = <PRESHARED_KEY>",
        f"Endpoint = <SERVER_HOST>:{opts['port']}",
        "AllowedIPs = 0.0.0.0/0, ::/0",
        f"PersistentKeepalive = {params['keepalive']}",
        "",
        "# Для FiveM endpoint обычно слушает UDP 30120.",
        "# Для GTA Online профиль только повторяет размеры датаграмм (порт 6672).",
    ]
    return "\n".join(lines)


def build_server_conf(result: dict[str, Any]) -> str:
    params = result["params"]
    opts = result["opts"]
    lines = [
        f"# Mimicry Generator · server side · AWG {opts['version']}.x",
        "# S1-S4 и H1-H4 должны совпадать с клиентом.",
        "",
        "[Interface]",
        "PrivateKey = <SERVER_PRIVATE_KEY>",
        "Address = 10.8.0.1/24",
        f"ListenPort = {opts['port']}",
        f"MTU = {opts['mtu']}",
        "",
        "# --- общие параметры ---",
        f"S1 = {params['s1']}",
        f"S2 = {params['s2']}",
        f"S3 = {params['s3']}",
        f"S4 = {params['s4']}",
        f"H1 = {params['h1']}",
        f"H2 = {params['h2']}",
        f"H3 = {params['h3']}",
        f"H4 = {params['h4']}",
    ]

    if opts["version"] >= 3:
        lines += [
            "",
            "# --- AWG 3.1 ---",
            f"HeaderProtectionKey = {params['header_protection_key']}",
            f"ContentPaddingAddition = {params['content_padding_addition']}",
            f"RandomTrailers = {params['random_trailers']}",
            "# DisableCookies = on отключает Cookie Reply и ослабляет защиту от handshake-флуда.",
            f"DisableCookies = {params['disable_cookies']}",
        ]

    lines += [
        "",
        "# Jc, Jmin, Jmax и I1-I5 — клиентские: на сервере их можно не задавать.",
        "",
        "[Peer]",
        "PublicKey = <CLIENT_PUBLIC_KEY>",
        "PresharedKey = <PRESHARED_KEY>",
        "AllowedIPs = 10.8.0.2/32",
        "",
        "# Если на этом же IP уже работает FiveM/GTA-сервер, используйте другой IP",
        "# или NAT: два процесса не могут слушать один UDP-порт.",
    ]
    return "\n".join(lines)


def build_panel_json(result: dict[str, Any]) -> str:
    """Sing-box / amnezia-box endpoint JSON accepted by the panel importer.

    importer.ParseAWGJSON expects flat awg fields plus peers[], not the
    panel-internal {"awg": {...}} nesting. Placeholders are intentionally
    non-empty: the user replaces the keys after importing the template.
    """
    params = result["params"]
    opts = result["opts"]
    node: dict[str, Any] = {
        "type": "awg",
        "tag": f"{PROFILES[opts['profile']]['label']} mimicry",
        "private_key": "<PRIVATE_KEY>",
        "address": ["10.8.0.2/32"],
        "mtu": opts["mtu"],
        # persistent_keepalive_interval намеренно не задаётся: панель подставит
        # своё целое 25 (оно входит во все диапазоны генератора). Так шаблон
        # импортируется и в старые сборки панели, которые передавали строку в
        # объявленное как uint16 поле amnezia-box.
        "peers": [
            {
                "address": opts["ip"],
                "port": opts["port"],
                "public_key": "<SERVER_PUBLIC_KEY>",
                "preshared_key": "<PRESHARED_KEY>",
                "allowed_ips": ["0.0.0.0/0", "::/0"],
            }
        ],
        "jc": params["jc"],
        "jmin": params["jmin"],
        "jmax": params["jmax"],
        "s1": params["s1"],
        "s2": params["s2"],
        "s3": params["s3"],
        "s4": params["s4"],
        "h1": params["h1"],
        "h2": params["h2"],
        "h3": params["h3"],
        "h4": params["h4"],
        "i1": params["i1"],
        "i2": params["i2"],
        "i3": params["i3"],
        "i4": params["i4"],
        "i5": params["i5"],
    }
    if opts["version"] >= 3:
        node.update(
            {
                "header_protection_key": params["header_protection_key"],
                "content_padding_addition": params["content_padding_addition"],
                "disable_cookies": params["disable_cookies"] == "on",
                "random_trailers": params["random_trailers"] == "on",
                "keepalive_timeout": params["keepalive_timeout"],
                "max_handshake_attempts": params["max_handshake_attempts"],
                "reject_after_time": params["reject_after_time"],
                "rekey_after_time": params["rekey_after_time"],
                "rekey_timeout": params["rekey_timeout"],
            }
        )
    return json.dumps(node, ensure_ascii=False, indent=2)


def safe_comment_value(value: str) -> str:
    """Escape control characters so a seed stays on its generated comment line."""
    return "".join(
        char if ord(char) >= 0x20 and ord(char) != 0x7F else f"\\u{ord(char):04x}"
        for char in str(value)
    )


def build_params_text(result: dict[str, Any]) -> str:
    params = result["params"]
    lines = [
        f"seed = {safe_comment_value(result['opts']['seed'])}",
        f"Jc = {params['jc']}",
        f"Jmin = {params['jmin']}",
        f"Jmax = {params['jmax']}",
        f"S1 = {params['s1']}",
        f"S2 = {params['s2']}",
        f"S3 = {params['s3']}",
        f"S4 = {params['s4']}",
        f"H1 = {params['h1']}",
        f"H2 = {params['h2']}",
        f"H3 = {params['h3']}",
        f"H4 = {params['h4']}",
        f"I1 = {params['i1']}",
        f"I2 = {params['i2']}",
        f"I3 = {params['i3']}",
        f"I4 = {params['i4']}",
        f"I5 = {params['i5']}",
    ]
    if result["opts"]["version"] >= 3:
        lines += [
            f"HeaderProtectionKey = {params['header_protection_key']}",
            f"ContentPaddingAddition = {params['content_padding_addition']}",
            f"RandomTrailers = {params['random_trailers']}",
            f"DisableCookies = {params['disable_cookies']}",
            f"RekeyAfterTime = {params['rekey_after_time']}",
            f"RekeyTimeout = {params['rekey_timeout']}",
            f"RejectAfterTime = {params['reject_after_time']}",
            f"KeepaliveTimeout = {params['keepalive_timeout']}",
            f"MaxHandshakeAttempts = {params['max_handshake_attempts']}",
        ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="mimicry.py",
        description="AmneziaWG × GTA V: генератор параметров маскировки.",
    )
    parser.add_argument("--profile", choices=sorted(PROFILES), default="fivem", help="профиль трафика (по умолчанию: fivem)")
    parser.add_argument("--awg", type=int, choices=[2, 3], default=3, help="версия AmneziaWG (2 или 3, по умолчанию: 3)")
    parser.add_argument("--mode", choices=sorted(MODES), default="balanced", help="режим (по умолчанию: balanced)")
    parser.add_argument("--mtu", type=int, default=1280, help="MTU (по умолчанию: 1280)")
    parser.add_argument("--ip", default="192.0.2.1", help="IPv4 сервера (адрес peer в JSON)")
    parser.add_argument("--port", type=int, default=None, help="UDP-порт сервера (по умолчанию: 30120 для FiveM, 6672 для GTA Online)")
    parser.add_argument("--seed", default=None, help="seed для воспроизводимости (по умолчанию: случайный)")
    parser.add_argument("--header-key", default=None, help="HeaderProtectionKey (base64 или hex); по умолчанию — случайный")
    parser.add_argument("--format", choices=["client", "server", "json", "params"], default="client", help="формат вывода")
    parser.add_argument("--output", default=None, help="записать результат в файл")
    parser.add_argument("--check", action="store_true", help="проверить параметры и завершиться с ненулевым кодом при ошибке")
    return parser.parse_args(argv)


def _configure_stdio() -> None:
    """Make Russian output and symbols safe on Windows consoles."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def main(argv: list[str] | None = None) -> int:
    _configure_stdio()
    args = parse_args(argv)

    if not (576 <= args.mtu <= 1500):
        print("ошибка: MTU должен быть в диапазоне 576–1500", file=sys.stderr)
        return 2

    profile = PROFILES[args.profile]
    port = args.port if args.port is not None else profile["default_port"]
    if not (1 <= port <= 65535):
        print("ошибка: порт должен быть в диапазоне 1–65535", file=sys.stderr)
        return 2

    seed = js_trim(args.seed or "") or secrets.token_hex(8)
    header_key = args.header_key
    if header_key and not header_key.strip():
        header_key = None
    if header_key:
        try:
            header_key = normalize_header_key(header_key)
        except ValueError as exc:
            print(f"ошибка: {exc}", file=sys.stderr)
            return 1
        if args.awg == 2:
            print(
                "предупреждение: HeaderProtectionKey поддерживается только в AWG 3.x — параметр проигнорирован",
                file=sys.stderr,
            )

    try:
        result = generate(
            profile=args.profile,
            awg_version=args.awg,
            mode=args.mode,
            mtu=args.mtu,
            ip=args.ip,
            port=port,
            seed=seed,
            header_key=header_key,
        )
    except ValueError as exc:
        print(f"ошибка: {exc}", file=sys.stderr)
        return 1

    if result["opts"]["ip"] != js_trim(args.ip):
        print(
            f"предупреждение: IPv4 «{args.ip}» некорректен — для JSON используется {result['opts']['ip']}",
            file=sys.stderr,
        )
    if is_test_net_ipv4(result["opts"]["ip"]):
        print(
            f"предупреждение: {result['opts']['ip']} зарезервирован для документации (TEST-NET); укажите реальный адрес сервера",
            file=sys.stderr,
        )
    if args.awg == 3:
        print(
            "предупреждение: DisableCookies=on отключает Cookie Reply и ослабляет защиту от handshake-флуда",
            file=sys.stderr,
        )

    if args.check:
        failed = [c for c in result["checks"] if not c["ok"]]
        for check in result["checks"]:
            mark = "OK " if check["ok"] else "FAIL"
            detail = f" ({check['detail']})" if check["detail"] else ""
            print(f"{mark} {check['text']}{detail}")
        return 1 if failed else 0

    formatters = {
        "client": build_client_conf,
        "server": build_server_conf,
        "json": build_panel_json,
        "params": build_params_text,
    }
    text = formatters[args.format](result)

    if args.output:
        try:
            with open(args.output, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(text + "\n")
        except OSError as exc:
            print(f"ошибка: не удалось записать {args.output}: {exc}", file=sys.stderr)
            return 1
        print(f"записано: {args.output}", file=sys.stderr)
    else:
        print(text)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
