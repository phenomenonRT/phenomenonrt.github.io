'use strict';

/* ============================================================
   Mimicry Generator — AmneziaWG × GTA V
   Vanilla JS, no dependencies, works from file://
   ============================================================ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const OOB = 'ffffffff'; // connectionless prefix: FiveM writes the int -1 (NetLibrary::SendOutOfBand)
const FIVEM_ENET_MTU = 1300; // g_maxMtu in NetLibraryImplV2.cpp: the client's ENet host MTU
const MSG_END = 0xca569e63; // HashRageString("msgEnd"): keepalive sent every 100 ms on channel 1

const PROFILES = {
  fivem: {
    label: 'GTA V · FiveM (ENet / Q3 OOB)',
    short: 'FiveM / ENet',
    transport: 'UDP',
    defaultPort: 30120,
    hint: 'Профиль повторяет последовательность клиента FiveM по UDP 30120 (сверено с исходниками citizenfx/fivem): getinfo xyz, ENet CONNECT, первый reliable-пакет, msgEnd/msgRoute. Игровой payload случайный; AWG-сервер не отвечает как FiveM-сервер.',
  },
  gtao: {
    label: 'GTA Online (opaque UDP)',
    short: 'GTA Online / opaque',
    transport: 'UDP',
    defaultPort: 6672,
    hint: 'Протокол GTA Online закрытый и шифрованный. Профиль повторяет только размеры датаграмм и порт (обычно UDP 6672), поэтому это слабая имитация.',
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
  fivem: [
    ['i1', 'OOB getinfo xyz · FF FF FF FF'],
    ['i2', 'ENet CONNECT · 0x82 · MTU 1300'],
    ['i3', 'ENet SEND_RELIABLE · ch 0 · token/guid'],
    ['i4', 'ENet SEND_UNSEQUENCED · ch 1 · msgEnd'],
    ['i5', 'ENet SEND_UNRELIABLE · ch 1 · msgRoute'],
  ],
  gtao: [
    ['i1', 'Opaque datagram · small'],
    ['i2', 'Opaque datagram · medium'],
    ['i3', 'Opaque datagram · large'],
    ['i4', 'Opaque datagram · game-sized'],
    ['i5', 'Opaque datagram · game-sized'],
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

function u32be(n) {
  const x = n >>> 0;
  return [x >>> 24, x >>> 16, x >>> 8, x].map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
}

function u16le(n) {
  return [n, n >>> 8].map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
}

function u32le(n) {
  return [n, n >>> 8, n >>> 16, n >>> 24].map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
}

// Jenkins one-at-a-time, case-sensitive. joaat('msgEnd') === 0xCA569E63, the
// msgEnd constant hard-coded in FiveM's NetLibraryImplV2.cpp.
function joaat(str) {
  let h = 0;
  for (const byte of utf8Bytes(str)) {
    h = (h + byte) >>> 0;
    h = (h + (h << 10)) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  }
  h = (h + (h << 3)) >>> 0;
  h = (h ^ (h >>> 11)) >>> 0;
  h = (h + (h << 15)) >>> 0;
  return h;
}

function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}

function asciiHex(str) {
  return Array.from(str, (ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
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
    warnings.push(`IPv4 «${opts.ip}» некорректен — для JSON используется 192.0.2.1.`);
  }
  if (isTestNetIPv4(ip)) {
    warnings.push(`${ip} — адрес из TEST-NET, зарезервированный для документации, а не публичный адрес сервера. Замените его перед импортом JSON и подключением.`);
  }

  const p = {};

  // Junk train: sizes are deliberately in the range of game packets.
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
  } else if (opts.profile === 'fivem') {
    // Heuristic decoys taken from ENet command bytes that FiveM really uses:
    // CONNECT (0x82), VERIFY_CONNECT (0x83), SEND_UNSEQUENCED (0x49) and the
    // acknowledged data commands from 0x86. Nobody parses them as ENet: AWG
    // only uses them as 32-bit message-type values.
    p.h1 = '130';
    p.h2 = '131';
    p.h3 = '73';
    p.h4 = '134-137';
  } else {
    // GTA Online is opaque; these are just distinct values >= 5.
    p.h1 = '200';
    p.h2 = '201';
    p.h3 = '202';
    p.h4 = '203-210';
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
    'gta-identity',
  ].join('|'));
  const packets = opts.profile === 'gtao'
    ? gtaoPackets(rng, opts)
    : fivemPackets(rng, opts, identityRng);
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

function payloadCap(mtu) {
  // UDP payload limit is MTU - 28; the largest FiveM template carries
  // 20 bytes of ENet + msgRoute headers around the random payload.
  return Math.max(48, mtu - 48);
}

// What a FiveM client puts on the wire, in the order its code does it
// (citizenfx/fivem): NetLibrary.cpp sends the connectionless "getinfo xyz"
// (int -1 + text); NetLibraryImplV2.cpp then calls enet_host_connect(host,
// addr, 2 channels, HashString(token)) on a host with MTU 1300 and no
// bandwidth limits, and on connect sends a reliable packet on channel 0:
// int 1 + "token=<uuid>&guid=<uint64>". Channel 1 carries msgRoute
// (unreliable) and the msgEnd keepalive (unsequenced). ENet headers are
// public and big-endian; FiveM's own fields are little-endian. The msgRoute
// payload is random bytes.
function fivemPackets(rng, opts, identityRng) {
  const rawToken = Array.from(randomBytesFromRng(identityRng, 16));
  rawToken[6] = (rawToken[6] & 0x0f) | 0x40; // random UUID v4, as boost::uuids
  rawToken[8] = (rawToken[8] & 0x3f) | 0x80;
  const t = bytesToHex(rawToken);
  const token = `${t.slice(0, 8)}-${t.slice(8, 12)}-${t.slice(12, 16)}-${t.slice(16, 20)}-${t.slice(20)}`;
  const guidBytes = Array.from(randomBytesFromRng(identityRng, 8)).reverse();
  const guid = BigInt('0x' + bytesToHex(guidBytes)).toString(10); // little-endian uint64
  const connectId = bytesToHex(randomBytesFromRng(identityRng, 4));

  // 1. Connectionless query: FF FF FF FF + "getinfo xyz".
  const i1 = `<b 0x${OOB}><b 0x${asciiHex('getinfo xyz')}>`;

  // 2. ENet CONNECT. Header: peerID 0x0FFF | SENT_TIME flag, then sentTime.
  const sentConnect = randInt(rng, 0, 0xffff);
  const connectBody =
    u16be(0) + // outgoingPeerID: index of the client's only peer
    'ff' + 'ff' + // incoming / outgoing session ID
    u32be(FIVEM_ENET_MTU) +
    u32be(65536) + // window size: no bandwidth limit
    u32be(2) + // channel count
    u32be(0) + u32be(0) + // incoming / outgoing bandwidth
    u32be(5000) + // packet throttle interval
    u32be(2) + u32be(2) + // throttle acceleration / deceleration
    connectId +
    u32be(joaat(token)); // data = HashString(token)
  const i2 = `<b 0x${u16be(0x8fff)}><b 0x${u16be(sentConnect)}>` +
    `<b 0x82><b 0xff><b 0x${u16be(1)}><b 0x${connectBody}>`;

  // After VERIFY_CONNECT the datagram header carries the server-assigned
  // peerID and a 2-bit session ID.
  const peerHeader = 0x8000 | (randInt(rng, 0, 3) << 12) | randInt(rng, 0, 63);
  const st3 = randInt(rng, 0, 0xffff);
  const st4 = randInt(rng, 0, 0xffff);
  const st5 = randInt(rng, 0, 0xffff);

  // 3. First reliable packet on channel 0 (ENet SEND_RELIABLE|ACK, seq 1).
  const payload3 = u32le(1) + asciiHex(`token=${token}&guid=${guid}`);
  const i3 = `<b 0x${u16be(peerHeader)}><b 0x${u16be(st3)}>` +
    `<b 0x86><b 0x00><b 0x${u16be(1)}><b 0x${u16be(payload3.length / 2)}>` +
    `<b 0x${payload3}>`;

  // 4. msgEnd keepalive: SEND_UNSEQUENCED (0x09|0x40), channel 1, group 1.
  const i4 = `<b 0x${u16be(peerHeader)}><b 0x${u16be(st4)}>` +
    `<b 0x49><b 0x01><b 0x${u16be(0)}><b 0x${u16be(1)}><b 0x${u16be(4)}>` +
    `<b 0x${u32le(MSG_END)}>`;

  // 5. msgRoute: SEND_UNRELIABLE, channel 1, unreliable seq 1;
  // body = hash(msgRoute) + netID(u16) + size(u16) + payload (random here).
  const base = opts.mode === 'fast' ? [64, 160] : opts.mode === 'stealth' ? [192, 448] : [128, 288];
  const n5 = Math.min(payloadCap(opts.mtu), randInt(rng, base[1], base[1] + 128));
  const netId = randInt(rng, 1, 255);
  const i5 = `<b 0x${u16be(peerHeader)}><b 0x${u16be(st5)}>` +
    `<b 0x07><b 0x01><b 0x${u16be(0)}><b 0x${u16be(1)}><b 0x${u16be(8 + n5)}>` +
    `<b 0x${u32le(joaat('msgRoute'))}><b 0x${u16le(netId)}><b 0x${u16le(n5)}><r ${n5}>`;

  return { i1, i2, i3, i4, i5 };
}

// GTA Online's wire format is closed and encrypted, so only sizes are shaped.
function gtaoPackets(rng, opts) {
  const ranges = opts.mode === 'fast'
    ? [[32, 64], [64, 160], [128, 320], [96, 224], [160, 352]]
    : opts.mode === 'stealth'
      ? [[64, 128], [128, 288], [288, 640], [192, 448], [320, 704]]
      : [[48, 96], [96, 224], [192, 448], [128, 288], [224, 480]];
  const cap = payloadCap(opts.mtu);
  const out = {};
  ranges.forEach(([lo, hi], idx) => {
    out[`i${idx + 1}`] = `<r ${Math.min(cap, randInt(rng, lo, hi))}>`;
  });
  return out;
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
  if (o.profile === 'fivem') {
    const raw = [...p.i2.matchAll(/<b 0x([0-9a-f]+)>/gi)].map((m) => m[1]).join('');
    const enetMtu = raw.length >= 32 ? Number.parseInt(raw.slice(24, 32), 16) : null;
    add(
      enetMtu === FIVEM_ENET_MTU,
      'ENet CONNECT: MTU = 1300, как у клиента FiveM',
      `MTU в I2=${enetMtu ?? 'нет'}; ожидается ${FIVEM_ENET_MTU}`,
    );
    add(
      p.i1 === `<b 0x${OOB}><b 0x${asciiHex('getinfo xyz')}>`,
      'I1 = FF FF FF FF + «getinfo xyz»',
      '',
    );
  }

  return out;
}

function buildWarnings(r, initial) {
  const o = r.opts;
  const out = [...initial];

  if (o.profile === 'fivem') {
    if (o.port !== 30120) {
      out.push(`Endpoint слушает UDP ${o.port}, а не 30120 (порт FiveM по умолчанию). Совпадение слабее: DPI видит нестандартный порт.`);
    } else {
      out.push('Порт 30120 может быть занят настоящим FiveM-сервером. Используйте отдельный IP или NAT, чтобы не конфликтовать.');
    }
    out.push('Профиль повторяет последовательность клиента FiveM по исходникам (getinfo xyz → ENet CONNECT → первый reliable-пакет → msgEnd/msgRoute), но реальный клиент перед этим делает HTTP-запрос initConnect, ждёт ответы сервера и шифрует/упаковывает игровые данные: payload здесь случайный.');
  }
  if (o.profile === 'gtao') {
    if (![6672, 61455, 61456, 61457, 61458].includes(o.port)) {
      out.push(`Endpoint слушает UDP ${o.port}. GTA Online обычно использует UDP 6672 и 61455–61458: совпадение с портом будет слабее.`);
    }
    out.push('Протокол GTA Online закрытый и шифрованный: профиль шаблонами I1–I5 повторяет только размеры датаграмм и порт, а не их структуру. Это слабая имитация.');
  }
  out.push('MTU 1280 работает почти везде; MTU 1352 даёт запас до 1492 (PPPoE) и подходит для IPv6. MTU 1280 снижает риск проблем с размером пакетов, но сам по себе не делает VPN незаметным. Рекомендуется включать RandomTrailers (AWG 3.1).');
  out.push('CPS-пакеты I1–I5 отправляются подряд клиентом перед AWG-handshake, без ответов сервера между ними. Поэтому последовательность не соответствует полноценной сессии GTA V; AWG-сервер не отвечает игровыми пакетами.');
  out.push('I1–I5 и J-пакеты отправляются перед каждым AWG-рукопожатием — первым и повторными, — но не перед каждым пакетом данных. RekeyAfterTime в AWG 3.1 задаёт временной порог для rekey; точное расписание зависит от работы туннеля. Затем идёт AWG/WireGuard-трафик: S4, ContentPaddingAddition и RandomTrailers меняют его оформление, но не превращают его в игровой сеанс GTA V.');
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
  out.push('I1–I5 — снимок протокола. После крупного обновления FiveM/GTA V или изменения DPI сигнатуры стоит перегенерировать.');
  out.push('Генератор не гарантирует обход DPI: он лишь делает профиль трафика ближе к GTA V. Проверяйте на своём провайдере.');

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
    '# Для FiveM endpoint обычно слушает UDP 30120.',
    '# Для GTA Online профиль только повторяет размеры датаграмм (порт 6672).',
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
    '# Если на этом же IP уже работает FiveM/GTA-сервер, используйте другой IP',
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
      I1–I5 уходят только от клиента: сервер не отвечает такими же пакетами.
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
  const profile = PROFILES[$('#profile').value] || PROFILES.fivem;
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
    const defaults = Object.values(PROFILES).map((x) => String(x.defaultPort));
    if (defaults.includes(port.value)) port.value = String(PROFILES[profile].defaultPort);
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
        client: 'amneziawg-gta5-client.conf',
        server: 'amneziawg-gta5-server.conf',
        json: 'amneziawg-gta5.json',
      };
      downloadText(names[kind] || 'amneziawg-gta5.txt', last.texts[kind], kind === 'json' ? 'application/json' : 'text/plain');
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
