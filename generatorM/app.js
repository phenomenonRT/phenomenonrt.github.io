'use strict';

/* ============================================================
   Mimicry Generator — AmneziaWG × Minecraft
   Vanilla JS, no dependencies, works from file://
   ============================================================ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const MAGIC = '00ffff00fefefefefdfdfdfd12345678'; // RakNet offline magic
const JAVA_PROTOCOL = 777; // Minecraft Java 26.3; update when the game protocol changes.

const PROFILES = {
  bedrock: {
    label: 'Minecraft Bedrock (RakNet)',
    short: 'Bedrock / RakNet',
    transport: 'UDP',
    defaultPort: 19132,
    hint: 'Этот профиль формирует начальные RakNet/UDP-пакеты. Он не имитирует NetherNet/WebRTC и его сигнализацию; I1–I5 также не создают полноценную игровую сессию, а AWG-сервер не отвечает как RakNet-сервер.',
  },
  java: {
    label: 'Minecraft Java (surface)',
    short: 'Java / surface',
    transport: 'TCP (surface)',
    defaultPort: 25565,
    hint: 'Java Edition работает по TCP. Профиль почти бесполезен как самостоятельная маскировка: UDP-туннель не может притвориться TCP. Это лишь байтовые сигнатуры — используйте Bedrock.',
  },
};

const MODE_LABELS = {
  balanced: 'Balanced',
  stealth: 'Stealth',
  fast: 'Fast',
};

const MODES = {
  fast: {
    jc: [2, 4],
    jmin: [32, 64],
    jmax: [160, 400],
    padding: '12-64',
    timings: {
      rekeyAfter: '120',
      rekeyTimeout: '5',
      rejectAfter: '180',
      keepaliveTimeout: '10',
      maxAttempts: '8',
      keepalive: '25',
    },
  },
  balanced: {
    jc: [4, 7],
    jmin: [48, 96],
    jmax: [300, 800],
    padding: '16-128',
    timings: {
      rekeyAfter: '120-150',
      rekeyTimeout: '5-8',
      rejectAfter: '190-240',
      keepaliveTimeout: '10-20',
      maxAttempts: '8-12',
      keepalive: '20-30',
    },
  },
  stealth: {
    jc: [7, 12],
    jmin: [64, 128],
    jmax: [700, 1200],
    padding: '32-256',
    timings: {
      rekeyAfter: '140-180',
      rekeyTimeout: '6-10',
      rejectAfter: '220-280',
      keepaliveTimeout: '12-25',
      maxAttempts: '10-16',
      keepalive: '20-30',
    },
  },
};

const I_META = {
  bedrock: [
    ['i1', 'Unconnected Ping · RakNet 0x01'],
    ['i2', 'Open Connection Request 1 · 0x05'],
    ['i3', 'Open Connection Request 2 · 0x07'],
    ['i4', 'RakNet Frame Set · unreliable frame'],
    ['i5', 'RakNet Frame Set · next sequence'],
  ],
  java: [
    ['i1', 'Legacy Server List Ping · 0xFE 0x01'],
    ['i2', 'Handshake · packet 0x00'],
    ['i3', 'Status Request · packet 0x00'],
    ['i4', 'Status Ping · packet 0x01 (requires server response)'],
    ['i5', 'Status Ping · packet 0x01 (requires server response)'],
  ],
};

let last = null;
let toastTimer = null;

/* ---------------- PRNG ---------------- */

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const h = xmur3(String(seed));
  return mulberry32(h());
}

function randInt(rng, min, max) {
  if (max < min) [min, max] = [max, min];
  return min + Math.floor(rng() * (max - min + 1));
}

function randomBytesCrypto(n) {
  const out = new Uint8Array(n);
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new Error('Криптографический генератор случайных чисел недоступен');
  }
  crypto.getRandomValues(out);
  return out;
}

function randomBytesFromRng(rng, n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

function pickDistinct(rng, low, high, count) {
  const pool = [];
  for (let value = low; value <= high; value++) pool.push(value);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(pool.splice(randInt(rng, 0, pool.length - 1), 1)[0]);
  }
  return out;
}

function randomSeed() {
  return bytesToHex(randomBytesCrypto(8));
}

/* ---------------- Encoding helpers ---------------- */

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function u16be(n) {
  return ((n >> 8) & 0xff).toString(16).padStart(2, '0') + (n & 0xff).toString(16).padStart(2, '0');
}

function u24le(n) {
  return [n, n >>> 8, n >>> 16]
    .map((b) => (b & 0xff).toString(16).padStart(2, '0'))
    .join('');
}

function u32be(n) {
  const x = n >>> 0;
  return [x >>> 24, x >>> 16, x >>> 8, x].map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
}

function varintHex(n) {
  let v = n >>> 0;
  let out = '';
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out += (b & 0xff).toString(16).padStart(2, '0');
  } while (v);
  return out;
}

function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}

function utf16beHex(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) out += u16be(str.charCodeAt(i));
  return out;
}

function base64FromBytes(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function isIPv4(s) {
  const m = String(s).trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return !!m && m.slice(1).every((x) => {
    const n = Number(x);
    return Number.isInteger(n) && n >= 0 && n <= 255 && !(x.length > 1 && x[0] === '0');
  });
}

function isTestNetIPv4(s) {
  if (!isIPv4(s)) return false;
  const [a, b, c] = String(s).trim().split('.').map(Number);
  return (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113);
}

function ipv4Hex(s) {
  // RakNet serializes SystemAddress with a bitwise NOT of every IPv4 octet
  // (no endian swap), e.g. 192.0.2.1 -> 3f ff fd fe.
  return String(s).trim().split('.').map((x) => ((~Number(x)) & 0xff).toString(16).padStart(2, '0')).join('');
}

/* ---------------- Generation ---------------- */

function generate(opts) {
  const rng = makeRng([
    opts.seed,
    opts.profile,
    opts.version,
    opts.mode,
    opts.mtu,
    opts.ip,
    opts.port,
  ].join('|'));

  const mode = MODES[opts.mode] || MODES.balanced;
  const warnings = [];
  const ip = isIPv4(opts.ip) ? opts.ip.trim() : '192.0.2.1';
  if (ip !== opts.ip.trim()) {
    warnings.push(`IPv4 «${opts.ip}» некорректен — для I3 используется 192.0.2.1.`);
  }
  if (isTestNetIPv4(ip)) {
    warnings.push(`${ip} — адрес из TEST-NET, зарезервированный для документации, а не публичный адрес сервера. Замените его перед импортом JSON и подключением.`);
  }

  const p = {};

  // Junk train: sizes are deliberately in the range of Bedrock game packets.
  const jmaxHi = Math.max(96, Math.min(mode.jmax[1], opts.mtu - 40));
  const jmaxLo = Math.max(64, Math.min(mode.jmax[0], jmaxHi - 32));
  const jminHi = Math.max(32, Math.min(mode.jmin[1], jmaxLo - 32));
  const jminLo = Math.min(mode.jmin[0], jminHi);
  p.jc = randInt(rng, mode.jc[0], mode.jc[1]);
  p.jmin = randInt(rng, jminLo, jminHi);
  const jmaxFloor = Math.min(jmaxHi, Math.max(jmaxLo, p.jmin + 32));
  p.jmax = randInt(rng, jmaxFloor, jmaxHi);

  // Padding.
  const s = makeS(rng, opts);
  p.s1 = s.s1;
  p.s2 = s.s2;
  p.s3 = s.s3;
  p.s4 = s.s4;

  // Headers.
  if (opts.version === 3) {
    // With header protection, the spec recommends standard compatibility values.
    p.h1 = '1';
    p.h2 = '2';
    p.h3 = '3';
    p.h4 = '4';
  } else if (opts.profile === 'bedrock') {
    // H1 is the client's OCR1 (0x05); H2 must be a server response, so use
    // OCR1 Reply (0x06), not the client's OCR2 (0x07). H3 is the server's
    // Unconnected Pong (0x1c), H4 covers in-game packets.
    p.h1 = '5';
    p.h2 = '6';
    p.h3 = '28';
    p.h4 = '128-141';
  } else {
    // Java-like surface values: legacy ping and nearby bytes.
    p.h1 = '254';
    p.h2 = '253';
    p.h3 = '252';
    p.h4 = '248-251';
  }

  // CPS signatures.
  const identityRng = makeRng([
    opts.seed,
    opts.profile,
    opts.version,
    opts.mode,
    opts.mtu,
    ip,
    opts.port,
    'raknet-identity',
  ].join('|'));
  const packets = opts.profile === 'java'
    ? javaPackets(rng, opts, ip)
    : bedrockPackets(rng, opts, ip, identityRng);
  Object.assign(p, packets);

  // AWG 3.1 extras.
  if (opts.version === 3) {
    const t = mode.timings;
    // The header protection key is a secret: never derive it from a short seed.
    p.header_protection_key = base64FromBytes(randomBytesCrypto(32));
    p.content_padding_addition = mode.padding;
    p.random_trailers = opts.mode === 'fast' ? 'off' : 'on';
    p.disable_cookies = 'on';
    p.rekey_after_time = t.rekeyAfter;
    p.rekey_timeout = t.rekeyTimeout;
    p.reject_after_time = t.rejectAfter;
    p.keepalive_timeout = t.keepaliveTimeout;
    p.max_handshake_attempts = t.maxAttempts;
    p.keepalive = t.keepalive;
  } else {
    p.keepalive = '25';
  }

  const ipkts = I_META[opts.profile].map(([key, desc]) => ({
    key: key.toUpperCase(),
    desc,
    cps: p[key],
    size: cpsSize(p[key]),
  }));

  const result = {
    opts: { ...opts, ip },
    params: p,
    sizes: {
      init: 148 + p.s1,
      response: 92 + p.s2,
      cookie: 64 + p.s3,
      s4: p.s4,
    },
    ipkts,
    warnings: [],
  };
  result.checks = buildChecks(result);
  result.warnings = buildWarnings(result, warnings);
  return result;
}

function makeS(rng, opts) {
  if (opts.version === 3) {
    if (opts.mode === 'fast') {
      // RandomTrailers is off, so distinct S1-S4 remove the constant
      // WireGuard-shaped 56-byte delta between Init and Response.
      const values = pickDistinct(rng, 12, 20, 4);
      return { s1: values[0], s2: values[1], s3: values[2], s4: values[3] };
    }

    // RandomTrailers is on. Its receive path relaxes the length check to
    // ">= expected", so upstream requires equal values or random trailers
    // make packet-type detection unreliable. Header Protection itself only
    // requires S1-S4 >= 12; equality is a RandomTrailers requirement.
    const range = opts.mode === 'stealth' ? [24, 32] : [16, 28];
    const base = randInt(rng, range[0], range[1]);
    return { s1: base, s2: base, s3: base, s4: base };
  }

  let s1;
  let s2;
  let s3;
  let s4;
  if (opts.mode === 'fast') {
    s1 = randInt(rng, 16, 40);
    s2 = randInt(rng, 16, 40);
    s3 = randInt(rng, 8, 20);
    s4 = randInt(rng, 0, 12);
  } else if (opts.mode === 'stealth') {
    s1 = randInt(rng, 72, 140);
    s2 = randInt(rng, 72, 140);
    s3 = randInt(rng, 24, 64);
    s4 = randInt(rng, 20, 32);
  } else {
    s1 = randInt(rng, 40, 88);
    s2 = randInt(rng, 40, 88);
    s3 = randInt(rng, 16, 44);
    s4 = randInt(rng, 8, 24);
  }

  // S1 + 56 must not equal S2, otherwise the two packet types collide.
  if (s2 === s1 + 56) s2 = s2 < 1188 ? s2 + 1 : s2 - 1;

  return {
    s1: Math.min(s1, 1132),
    s2: Math.min(s2, 1188),
    s3: Math.min(s3, 1216),
    s4: Math.min(s4, 32),
  };
}

function bedrockPackets(rng, opts, ip, identityRng) {
  const request1Size = Math.min(1400, Math.max(548, opts.mtu - 28));
  const request2Mtu = request1Size + 28;
  const clientGuid = bytesToHex(randomBytesFromRng(identityRng, 8));
  const zeroPadding = '00'.repeat(Math.max(0, request1Size - 18));

  // The client GUID is stable across the ping and connection request.
  const i1 = `<b 0x01><r 8><b 0x${MAGIC}><b 0x${clientGuid}>`;

  // Request 1's UDP payload is MTU minus the 20-byte IPv4 and 8-byte UDP headers.
  const i2 = `<b 0x05><b 0x${MAGIC}><b 0x0b><b 0x${zeroPadding}>`;

  // Request 2 advertises Request 1's UDP payload size plus IPv4/UDP headers.
  const i3 = `<b 0x07><b 0x${MAGIC}><b 0x04><b 0x${ipv4Hex(ip)}><b 0x${u16be(opts.port)}><b 0x${u16be(request2Mtu)}><b 0x${clientGuid}>`;

  // Frame Set + sequence + unreliable encapsulated frame. The payload is
  // opaque sample data, not a valid encrypted Minecraft session.
  const base = opts.mode === 'fast' ? [64, 160] : opts.mode === 'stealth' ? [192, 448] : [128, 288];
  const cap = Math.max(48, opts.mtu - 40);
  const n4 = Math.min(cap, randInt(rng, base[0], base[0] + 64));
  const n5 = Math.min(cap, randInt(rng, base[1], base[1] + 128));
  const i4 = `<b 0x84><b 0x${u24le(0)}><b 0x00><b 0x${u16be(n4 * 8)}><r ${n4}>`;
  const i5 = `<b 0x84><b 0x${u24le(1)}><b 0x00><b 0x${u16be(n5 * 8)}><r ${n5}>`;

  return { i1, i2, i3, i4, i5 };
}

function javaPackets(rng, opts, ip) {
  // Java's actual transport is TCP. These are byte-level decoys, not a
  // transport-compatible imitation. The host is deliberately a placeholder.
  const host = 'mc.example.com';
  const protocol = JAVA_PROTOCOL;
  const legacy = javaLegacyPingHex(host, opts.port);
  const handshake = javaHandshakeHex(host, opts.port, protocol);
  const status = '0100'; // frame length 1, packet id 0x00
  const ping = javaStatusPingHex(rng);
  const secondPing = javaStatusPingHex(rng);

  return {
    i1: `<b 0x${legacy}>`,
    i2: `<b 0x${handshake}>`,
    i3: `<b 0x${status}>`,
    i4: `<b 0x${ping}>`,
    i5: `<b 0x${secondPing}>`,
  };
}

function javaLegacyPingHex(host, port) {
  // 1.6 legacy ping: FE 01 FA, channel length/name, payload length,
  // protocol 74, host length (chars), host (UTF-16BE), port (u32 BE).
  return 'fe01fa' +
    '000b' + utf16beHex('MC|PingHost') +
    u16be(7 + host.length * 2) +
    '4a' +
    u16be(host.length) + utf16beHex(host) +
    u32be(port);
}

function javaHandshakeHex(host, port, protocol) {
  const hostBytes = utf8Bytes(host);
  const body = varintHex(0x00) +
    varintHex(protocol) +
    varintHex(hostBytes.length) + bytesToHex(hostBytes) +
    u16be(port) +
    varintHex(1); // next state: status
  return varintHex(body.length / 2) + body;
}

function javaStatusPingHex(rng) {
  const body = varintHex(0x01) + bytesToHex(randomBytesFromRng(rng, 8));
  return varintHex(body.length / 2) + body;
}

/* ---------------- CPS parsing / validation ---------------- */

function cpsSize(s) {
  let i = 0;
  let total = 0;
  while (i < s.length) {
    const m = s.slice(i).match(/^<([a-z]+)(?:\s+([^>]*))?>/i);
    if (!m) throw new Error('CPS: неизвестный тег в позиции ' + i);
    const tag = m[1].toLowerCase();
    const arg = (m[2] || '').trim();

    if (tag === 't') {
      total += 4;
    } else if (tag === 'b') {
      const hex = arg.replace(/^0x/i, '');
      if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
        throw new Error('CPS: некорректный тег <b>');
      }
      total += hex.length / 2;
    } else if (tag === 'r' || tag === 'rc' || tag === 'rd') {
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 0 || n > 1000) {
        throw new Error(`CPS: некорректный размер <${tag}>`);
      }
      total += n;
    } else {
      throw new Error('CPS: неизвестный тег <' + tag + '>');
    }
    i += m[0].length;
  }
  return total;
}

function parseHRange(v) {
  const m = String(v).trim().match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a > b) return null;
  return [a, b];
}

function rangesOverlap(a, b) {
  return a[0] <= b[1] && b[0] <= a[1];
}

function buildChecks(r) {
  const p = r.params;
  const o = r.opts;
  const out = [];
  const add = (ok, text, detail = '') => out.push({ ok: !!ok, text, detail });

  add(p.jc >= 1 && p.jc <= 128, 'Jc в диапазоне 1–128', `Jc = ${p.jc}`);
  add(
    p.jmin >= 0 && p.jmin < p.jmax && p.jmax + 28 <= o.mtu,
    'Jmin < Jmax, junk-пакеты влезают в MTU',
    `${p.jmin} < ${p.jmax}; ${p.jmax} + 28 ≤ ${o.mtu}`,
  );

  const sLimits = [
    ['S1', p.s1, 1132],
    ['S2', p.s2, 1188],
    ['S3', p.s3, 1216],
    ['S4', p.s4, 32],
  ];
  add(
    sLimits.every(([, value, max]) => value >= 0 && value <= max),
    'S1–S4 в допустимых пределах',
    sLimits.map(([name, value, max]) => `${name}=${value}≤${max}`).join(' · '),
  );

  add(
    p.s1 + 56 !== p.s2,
    'S1 + 56 ≠ S2',
    `${p.s1} + 56 = ${p.s1 + 56}, S2 = ${p.s2}`,
  );

  add(
    p.s3 !== p.s2 + 28,
    'S3 ≠ S2 + 28',
    `${p.s2} + 28 = ${p.s2 + 28}, S3 = ${p.s3}`,
  );

  add(
    p.s3 !== p.s1 + 84,
    'S3 ≠ S1 + 84',
    `${p.s1} + 84 = ${p.s1 + 84}, S3 = ${p.s3}`,
  );

  const hRanges = ['h1', 'h2', 'h3', 'h4'].map((k) => parseHRange(p[k]));
  const hParsed = hRanges.every(Boolean);
  let hOverlap = false;
  if (hParsed) {
    for (let i = 0; i < hRanges.length; i++) {
      for (let j = i + 1; j < hRanges.length; j++) {
        if (rangesOverlap(hRanges[i], hRanges[j])) hOverlap = true;
      }
    }
  }
  add(
    hParsed && !hOverlap,
    'H1–H4 корректны и не пересекаются',
    hParsed
      ? hRanges.map((x, i) => `H${i + 1}=${x[0] === x[1] ? x[0] : `${x[0]}-${x[1]}`}`).join(' · ')
      : 'не удалось разобрать одно из значений',
  );

  if (o.version === 3) {
    const sValues = [p.s1, p.s2, p.s3, p.s4];
    add(
      sValues.every((x) => x >= 12),
      'S1–S4 ≥ 12 для Header Protection',
      `S1..S4 = ${sValues.join(', ')}`,
    );
    if (p.random_trailers === 'on') {
      add(
        new Set(sValues).size === 1,
        'S1–S4 совпадают при RandomTrailers = on',
        'разные значения ломают определение типа пакета в receive-path',
      );
    } else {
      add(
        new Set(sValues).size === 4,
        'S1–S4 различны при RandomTrailers = off',
        'убирает постоянную разницу Init/Response в 56 байт',
      );
    }

    const rekey = parseHRange(p.rekey_after_time);
    const rekeyTimeout = parseHRange(p.rekey_timeout);
    const reject = parseHRange(p.reject_after_time);
    const keepaliveTimeout = parseHRange(p.keepalive_timeout);
    const timingsParsed = [rekey, rekeyTimeout, reject, keepaliveTimeout].every(Boolean);
    const timingsOrdered = timingsParsed &&
      rekey[1] < reject[0] - keepaliveTimeout[0] - rekeyTimeout[0];
    add(
      timingsOrdered,
      'RekeyAfterTime раньше RejectAfterTime с запасом',
      `RekeyAfterTime=${p.rekey_after_time}, RejectAfterTime=${p.reject_after_time}, ` +
        `KeepaliveTimeout=${p.keepalive_timeout}, RekeyTimeout=${p.rekey_timeout}`,
    );
  } else {
    add(
      hParsed && hRanges.every((x) => x[0] >= 5),
      'H1–H4 ≥ 5 для AWG 2.0',
      'значения 1–4 зарезервированы под стандартный WireGuard',
    );
  }

  const oversized = r.ipkts.filter((x) => x.size > o.mtu - 28);
  add(
    oversized.length === 0,
    'I1–I5 не превышают MTU − 28',
    r.ipkts.map((x) => `${x.key}=${x.size}`).join(' · ') + `; лимит ${o.mtu - 28}`,
  );
  if (o.profile === 'bedrock') {
    const i2 = r.ipkts.find((x) => x.key === 'I2');
    const i3Fields = [...p.i3.matchAll(/<b 0x([0-9a-f]+)>/gi)];
    const advertisedMtu = i3Fields.length >= 2 ? Number.parseInt(i3Fields[i3Fields.length - 2][1], 16) : null;
    const expectedI2 = Math.min(1400, Math.max(548, o.mtu - 28));
    const expectedMtu = expectedI2 + 28;
    add(
      !!i2 && i2.size === expectedI2 && advertisedMtu === expectedMtu,
      'RakNet Request 1 и Request 2 согласуют MTU',
      `I2=${i2?.size ?? 'нет'} B; MTU в I3=${advertisedMtu ?? 'нет'} B; ожидается ${expectedMtu} B`,
    );
  }

  return out;
}

function buildWarnings(r, initial) {
  const o = r.opts;
  const out = [...initial];

  if (o.profile === 'java') {
    out.push('Профиль Java почти бесполезен как самостоятельная маскировка: Java Edition работает по TCP, а туннель — UDP. Это только поверхностная имитация байтовых сигнатур; DPI, проверяющий транспорт, всё равно увидит подмену.');
  }
  if (o.profile === 'bedrock' && o.port !== 19132 && o.port !== 19133) {
    out.push(`Endpoint слушает UDP ${o.port}, а не 19132/19133. Совпадение с Minecraft Bedrock будет слабее: DPI видит нестандартный порт.`);
  }
  if (o.profile === 'bedrock' && (o.port === 19132 || o.port === 19133)) {
    out.push('Порт 19132/19133 может быть занят настоящим Minecraft-сервером. Для маскировки используйте отдельный IP или NAT, чтобы не конфликтовать.');
  }
  if (o.profile === 'bedrock') {
    out.push('Профиль формирует начальные RakNet/UDP-пакеты, а не NetherNet/WebRTC и его сигнализацию. Если целевой Minecraft-сервер использует NetherNet, этот профиль не совпадает с его начальным обменом.');
    out.push('I1 оставляет 8 случайных байт вместо осмысленного значения поля времени. Источники по RakNet трактуют это поле по-разному (время работы клиента или Unix-время), поэтому здесь показана только форма пакета, а не корректный живой ping.');
  }
  out.push('CPS-пакеты I1–I5 отправляются подряд клиентом перед AWG-handshake, без ответов RakNet между ними. Поэтому последовательность Ping → Request 1 → Request 2 → Data не соответствует полноценной Minecraft-сессии; AWG-сервер не отвечает Pong/Reply.');
  out.push('I1–I5 и J-пакеты отправляются перед каждым AWG-рукопожатием — первым и повторными, — но не перед каждым пакетом данных. RekeyAfterTime в AWG 3.1 задаёт временной порог для rekey; точное расписание зависит от работы туннеля. Затем идёт AWG/WireGuard-трафик: S4, ContentPaddingAddition и RandomTrailers меняют его оформление, но не превращают его в игровой RakNet-сеанс.');
  if (o.version === 2) {
    out.push('AWG 2.0 использует заданные значения/диапазоны H1–H4 без Header Protection. Версия 3.1 с HeaderProtectionKey дополнительно скрывает служебные поля.');
  } else {
    out.push('HeaderProtectionKey создаётся криптографически случайным при каждой генерации и не повторяется по seed. Сервер и клиент должны использовать один и тот же ключ.');
    out.push('DisableCookies = on отключает отправку Cookie Reply и ослабляет защиту от handshake-флуда. На публичном сервере используйте этот параметр только если осознанно принимаете этот риск.');
    if (r.params.random_trailers === 'on') {
      out.push('RandomTrailers вместе с S1–S4/Jc/I может заметно снижать скорость в текущих сборках amneziawg-go. Если туннель медленный, выберите режим Fast или отключите RandomTrailers.');
    }
  }
  if (o.mtu > 1420) {
    out.push('MTU больше 1420 может фрагментироваться на части провайдеров. Jmax и I-пакеты уже ограничены, но проверьте путь до сервера.');
  }
  out.push('S1–S4 и H1–H4 должны совпадать на клиенте и сервере. Jc, Jmin, Jmax и I1–I5 — клиентские параметры, но их можно продублировать без вреда.');
  out.push('I1–I5 — снимок протокола. После крупного обновления Minecraft или изменения DPI сигнатуры стоит перегенерировать.');
  out.push('Генератор не гарантирует обход DPI: он лишь делает профиль трафика ближе к Minecraft. Проверяйте на своём провайдере.');

  return [...new Set(out)];
}

/* ---------------- Text builders ---------------- */

function buildClientConf(r) {
  const p = r.params;
  const o = r.opts;
  const profile = PROFILES[o.profile];
  const lines = [
    `# Mimicry Generator · ${profile.label} · AWG ${o.version}.x`,
    `# mode: ${MODE_LABELS[o.mode]} · seed: ${safeCommentValue(o.seed)}`,
    '# S1-S4 и H1-H4 должны совпадать с сервером.',
    '',
    '[Interface]',
    'PrivateKey = <PRIVATE_KEY>',
    'Address = 10.8.0.2/32',
    'DNS = 1.1.1.1',
    `MTU = ${o.mtu}`,
    '',
    '# --- обфускация ---',
    `Jc = ${p.jc}`,
    `Jmin = ${p.jmin}`,
    `Jmax = ${p.jmax}`,
    `S1 = ${p.s1}`,
    `S2 = ${p.s2}`,
    `S3 = ${p.s3}`,
    `S4 = ${p.s4}`,
    `H1 = ${p.h1}`,
    `H2 = ${p.h2}`,
    `H3 = ${p.h3}`,
    `H4 = ${p.h4}`,
    '',
    '# --- сигнатуры перед рукопожатием (клиент) ---',
    `I1 = ${p.i1}`,
    `I2 = ${p.i2}`,
    `I3 = ${p.i3}`,
    `I4 = ${p.i4}`,
    `I5 = ${p.i5}`,
  ];

  if (o.version === 3) {
    lines.push(
      '',
      '# --- AWG 3.1 ---',
      `HeaderProtectionKey = ${p.header_protection_key}`,
      `ContentPaddingAddition = ${p.content_padding_addition}`,
      `RandomTrailers = ${p.random_trailers}`,
      '# DisableCookies = on отключает Cookie Reply и ослабляет защиту от handshake-флуда.',
      `DisableCookies = ${p.disable_cookies}`,
      `RekeyAfterTime = ${p.rekey_after_time}`,
      `RekeyTimeout = ${p.rekey_timeout}`,
      `RejectAfterTime = ${p.reject_after_time}`,
      `KeepaliveTimeout = ${p.keepalive_timeout}`,
      `MaxHandshakeAttempts = ${p.max_handshake_attempts}`,
    );
  }

  lines.push(
    '',
    '[Peer]',
    'PublicKey = <SERVER_PUBLIC_KEY>',
    'PresharedKey = <PRESHARED_KEY>',
    `Endpoint = <SERVER_HOST>:${o.port}`,
    'AllowedIPs = 0.0.0.0/0, ::/0',
    `PersistentKeepalive = ${p.keepalive}`,
    '',
    '# Для Bedrock endpoint обычно слушает UDP 19132/19133.',
    '# Для Java профиль остаётся UDP-туннелем: это только имитация байтов.',
  );

  return lines.join('\n');
}

function buildServerConf(r) {
  const p = r.params;
  const o = r.opts;
  const lines = [
    `# Mimicry Generator · server side · AWG ${o.version}.x`,
    '# S1-S4 и H1-H4 должны совпадать с клиентом.',
    '',
    '[Interface]',
    'PrivateKey = <SERVER_PRIVATE_KEY>',
    'Address = 10.8.0.1/24',
    `ListenPort = ${o.port}`,
    `MTU = ${o.mtu}`,
    '',
    '# --- общие параметры ---',
    `S1 = ${p.s1}`,
    `S2 = ${p.s2}`,
    `S3 = ${p.s3}`,
    `S4 = ${p.s4}`,
    `H1 = ${p.h1}`,
    `H2 = ${p.h2}`,
    `H3 = ${p.h3}`,
    `H4 = ${p.h4}`,
  ];

  if (o.version === 3) {
    lines.push(
      '',
      '# --- AWG 3.1 ---',
      `HeaderProtectionKey = ${p.header_protection_key}`,
      `ContentPaddingAddition = ${p.content_padding_addition}`,
      `RandomTrailers = ${p.random_trailers}`,
      '# DisableCookies = on отключает Cookie Reply и ослабляет защиту от handshake-флуда.',
      `DisableCookies = ${p.disable_cookies}`,
    );
  }

  lines.push(
    '',
    '# Jc, Jmin, Jmax и I1-I5 — клиентские: на сервере их можно не задавать.',
    '',
    '[Peer]',
    'PublicKey = <CLIENT_PUBLIC_KEY>',
    'PresharedKey = <PRESHARED_KEY>',
    'AllowedIPs = 10.8.0.2/32',
    '',
    '# Если на этом же IP уже работает Minecraft-сервер, используйте другой IP',
    '# или NAT: два процесса не могут слушать один UDP-порт.',
  );

  return lines.join('\n');
}

function buildPanelJson(r) {
  const p = r.params;
  const o = r.opts;

  // Формат endpoint'а sing-box / amnezia-box: именно его разбирает импортёр
  // панели (importer.ParseAWGJSON): плоские поля awg + peers[].
  const node = {
    type: 'awg',
    tag: `${PROFILES[o.profile].label} mimicry`,
    private_key: '<PRIVATE_KEY>',
    address: ['10.8.0.2/32'],
    mtu: o.mtu,
    // persistent_keepalive_interval намеренно не задаётся: панель подставит
    // своё целое 25 (оно входит во все диапазоны генератора). Так шаблон
    // импортируется и в старые сборки панели, которые передавали строку в
    // объявленное как uint16 поле amnezia-box.
    peers: [{
      address: o.ip,
      port: o.port,
      public_key: '<SERVER_PUBLIC_KEY>',
      preshared_key: '<PRESHARED_KEY>',
      allowed_ips: ['0.0.0.0/0', '::/0'],
    }],
    jc: p.jc,
    jmin: p.jmin,
    jmax: p.jmax,
    s1: p.s1,
    s2: p.s2,
    s3: p.s3,
    s4: p.s4,
    h1: p.h1,
    h2: p.h2,
    h3: p.h3,
    h4: p.h4,
    i1: p.i1,
    i2: p.i2,
    i3: p.i3,
    i4: p.i4,
    i5: p.i5,
  };

  if (o.version === 3) {
    Object.assign(node, {
      header_protection_key: p.header_protection_key,
      content_padding_addition: p.content_padding_addition,
      disable_cookies: p.disable_cookies === 'on',
      random_trailers: p.random_trailers === 'on',
      keepalive_timeout: p.keepalive_timeout,
      max_handshake_attempts: p.max_handshake_attempts,
      reject_after_time: p.reject_after_time,
      rekey_after_time: p.rekey_after_time,
      rekey_timeout: p.rekey_timeout,
    });
  }

  return JSON.stringify(node, null, 2);
}

/* ---------------- Rendering ---------------- */

function generateAndRender() {
  try {
    const opts = readOptions();
    const result = generate(opts);
    render(result);
  } catch (e) {
    console.error(e);
    toast('Ошибка генерации: ' + e.message, 'err');
  }
}

function readOptions() {
  let seed = $('#seed').value.trim();
  if (!seed) {
    seed = randomSeed();
    $('#seed').value = seed;
  }

  const profile = $('#profile').value;
  const version = Number($('#version').value) === 2 ? 2 : 3;
  const mode = MODES[$('#mode').value] ? $('#mode').value : 'balanced';
  const mtu = clampInt($('#mtu').value, 576, 1500, 1280);
  const port = clampInt($('#serverPort').value, 1, 65535, PROFILES[profile].defaultPort);

  return {
    seed,
    profile,
    version,
    mode,
    mtu,
    port,
    ip: $('#serverIp').value.trim(),
  };
}

function clampInt(value, min, max, fallback) {
  const text = String(value).trim();
  if (!text) return fallback;
  const n = Number(text);
  if (!Number.isSafeInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function render(r) {
  last = r;
  const o = r.opts;
  const p = r.params;
  const totalI = r.ipkts.reduce((acc, x) => acc + x.size, 0);

  $('#empty').hidden = true;
  $('#output').hidden = false;

  $('#outTitle').textContent = PROFILES[o.profile].label;
  $('#outSub').textContent = [
    `AWG ${o.version}.x`,
    MODE_LABELS[o.mode],
    `MTU ${o.mtu}`,
    `${PROFILES[o.profile].transport} ${o.port}`,
  ].join(' · ');
  $('#seedOut').textContent = o.seed;
  $('#seedOut').title = o.seed;

  $('#stats').innerHTML = [
    stat(String(p.jc), 'junk-пакетов'),
    stat(`${r.sizes.init} B`, `Init base · S1=${p.s1}`),
    stat(`${r.sizes.response} B`, `Response base · S2=${p.s2}`),
    stat(`${totalI} B`, `I1–I5 · ${r.ipkts.length} шт.`),
  ].join('');

  $('#params').innerHTML = renderParams(r);
  $('#checks').innerHTML = renderChecks(r.checks);

  const texts = {
    client: buildClientConf(r),
    server: buildServerConf(r),
    json: buildPanelJson(r),
  };
  r.texts = texts;

  $('#clientPre').textContent = texts.client;
  $('#serverPre').textContent = texts.server;
  $('#jsonPre').textContent = texts.json;
  $('#packets').innerHTML = renderPackets(r);
  $('#warnings').innerHTML = r.warnings
    .map((w) => `<div class="warning"><span class="mark">!</span><span>${esc(w)}</span></div>`)
    .join('');

  // Keep the active tab if one is selected; otherwise show parameters.
  const active = $('.tab.active');
  if (active) selectTab(active.dataset.tab);
}

function stat(value, label) {
  return `<div class="stat"><b title="${esc(value)}">${esc(value)}</b><span>${esc(label)}</span></div>`;
}

function renderParams(r) {
  const p = r.params;
  const o = r.opts;

  const groups = [
    {
      title: 'Junk-пакеты',
      note: 'клиент',
      rows: [
        ['Jc', p.jc],
        ['Jmin', p.jmin],
        ['Jmax', p.jmax],
      ],
    },
    {
      title: 'Padding',
      note: 'общее',
      rows: [
        ['S1', p.s1],
        ['S2', p.s2],
        ['S3', p.s3],
        ['S4', p.s4],
      ],
    },
    {
      title: 'Заголовки',
      note: 'общее',
      rows: [
        ['H1', p.h1],
        ['H2', p.h2],
        ['H3', p.h3],
        ['H4', p.h4],
      ],
    },
    {
      title: 'Сигнатуры',
      note: 'клиент',
      wide: true,
      rows: [
        ['I1', p.i1],
        ['I2', p.i2],
        ['I3', p.i3],
        ['I4', p.i4],
        ['I5', p.i5],
      ],
    },
  ];

  if (o.version === 3) {
    groups.push({
      title: 'AWG 3.1',
      note: 'общее / клиент',
      wide: true,
      rows: [
        ['HeaderProtectionKey', p.header_protection_key],
        ['ContentPaddingAddition', p.content_padding_addition],
        ['RandomTrailers', p.random_trailers],
        ['DisableCookies', p.disable_cookies],
        ['RekeyAfterTime', p.rekey_after_time],
        ['RekeyTimeout', p.rekey_timeout],
        ['RejectAfterTime', p.reject_after_time],
        ['KeepaliveTimeout', p.keepalive_timeout],
        ['MaxHandshakeAttempts', p.max_handshake_attempts],
      ],
    });
  }

  groups.push({
    title: 'Peer',
    note: 'клиент',
    rows: [['PersistentKeepalive', p.keepalive]],
  });

  return `<div class="params-grid">${groups.map((group) => {
    const rows = group.rows.map(([key, value]) => {
      const text = String(value);
      const isLong = text.length > 46;
      return `<div class="kv"><span>${esc(key)}</span><code class="${isLong ? 'long' : ''}" title="${esc(text)}">${esc(text)}</code></div>`;
    }).join('');
    return `<section class="param-group${group.wide ? ' wide' : ''}">
      <h3>${esc(group.title)}${group.note ? ` <span class="muted2">· ${esc(group.note)}</span>` : ''}</h3>
      ${rows}
    </section>`;
  }).join('')}</div>`;
}

function renderChecks(checks) {
  return checks.map((c) => `<div class="check${c.ok ? '' : ' bad'}">
    <span class="mark">${c.ok ? '✓' : '!'}</span>
    <span>${esc(c.text)}${c.detail ? ` <span class="detail">${esc(c.detail)}</span>` : ''}</span>
  </div>`).join('');
}

function renderPackets(r) {
  const p = r.params;
  const o = r.opts;
  const hasRandomTrailers = o.version === 3 && p.random_trailers === 'on';
  const cookiesDisabled = o.version === 3 && p.disable_cookies === 'on';
  const max = Math.max(o.mtu, r.sizes.init, r.sizes.response, r.sizes.cookie, p.jmax);

  const bar = (label, size, text, cls = '') => {
    const width = Math.max(2, Math.min(100, (size / max) * 100));
    return `<div class="bar-row"><span>${esc(label)}</span><div class="bar ${cls}"><i style="width:${width.toFixed(1)}%"></i></div><b>${esc(text)}</b></div>`;
  };

  const packets = r.ipkts.map((x) => `<div class="packet" title="${esc(x.cps)}">
    <span class="tag">${esc(x.key)}</span>
    <div class="desc">${esc(x.desc)}<code>${esc(shorten(x.cps, 108))}</code></div>
    <span class="size">${x.size} B</span>
  </div>`).join('');

  const totalI = r.ipkts.reduce((acc, x) => acc + x.size, 0);

  return `
    <div class="packet-list">${packets}</div>
    <div class="bars">
      <h3>${hasRandomTrailers ? 'Базовые размеры handshake (без случайных trailer)' : 'Базовые размеры handshake'}</h3>
      ${bar('Init base', r.sizes.init, `${r.sizes.init} B`)}
      ${bar('Response base', r.sizes.response, `${r.sizes.response} B`)}
      ${bar(cookiesDisabled ? 'Cookie Reply (disabled)' : 'Cookie Reply base', r.sizes.cookie, `${r.sizes.cookie} B`, 'dim')}
      ${bar('Junk max', p.jmax, `${p.jmin}–${p.jmax} B`, 'alt')}
    </div>
    <p class="muted small" style="margin:10px 0 0">
      I1–I5: ${totalI} B суммарно, ${r.ipkts.length} пакетов. Data base: payload + S4 (${p.s4} B); AWG 3 padding/trailer может добавить байты.
      Масштаб полос — до ${max} B; длины handshake показаны без случайного trailer.
      I1–I5 уходят только от клиента: сервер не отвечает такими же RakNet-пакетами.
    </p>`;
}

function shorten(s, n) {
  const text = String(s);
  return text.length > n ? text.slice(0, n - 1) + '…' : text;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function safeCommentValue(s) {
  return String(s).replace(/[\u0000-\u001f\u007f]/g, (ch) => {
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

/* ---------------- UI actions ---------------- */

function selectTab(name) {
  $$('.tab').forEach((btn) => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  $$('.tabpane').forEach((pane) => {
    pane.classList.toggle('active', pane.id === 'pane-' + name);
  });
}

function updateProfileHint() {
  const profile = PROFILES[$('#profile').value] || PROFILES.bedrock;
  $('#profileHint').textContent = profile.hint;
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      throw new Error('clipboard unavailable');
    }
    toast('Скопировано в буфер обмена');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    toast(ok ? 'Скопировано в буфер обмена' : 'Не удалось скопировать — выделите текст вручную', ok ? 'ok' : 'err');
  }
}

function downloadText(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type: type + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Файл скачан: ' + filename);
}

function toast(message, kind = 'ok') {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'toast' + (kind === 'err' ? ' err' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2800);
}

function bind() {
  $('#generate').addEventListener('click', generateAndRender);

  $('#newSeed').addEventListener('click', () => {
    $('#seed').value = randomSeed();
    generateAndRender();
  });

  $('#seed').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') generateAndRender();
  });

  $('#profile').addEventListener('change', () => {
    updateProfileHint();
    const port = $('#serverPort');
    const profile = $('#profile').value;
    if (profile === 'java' && port.value === '19132') port.value = '25565';
    if (profile === 'bedrock' && port.value === '25565') port.value = '19132';
  });

  $('#copySeed').addEventListener('click', () => {
    if (last) copyText(last.opts.seed);
  });

  $$('.tab').forEach((btn) => {
    btn.addEventListener('click', () => selectTab(btn.dataset.tab));
  });

  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;

    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      const kind = copyBtn.dataset.copy;
      if (last && last.texts && last.texts[kind]) {
        copyText(last.texts[kind]);
      } else {
        toast('Сначала сгенерируйте параметры', 'err');
      }
      return;
    }

    const downloadBtn = e.target.closest('[data-download]');
    if (downloadBtn) {
      const kind = downloadBtn.dataset.download;
      if (!last || !last.texts || !last.texts[kind]) {
        toast('Сначала сгенерируйте параметры', 'err');
        return;
      }
      const names = {
        client: 'amneziawg-minecraft-client.conf',
        server: 'amneziawg-minecraft-server.conf',
        json: 'amneziawg-minecraft.json',
      };
      downloadText(names[kind] || 'amneziawg-minecraft.txt', last.texts[kind], kind === 'json' ? 'application/json' : 'text/plain');
    }
  });
}

function init() {
  updateProfileHint();
  bind();
  generateAndRender();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
