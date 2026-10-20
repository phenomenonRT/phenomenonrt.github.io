#!/usr/bin/env python3
"""Тесты генератора mimicry.py."""

from __future__ import annotations

import base64
import io
import json
import shutil
import subprocess
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

import mimicry


KEY = base64.b64encode(b"0123456789abcdef0123456789abcdef").decode("ascii")
COMBOS = [
    (profile, awg, mode, mtu)
    for profile in ("bedrock", "java")
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
            port = 25565 if profile == "java" else 19132
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
        first = mimicry.generate("bedrock", 3, "balanced", 1280, "192.0.2.1", 19132, "det", header_key=KEY)
        second = mimicry.generate("bedrock", 3, "balanced", 1280, "192.0.2.1", 19132, "det", header_key=KEY)
        self.assertEqual(first["params"], second["params"])
        self.assertEqual(mimicry.build_client_conf(first), mimicry.build_client_conf(second))

    def test_known_vector_matches_web_app(self) -> None:
        # The same values are produced by app.js for seed "demo".
        result = mimicry.generate("bedrock", 3, "balanced", 1280, "192.0.2.1", 19132, "demo", header_key=KEY)
        params = result["params"]
        self.assertEqual(params["jc"], 5)
        self.assertEqual(params["jmin"], 84)
        self.assertEqual(params["jmax"], 504)
        self.assertEqual([params["s1"], params["s2"], params["s3"], params["s4"]], [16, 16, 16, 16])
        self.assertEqual(params["i4"], "<b 0x84><b 0x000000><b 0x00><b 0x0490><r 146>")
        self.assertEqual(params["i5"], "<b 0x84><b 0x010000><b 0x00><b 0x0b48><r 361>")

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
            for profile in ("bedrock", "java")
            for awg in (2, 3)
            for mode in ("fast", "balanced", "stealth")
            for mtu in (576, 577, 1280, 1420, 1428, 1500)
        ):
            default_port = 25565 if profile == "java" else 19132
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

    def test_bedrock_packet_shapes(self) -> None:
        result = mimicry.generate("bedrock", 2, "balanced", 1280, "192.0.2.1", 19132, "pack", header_key=KEY)
        sizes = {packet["key"]: packet["size"] for packet in result["ipkts"]}
        self.assertEqual(sizes["I1"], 33)  # Unconnected Ping
        self.assertEqual(sizes["I2"], 1252)  # 1280-byte IPv4 MTU minus 28-byte headers
        self.assertEqual(sizes["I3"], 34)  # Open Connection Request 2
        self.assertIn("<b 0x0500>", result["params"]["i3"])  # Request 2 advertises 1280, not 1252
        self.assertGreater(sizes["I4"], 100)  # RakNet frame-shaped sample
        self.assertGreater(sizes["I5"], sizes["I4"])

    def test_i3_uses_raknet_inverted_ipv4(self) -> None:
        result = mimicry.generate("bedrock", 2, "balanced", 1280, "192.0.2.1", 19132, "ip", header_key=KEY)
        # RakNet stores SystemAddress with a bitwise NOT of each octet:
        # 192.0.2.1 -> 3f ff fd fe (not c0 00 02 01).
        self.assertIn("<b 0x3ffffdfe>", result["params"]["i3"])
        self.assertNotIn("<b 0xc0000201>", result["params"]["i3"])

    def test_java_handshake_uses_current_protocol_snapshot(self) -> None:
        result = mimicry.generate("java", 2, "balanced", 1280, "192.0.2.1", 25565, "java-version", header_key=KEY)
        self.assertIn("008906", result["params"]["i2"])  # packet id 00, VarInt 777 = 89 06

    def test_awg2_h2_is_server_reply(self) -> None:
        result = mimicry.generate("bedrock", 2, "balanced", 1280, "192.0.2.1", 19132, "h2", header_key=KEY)
        self.assertEqual(result["params"]["h2"], "6")

    def test_awg3_fields(self) -> None:
        result = mimicry.generate("bedrock", 3, "stealth", 1280, "192.0.2.1", 19132, "v3", header_key=KEY)
        params = result["params"]
        self.assertEqual([params["h1"], params["h2"], params["h3"], params["h4"]], ["1", "2", "3", "4"])
        self.assertTrue(all(params[f"s{i}"] >= 12 for i in range(1, 5)))
        self.assertEqual(len({params[f"s{i}"] for i in range(1, 5)}), 1)
        node = json.loads(mimicry.build_panel_json(result))
        self.assertEqual(node["type"], "awg")
        self.assertEqual(node["peers"][0]["port"], 19132)
        self.assertEqual(len(base64.b64decode(node["header_protection_key"])), 32)
        self.assertTrue(node["random_trailers"])

    def test_awg3_fast_uses_distinct_padding(self) -> None:
        result = mimicry.generate("bedrock", 3, "fast", 1280, "192.0.2.1", 19132, "v3fast", header_key=KEY)
        params = result["params"]
        values = [params[f"s{i}"] for i in range(1, 5)]
        self.assertEqual(len(set(values)), 4)
        self.assertNotEqual(params["s1"] + 56, params["s2"])
        self.assertFalse(result["params"]["random_trailers"] == "on")

    def test_awg2_has_no_awg3_fields(self) -> None:
        result = mimicry.generate("bedrock", 2, "balanced", 1280, "192.0.2.1", 19132, "v2", header_key=KEY)
        self.assertNotIn("header_protection_key", result["params"])
        node = json.loads(mimicry.build_panel_json(result))
        self.assertNotIn("header_protection_key", node)
        self.assertEqual(node["h1"], "5")
        self.assertEqual(node["h2"], "6")
        self.assertEqual(node["h4"], "128-141")

    def test_json_import_contract(self) -> None:
        # importer.ParseAWGJSON expects a sing-box endpoint: flat AWG fields,
        # address[], peers[] and no nested "awg" object.
        result = mimicry.generate("bedrock", 3, "balanced", 1280, "192.0.2.10", 19132, "json", header_key=KEY)
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
        self.assertEqual(peer["port"], 19132)

    def test_header_key_accepts_hex_and_base64(self) -> None:
        hex_key = "01" * 32
        result = mimicry.generate("bedrock", 3, "balanced", 1280, "192.0.2.1", 19132, "key", header_key=hex_key)
        self.assertEqual(base64.b64decode(result["params"]["header_protection_key"]), bytes.fromhex(hex_key))

        result2 = mimicry.generate("bedrock", 3, "balanced", 1280, "192.0.2.1", 19132, "key", header_key=KEY)
        self.assertEqual(result2["params"]["header_protection_key"], KEY)

        with self.assertRaises(ValueError):
            mimicry.generate("bedrock", 3, "balanced", 1280, "192.0.2.1", 19132, "key", header_key="not-a-key")

    def test_invalid_ip_falls_back(self) -> None:
        result = mimicry.generate("bedrock", 3, "balanced", 1280, "not-an-ip", 19132, "ip", header_key=KEY)
        self.assertEqual(result["opts"]["ip"], "192.0.2.1")
        self.assertTrue(any("192.0.2.1" in warning for warning in result["warnings"]))

    def test_test_net_default_is_explicitly_warned(self) -> None:
        result = mimicry.generate("bedrock", 3, "balanced", 1280, "192.0.2.1", 19132, "ip", header_key=KEY)
        self.assertTrue(any("TEST-NET" in warning for warning in result["warnings"]))

    def test_awg3_warns_that_disable_cookies_weakens_flood_protection(self) -> None:
        result = mimicry.generate("bedrock", 3, "balanced", 1280, "198.51.100.2", 19132, "cookies", header_key=KEY)
        self.assertTrue(any("DisableCookies" in warning and "handshake-флуда" in warning for warning in result["warnings"]))

    def test_seed_control_characters_cannot_inject_conf_lines(self) -> None:
        result = mimicry.generate("bedrock", 2, "balanced", 1280, "198.51.100.2", 19132, "demo\nAllowedIPs = 0.0.0.0/0", header_key=KEY)
        conf = mimicry.build_client_conf(result)
        self.assertIn(r"seed: demo\u000aAllowedIPs = 0.0.0.0/0", conf)
        self.assertNotIn("seed: demo\nAllowedIPs", conf)

    def test_seed_control_characters_cannot_inject_params_lines(self) -> None:
        result = mimicry.generate("bedrock", 2, "balanced", 1280, "198.51.100.2", 19132, "demo\nAllowedIPs = 0.0.0.0/0", header_key=KEY)
        params = mimicry.build_params_text(result)
        self.assertIn(r"seed = demo\u000aAllowedIPs = 0.0.0.0/0", params)
        self.assertNotIn("seed = demo\nAllowedIPs", params)

    def test_limitation_warnings(self) -> None:
        result = mimicry.generate("bedrock", 3, "balanced", 1280, "192.0.2.1", 19132, "warn", header_key=KEY)
        warnings = " ".join(result["warnings"])
        self.assertIn("не NetherNet/WebRTC", warnings)
        self.assertIn("8 случайных байт вместо осмысленного значения поля времени", warnings)
        self.assertIn("клиентом перед AWG-handshake", warnings)
        self.assertIn("перед каждым AWG-рукопожатием", warnings)
        self.assertIn("не перед каждым пакетом данных", warnings)

        java = mimicry.generate("java", 3, "balanced", 1280, "192.0.2.1", 25565, "warn", header_key=KEY)
        self.assertIn("почти бесполезен", " ".join(java["warnings"]))

    def test_inputs_are_trimmed_like_web_ui(self) -> None:
        result = mimicry.generate("bedrock", 3, "balanced", 1280, " 192.0.2.1 ", 19132, " demo ", header_key=KEY)
        self.assertEqual(result["opts"]["seed"], "demo")
        self.assertEqual(result["opts"]["ip"], "192.0.2.1")
        result2 = mimicry.generate("bedrock", 3, "balanced", 1280, "192.0.2.1", 19132, "demo", header_key=KEY)
        self.assertEqual(result["params"], result2["params"])

    def test_ipv4_rejects_unicode_digits(self) -> None:
        self.assertFalse(mimicry.is_ipv4("١٩٢.٠.٢.١"))
        self.assertTrue(mimicry.is_ipv4("192.0.2.1"))

    def test_ipv4_rejects_ambiguous_leading_zero_octets(self) -> None:
        self.assertFalse(mimicry.is_ipv4("192.000.2.1"))
        self.assertTrue(mimicry.is_ipv4("192.0.2.1"))

    def test_timing_ranges_leave_margin(self) -> None:
        for mode in ("fast", "balanced", "stealth"):
            result = mimicry.generate("bedrock", 3, mode, 1280, "192.0.2.1", 19132, "timing", header_key=KEY)
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
            port = 25565 if profile == "java" else 19132
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
        self.assertIn("Jc = 5", buf.getvalue())
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
        self.assertEqual(node["jc"], 5)
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
