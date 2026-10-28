#!/usr/bin/env python3
"""Тесты генератора mimicry.py."""

from __future__ import annotations

import base64
import io
import json
import re
import shutil
import subprocess
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

import mimicry


KEY = base64.b64encode(b"0123456789abcdef0123456789abcdef").decode("ascii")
COMBOS = [
    (profile, awg, mode, mtu)
    for profile in ("fivem", "gtao")
    for awg in (2, 3)
    for mode in ("fast", "balanced", "stealth")
    for mtu in (576, 1280, 1500)
]

BROWSER_PARITY_SCRIPT = r"""
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(process.argv[1], 'utf8')
  .replace(/if \(document\.readyState[\s\S]*$/, '');
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
const context = { crypto: webcrypto, btoa, TextEncoder, cases };
vm.createContext(context);
vm.runInContext(source, context);
const results = cases.map((testCase) => {
  const options = {
    ...testCase.options,
    seed: testCase.options.seed.trim(),
    ip: testCase.options.ip.trim(),
  };
  const result = context.generate(options);
  if (result.params.header_protection_key !== undefined) {
    result.params.header_protection_key = testCase.headerKey;
  }
  return {
    opts: result.opts,
    params: result.params,
    sizes: result.sizes,
    ipkts: result.ipkts,
    checks: result.checks.map((check) => check.ok),
    warnings: result.warnings,
    clientConf: context.buildClientConf(result),
    serverConf: context.buildServerConf(result),
    panelJson: context.buildPanelJson(result),
  };
});
process.stdout.write(JSON.stringify(results));
"""


class GenerationTests(unittest.TestCase):
    def test_all_combinations_pass_checks(self) -> None:
        failures: list[str] = []
        for profile, awg, mode, mtu in COMBOS:
            port = 6672 if profile == "gtao" else 30120
            result = mimicry.generate(
                profile=profile,
                awg_version=awg,
                mode=mode,
                mtu=mtu,
                ip="192.0.2.10",
                port=port,
                seed="unit-seed",
                header_key=KEY,
            )
            for check in result["checks"]:
                if not check["ok"]:
                    failures.append(f"{profile}/{awg}/{mode}/{mtu}: {check['text']} ({check['detail']})")
            for packet in result["ipkts"]:
                if packet["size"] > mtu - 28:
                    failures.append(f"{profile}/{awg}/{mode}/{mtu}: {packet['key']} too big ({packet['size']})")
        self.assertEqual(failures, [])

    def test_same_seed_is_deterministic(self) -> None:
        first = mimicry.generate("fivem", 3, "balanced", 1280, "192.0.2.1", 30120, "det", header_key=KEY)
        second = mimicry.generate("fivem", 3, "balanced", 1280, "192.0.2.1", 30120, "det", header_key=KEY)
        self.assertEqual(first["params"], second["params"])
        self.assertEqual(mimicry.build_client_conf(first), mimicry.build_client_conf(second))

    def test_known_vector_matches_web_app(self) -> None:
        # The same values are produced by app.js for seed "demo".
        result = mimicry.generate("fivem", 3, "balanced", 1280, "192.0.2.1", 30120, "demo", header_key=KEY)
        params = result["params"]
        self.assertEqual(params["jc"], 6)
        self.assertEqual(params["jmin"], 93)
        self.assertEqual(params["jmax"], 730)
        self.assertEqual([params["s1"], params["s2"], params["s3"], params["s4"]], [21, 21, 21, 21])
        self.assertEqual(params["i1"], "<b 0xffffffff><b 0x676574696e666f2078797a>")
        self.assertEqual(params["i4"], "<b 0x9034><b 0x5270><b 0x49><b 0x01><b 0x0000><b 0x0001><b 0x0004><b 0x639e56ca>")
        self.assertEqual(
            params["i5"],
            "<b 0x9034><b 0xf186><b 0x07><b 0x01><b 0x0000><b 0x0001><b 0x012b>"
            "<b 0x5b4438e9><b 0x7400><b 0x2301><r 291>",
        )

    def test_browser_and_python_results_match_across_supported_matrix(self) -> None:
        node = shutil.which("node")
        if node is None:
            self.skipTest("Node.js is required to run the browser/Python parity check")

        cases: list[dict[str, object]] = []
        inputs = (
            ("192.0.2.1", 1, "audit-seed-🧊"),
            ("\ufeff198.51.100.254\ufeff", 65535, "\ufeffaudit-seed\ufeff"),
            ("\x1c192.0.2.1\x1c", None, "\x1caudit-seed\x1c"),
            ("0.0.0.0", 1, "minimum-ip-octets"),
            ("255.255.255.255", 65535, "maximum-ip-octets"),
            ("256.0.0.1", None, "out-of-range-ip-octet"),
        )
        for profile, awg, mode, mtu in (
            (profile, awg, mode, mtu)
            for profile in ("fivem", "gtao")
            for awg in (2, 3)
            for mode in ("fast", "balanced", "stealth")
            for mtu in (576, 577, 1280, 1420, 1428, 1500)
        ):
            default_port = 6672 if profile == "gtao" else 30120
            for ip, port, seed in inputs:
                cases.append(
                    {
                        "options": {
                            "profile": profile,
                            "version": awg,
                            "mode": mode,
                            "mtu": mtu,
                            "ip": ip,
                            "port": default_port if port is None else port,
                            "seed": seed,
                        },
                        "headerKey": KEY,
                    }
                )

        app_js = str(Path(__file__).with_name("app.js"))
        completed = subprocess.run(
            [node, "-e", BROWSER_PARITY_SCRIPT, app_js],
            input=json.dumps(cases, ensure_ascii=True),
            text=True,
            encoding="utf-8",
            capture_output=True,
            check=True,
        )
        browser_results = json.loads(completed.stdout)

        python_results = []
        for case in cases:
            options = case["options"]
            result = mimicry.generate(
                profile=options["profile"],
                awg_version=options["version"],
                mode=options["mode"],
                mtu=options["mtu"],
                ip=options["ip"],
                port=options["port"],
                seed=options["seed"],
                header_key=case["headerKey"],
            )
            python_results.append(
                {
                    "opts": result["opts"],
                    "params": result["params"],
                    "sizes": result["sizes"],
                    "ipkts": result["ipkts"],
                    "checks": [check["ok"] for check in result["checks"]],
                    "warnings": result["warnings"],
                    "clientConf": mimicry.build_client_conf(result),
                    "serverConf": mimicry.build_server_conf(result),
                    "panelJson": mimicry.build_panel_json(result),
                }
            )

        self.assertEqual(len(browser_results), len(python_results))
        for case, browser, python in zip(cases, browser_results, python_results):
            self.assertTrue(
                all(browser["checks"]),
                msg=f"browser checks failed for {case['options']!r}",
            )
            self.assertTrue(
                all(python["checks"]),
                msg=f"Python checks failed for {case['options']!r}",
            )
            for field in browser:
                self.assertEqual(
                    browser[field],
                    python[field],
                    msg=(
                        f"browser/Python mismatch in {field} for {case['options']!r}: "
                        f"browser={json.dumps(browser[field], ensure_ascii=True)}; "
                        f"python={json.dumps(python[field], ensure_ascii=True)}"
                    ),
                )

    def test_hash_matches_fivem_constant(self) -> None:
        # NetLibraryImplV2.cpp hard-codes msgEnd = 0xCA569E63 = HashRageString("msgEnd").
        self.assertEqual(mimicry.joaat("msgEnd"), 0xCA569E63)
        self.assertEqual(mimicry.joaat("msgRoute"), 0xE938445B)

    def test_fivem_packet_shapes(self) -> None:
        result = mimicry.generate("fivem", 2, "balanced", 1280, "192.0.2.1", 30120, "pack", header_key=KEY)
        params = result["params"]
        sizes = {packet["key"]: packet["size"] for packet in result["ipkts"]}
        self.assertEqual(params["i1"], "<b 0xffffffff><b 0x" + b"getinfo xyz".hex() + ">")  # as in NetLibrary.cpp
        self.assertEqual(sizes["I1"], 4 + len("getinfo xyz"))
        self.assertEqual(sizes["I2"], 52)  # ENet protocol header + CONNECT command
        self.assertTrue(params["i2"].startswith("<b 0x8fff>"))  # peerID 0xFFF + SENT_TIME flag
        self.assertIn("<b 0x82><b 0xff><b 0x0001>", params["i2"])
        self.assertEqual(sizes["I4"], 16)  # msgEnd keepalive, UNSEQUENCED on channel 1
        self.assertIn("<b 0x49><b 0x01>", params["i4"])
        self.assertTrue(params["i4"].endswith("<b 0x639e56ca>"))  # 0xCA569E63 little-endian
        self.assertIn("<b 0x07><b 0x01>", params["i5"])  # msgRoute: unreliable on channel 1
        self.assertIn("<b 0x5b4438e9>", params["i5"])  # 0xE938445B little-endian

    def test_fivem_first_reliable_packet_carries_token_and_guid(self) -> None:
        result = mimicry.generate("fivem", 2, "balanced", 1280, "192.0.2.1", 30120, "tok", header_key=KEY)
        i3 = result["params"]["i3"]
        self.assertIn("<b 0x86><b 0x00><b 0x0001>", i3)  # reliable, channel 0, first sequence number
        payload = bytes.fromhex(i3.rsplit("<b 0x", 1)[1].rstrip(">"))
        self.assertEqual(payload[:4], b"\x01\x00\x00\x00")  # int 1, little-endian
        match = re.fullmatch(
            rb"token=([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})&guid=(\d{1,20})",
            payload[4:],
        )
        self.assertIsNotNone(match)
        self.assertLess(int(match.group(2)), 2**64)
        # The ENet CONNECT "data" field is HashString(token); it must match the token in I3.
        connect_hex = "".join(re.findall(r"<b 0x([0-9a-f]+)>", result["params"]["i2"]))
        self.assertEqual(int(connect_hex[-8:], 16), mimicry.joaat(match.group(1).decode()))

    def test_fivem_enet_mtu_is_the_clients_constant(self) -> None:
        # FiveM's client host uses MTU 1300 whatever the tunnel MTU is.
        for mtu in (576, 1280, 1500):
            result = mimicry.generate("fivem", 2, "balanced", mtu, "192.0.2.1", 30120, "mtu", header_key=KEY)
            self.assertIn("0000ffff00000514", result["params"]["i2"], mtu)  # 1300 = 0x0514

    def test_gtao_is_opaque_and_sized_to_mtu(self) -> None:
        result = mimicry.generate("gtao", 2, "balanced", 1280, "192.0.2.1", 6672, "pack", header_key=KEY)
        for key in ("i1", "i2", "i3", "i4", "i5"):
            self.assertRegex(result["params"][key], r"^<r \d+>$")
        self.assertTrue(all(packet["size"] <= 1280 - 28 for packet in result["ipkts"]))

    def test_awg2_h_values_do_not_overlap(self) -> None:
        for profile, port in (("fivem", 30120), ("gtao", 6672)):
            result = mimicry.generate(profile, 2, "balanced", 1280, "192.0.2.1", port, "h", header_key=KEY)
            self.assertTrue(all(check["ok"] for check in result["checks"]), profile)
        fivem = mimicry.generate("fivem", 2, "balanced", 1280, "192.0.2.1", 30120, "h", header_key=KEY)
        self.assertEqual(fivem["params"]["h1"], "130")  # ENet CONNECT | ACKNOWLEDGE

    def test_awg3_fields(self) -> None:
        result = mimicry.generate("fivem", 3, "stealth", 1280, "192.0.2.1", 30120, "v3", header_key=KEY)
        params = result["params"]
        self.assertEqual([params["h1"], params["h2"], params["h3"], params["h4"]], ["1", "2", "3", "4"])
        self.assertTrue(all(params[f"s{i}"] >= 12 for i in range(1, 5)))
        self.assertEqual(len({params[f"s{i}"] for i in range(1, 5)}), 1)
        node = json.loads(mimicry.build_panel_json(result))
        self.assertEqual(node["type"], "awg")
        self.assertEqual(node["peers"][0]["port"], 30120)
        self.assertEqual(len(base64.b64decode(node["header_protection_key"])), 32)
        self.assertTrue(node["random_trailers"])

    def test_awg3_fast_uses_distinct_padding(self) -> None:
        result = mimicry.generate("fivem", 3, "fast", 1280, "192.0.2.1", 30120, "v3fast", header_key=KEY)
        params = result["params"]
        values = [params[f"s{i}"] for i in range(1, 5)]
        self.assertEqual(len(set(values)), 4)
        self.assertNotEqual(params["s1"] + 56, params["s2"])
        self.assertFalse(result["params"]["random_trailers"] == "on")

    def test_awg2_has_no_awg3_fields(self) -> None:
        result = mimicry.generate("fivem", 2, "balanced", 1280, "192.0.2.1", 30120, "v2", header_key=KEY)
        self.assertNotIn("header_protection_key", result["params"])
        node = json.loads(mimicry.build_panel_json(result))
        self.assertNotIn("header_protection_key", node)
        self.assertEqual(node["h1"], "130")
        self.assertEqual(node["h2"], "131")
        self.assertEqual(node["h4"], "134-137")

    def test_json_import_contract(self) -> None:
        # importer.ParseAWGJSON expects a sing-box endpoint: flat AWG fields,
        # address[], peers[] and no nested "awg" object.
        result = mimicry.generate("fivem", 3, "balanced", 1280, "192.0.2.10", 30120, "json", header_key=KEY)
        node = json.loads(mimicry.build_panel_json(result))
        for key in ("type", "tag", "private_key", "address", "mtu", "peers", "jc", "s1", "h1", "i1"):
            self.assertIn(key, node)
        self.assertNotIn("awg", node)
        self.assertEqual(node["address"], ["10.8.0.2/32"])
        peer = node["peers"][0]
        for key in ("address", "port", "public_key", "preshared_key", "allowed_ips"):
            self.assertIn(key, peer)
        # The panel stores Keepalive as a string and passes it to amnezia-box,
        # whose field is uint16. Omitting it makes the panel use its integer
        # default (25), which fits every generator keepalive range.
        self.assertNotIn("persistent_keepalive_interval", peer)
        self.assertEqual(peer["address"], "192.0.2.10")
        self.assertEqual(peer["port"], 30120)

    def test_header_key_accepts_hex_and_base64(self) -> None:
        hex_key = "01" * 32
        result = mimicry.generate("fivem", 3, "balanced", 1280, "192.0.2.1", 30120, "key", header_key=hex_key)
        self.assertEqual(base64.b64decode(result["params"]["header_protection_key"]), bytes.fromhex(hex_key))

        result2 = mimicry.generate("fivem", 3, "balanced", 1280, "192.0.2.1", 30120, "key", header_key=KEY)
        self.assertEqual(result2["params"]["header_protection_key"], KEY)

        with self.assertRaises(ValueError):
            mimicry.generate("fivem", 3, "balanced", 1280, "192.0.2.1", 30120, "key", header_key="not-a-key")

    def test_invalid_ip_falls_back(self) -> None:
        result = mimicry.generate("fivem", 3, "balanced", 1280, "not-an-ip", 30120, "ip", header_key=KEY)
        self.assertEqual(result["opts"]["ip"], "192.0.2.1")
        self.assertTrue(any("192.0.2.1" in warning for warning in result["warnings"]))

    def test_test_net_default_is_explicitly_warned(self) -> None:
        result = mimicry.generate("fivem", 3, "balanced", 1280, "192.0.2.1", 30120, "ip", header_key=KEY)
        self.assertTrue(any("TEST-NET" in warning for warning in result["warnings"]))

    def test_awg3_warns_that_disable_cookies_weakens_flood_protection(self) -> None:
        result = mimicry.generate("fivem", 3, "balanced", 1280, "198.51.100.2", 30120, "cookies", header_key=KEY)
        self.assertTrue(any("DisableCookies" in warning and "handshake-флуда" in warning for warning in result["warnings"]))

    def test_seed_control_characters_cannot_inject_conf_lines(self) -> None:
        result = mimicry.generate("fivem", 2, "balanced", 1280, "198.51.100.2", 30120, "demo\nAllowedIPs = 0.0.0.0/0", header_key=KEY)
        conf = mimicry.build_client_conf(result)
        self.assertIn(r"seed: demo\u000aAllowedIPs = 0.0.0.0/0", conf)
        self.assertNotIn("seed: demo\nAllowedIPs", conf)

    def test_seed_control_characters_cannot_inject_params_lines(self) -> None:
        result = mimicry.generate("fivem", 2, "balanced", 1280, "198.51.100.2", 30120, "demo\nAllowedIPs = 0.0.0.0/0", header_key=KEY)
        params = mimicry.build_params_text(result)
        self.assertIn(r"seed = demo\u000aAllowedIPs = 0.0.0.0/0", params)
        self.assertNotIn("seed = demo\nAllowedIPs", params)

    def test_limitation_warnings(self) -> None:
        result = mimicry.generate("fivem", 3, "balanced", 1280, "192.0.2.1", 30120, "warn", header_key=KEY)
        warnings = " ".join(result["warnings"])
        self.assertIn("initConnect", warnings)
        self.assertIn("клиентом перед AWG-handshake", warnings)
        self.assertIn("перед каждым AWG-рукопожатием", warnings)
        self.assertIn("не перед каждым пакетом данных", warnings)

        gtao = mimicry.generate("gtao", 3, "balanced", 1280, "192.0.2.1", 6672, "warn", header_key=KEY)
        self.assertIn("слабая имитация", " ".join(gtao["warnings"]))

    def test_inputs_are_trimmed_like_web_ui(self) -> None:
        result = mimicry.generate("fivem", 3, "balanced", 1280, " 192.0.2.1 ", 30120, " demo ", header_key=KEY)
        self.assertEqual(result["opts"]["seed"], "demo")
        self.assertEqual(result["opts"]["ip"], "192.0.2.1")
        result2 = mimicry.generate("fivem", 3, "balanced", 1280, "192.0.2.1", 30120, "demo", header_key=KEY)
        self.assertEqual(result["params"], result2["params"])

    def test_ipv4_rejects_unicode_digits(self) -> None:
        self.assertFalse(mimicry.is_ipv4("١٩٢.٠.٢.١"))
        self.assertTrue(mimicry.is_ipv4("192.0.2.1"))

    def test_ipv4_rejects_ambiguous_leading_zero_octets(self) -> None:
        self.assertFalse(mimicry.is_ipv4("192.000.2.1"))
        self.assertTrue(mimicry.is_ipv4("192.0.2.1"))

    def test_timing_ranges_leave_margin(self) -> None:
        for mode in ("fast", "balanced", "stealth"):
            result = mimicry.generate("fivem", 3, mode, 1280, "192.0.2.1", 30120, "timing", header_key=KEY)
            params = result["params"]
            rekey_hi = max(int(x) for x in params["rekey_after_time"].split("-"))
            reject_lo = min(int(x) for x in params["reject_after_time"].split("-"))
            keepalive_lo = min(int(x) for x in params["keepalive_timeout"].split("-"))
            timeout_lo = min(int(x) for x in params["rekey_timeout"].split("-"))
            self.assertLess(rekey_hi, reject_lo - keepalive_lo - timeout_lo, mode)

    def test_cps_size_parser(self) -> None:
        self.assertEqual(mimicry.cps_size("<b 0x01><r 8><t><rc 4><rd 2>"), 1 + 8 + 4 + 4 + 2)
        self.assertEqual(mimicry.cps_size("<b 0x00ff>"), 2)
        with self.assertRaises(ValueError):
            mimicry.cps_size("<b 0x0>")
        with self.assertRaises(ValueError):
            mimicry.cps_size("<x 5>")
        with self.assertRaises(ValueError):
            mimicry.cps_size("<r 1001>")

    def test_header_ranges_do_not_overlap(self) -> None:
        for profile, awg, mode, mtu in COMBOS:
            port = 6672 if profile == "gtao" else 30120
            result = mimicry.generate(profile, awg, mode, mtu, "192.0.2.1", port, "h", header_key=KEY)
            ranges = [mimicry.parse_h_range(result["params"][f"h{i}"]) for i in range(1, 5)]
            self.assertTrue(all(r is not None for r in ranges))
            for i in range(4):
                for j in range(i + 1, 4):
                    self.assertFalse(mimicry.ranges_overlap(ranges[i], ranges[j]))


class CliTests(unittest.TestCase):
    def test_cli_accepts_mtu_and_port_boundaries(self) -> None:
        for mtu, port in ((576, 1), (1500, 65535)):
            with self.subTest(mtu=mtu, port=port):
                output = io.StringIO()
                with redirect_stdout(output), redirect_stderr(io.StringIO()):
                    code = mimicry.main(
                        [
                            "--mtu",
                            str(mtu),
                            "--port",
                            str(port),
                            "--seed",
                            "boundary",
                            "--format",
                            "json",
                            "--header-key",
                            KEY,
                        ]
                    )
                self.assertEqual(code, 0)
                node = json.loads(output.getvalue())
                self.assertEqual(node["mtu"], mtu)
                self.assertEqual(node["peers"][0]["port"], port)

    def test_cli_rejects_mtu_and_port_outside_ranges(self) -> None:
        for args, expected in (
            (("--mtu", "575"), "MTU"),
            (("--mtu", "1501"), "MTU"),
            (("--port", "0"), "порт"),
            (("--port", "65536"), "порт"),
        ):
            with self.subTest(args=args):
                error = io.StringIO()
                with redirect_stdout(io.StringIO()), redirect_stderr(error):
                    code = mimicry.main([*args, "--seed", "boundary"])
                self.assertEqual(code, 2)
                self.assertIn(expected, error.getvalue())

    def test_params_output(self) -> None:
        buf = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(io.StringIO()):
            code = mimicry.main(["--seed", "demo", "--format", "params", "--header-key", KEY])
        self.assertEqual(code, 0)
        self.assertIn("Jc = 6", buf.getvalue())
        self.assertIn("I1 = ", buf.getvalue())

    def test_check_output(self) -> None:
        buf = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(io.StringIO()):
            code = mimicry.main(["--seed", "demo", "--check", "--header-key", KEY])
        self.assertEqual(code, 0)
        self.assertIn("OK", buf.getvalue())
        self.assertNotIn("FAIL", buf.getvalue())

    def test_json_output(self) -> None:
        buf = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(io.StringIO()):
            code = mimicry.main(["--seed", "demo", "--format", "json", "--header-key", KEY])
        self.assertEqual(code, 0)
        node = json.loads(buf.getvalue())
        self.assertEqual(node["type"], "awg")
        self.assertEqual(node["peers"][0]["address"], "192.0.2.1")
        self.assertEqual(node["jc"], 6)
        self.assertNotIn("persistent_keepalive_interval", node["peers"][0])

    def test_cli_warns_about_test_net_address(self) -> None:
        err = io.StringIO()
        with redirect_stdout(io.StringIO()), redirect_stderr(err):
            code = mimicry.main(["--seed", "demo", "--format", "json", "--ip", "192.0.2.1"])
        self.assertEqual(code, 0)
        self.assertIn("TEST-NET", err.getvalue())

    def test_cli_warns_about_disable_cookies_risk(self) -> None:
        err = io.StringIO()
        with redirect_stdout(io.StringIO()), redirect_stderr(err):
            code = mimicry.main(["--seed", "demo", "--format", "json", "--ip", "198.51.100.2"])
        self.assertEqual(code, 0)
        self.assertIn("DisableCookies=on", err.getvalue())
        self.assertIn("handshake-флуда", err.getvalue())

    def test_cli_validates_header_key_for_awg2(self) -> None:
        err = io.StringIO()
        with redirect_stdout(io.StringIO()), redirect_stderr(err):
            code = mimicry.main(["--awg", "2", "--seed", "demo", "--header-key", "bad"])
        self.assertEqual(code, 1)
        self.assertIn("HeaderProtectionKey", err.getvalue())

    def test_cli_warns_unused_header_key_for_awg2(self) -> None:
        err = io.StringIO()
        with redirect_stdout(io.StringIO()), redirect_stderr(err):
            code = mimicry.main(["--awg", "2", "--seed", "demo", "--format", "params", "--header-key", KEY])
        self.assertEqual(code, 0)
        self.assertIn("проигнорирован", err.getvalue())

    def test_cli_warns_on_invalid_ip(self) -> None:
        err = io.StringIO()
        with redirect_stdout(io.StringIO()), redirect_stderr(err):
            code = mimicry.main(["--seed", "demo", "--format", "params", "--ip", "not-an-ip", "--header-key", KEY])
        self.assertEqual(code, 0)
        self.assertIn("192.0.2.1", err.getvalue())


if __name__ == "__main__":
    unittest.main()
