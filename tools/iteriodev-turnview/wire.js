'use strict';
/*
 * wire.js - iteriodev-turnview: SOME/IP payloads <-> values, driven by the OAP interface schemas (schemas/*.json,
 * taken from the dump by tools/make_schemas.js): { t, e, k, v, w, n } as the oap-sdk catalogue writes them.
 * Big-endian. Utf8D = u32 byte length + BOM EF BB BF + bytes + NUL (as mediabridge). ArrayD / Map / ByteBuffer = u32
 * byte length + content. Struct = members in order. Union = length (opts.unionLen bytes, 0 = none) + type
 * (opts.unionType bytes; member index + opts.unionBase) + value. Enum = `w` bytes, else opts.enumW.
 * The CommonAPI deployment's widths are not in the schemas: decodeAny tries CANDIDATES and keeps the first that parses
 * a payload to exactly its end with valid enum values (mediaapp took u32 length + u32 type unions:
 * analysis/audio-media-source.md, hence the first candidate).
 *   decode(schema, buf, opts) -> { value, end }   throws on an overrun or an unknown enum value
 *   encode(schema, value, opts) -> Buffer          the mirror (tests, fakes)
 *   decodeAny(schema, buf, candidates) -> { value, opts } | null
 * Values: Struct -> object by member name; Union -> { type: member name, value }; Enum -> its name; UInt64 -> 16 hex
 * digits (Node 8 has no BigInt); ByteBuffer -> hex; Map -> [[k, v], ...]; ArrayD -> array; Utf8D -> string.
 */
const CANDIDATES = [
    { enumW: 1, unionLen: 4, unionType: 4, unionBase: 1 },
    { enumW: 1, unionLen: 4, unionType: 1, unionBase: 1 },
    { enumW: 1, unionLen: 4, unionType: 4, unionBase: 0 },
    { enumW: 4, unionLen: 4, unionType: 4, unionBase: 1 },
    { enumW: 1, unionLen: 0, unionType: 4, unionBase: 1 },
    { enumW: 2, unionLen: 4, unionType: 4, unionBase: 1 },
    { enumW: 1, unionLen: 4, unionType: 2, unionBase: 1 },
];
const DEFAULT = CANDIDATES[0];
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const FIXED = { UInt8: 1, Int8: 1, UInt16: 2, Int16: 2, UInt32: 4, Int32: 4, Float: 4, Double: 8, Bool: 1, UInt64: 8, Int64: 8 };

function uint(buf, pos, n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + buf[pos + i];
    return v;
}
function need(buf, pos, n, end) { if (pos + n > end || pos + n > buf.length) throw new Error(`overrun at ${pos} (+${n})`); }

function read(s, buf, pos, end, o) {
    const t = s.t;
    if (FIXED[t]) {
        const n = FIXED[t];
        need(buf, pos, n, end);
        let v;
        switch (t) {
            case 'UInt8': v = buf[pos]; break;
            case 'Int8': v = buf.readInt8(pos); break;
            case 'UInt16': v = buf.readUInt16BE(pos); break;
            case 'Int16': v = buf.readInt16BE(pos); break;
            case 'UInt32': v = buf.readUInt32BE(pos); break;
            case 'Int32': v = buf.readInt32BE(pos); break;
            case 'Float': v = buf.readFloatBE(pos); break;
            case 'Double': v = buf.readDoubleBE(pos); break;
            case 'Bool': v = buf[pos] !== 0; if (buf[pos] > 1) throw new Error(`bad bool at ${pos}`); break;
            default: v = buf.slice(pos, pos + 8).toString('hex');             // (U)Int64
        }
        return [v, pos + n];
    }
    if (t === 'Enum') {
        const w = s.w || o.enumW;
        need(buf, pos, w, end);
        const v = uint(buf, pos, w), name = Object.keys(s.e).find((k) => s.e[k] === v);
        if (name === undefined) throw new Error(`enum value ${v} unknown at ${pos}`);
        return [name, pos + w];
    }
    if (t === 'Struct') {
        const out = {};
        for (const m of s.e) { const r = read(m, buf, pos, end, o); out[m.n] = r[0]; pos = r[1]; }
        return [out, pos];
    }
    if (t === 'Union') {
        let stop = end;
        if (o.unionLen) { need(buf, pos, o.unionLen, end); stop = pos + o.unionLen + o.unionType + uint(buf, pos, o.unionLen); pos += o.unionLen; }
        need(buf, pos, o.unionType, end);
        const i = uint(buf, pos, o.unionType) - o.unionBase;
        pos += o.unionType;
        const m = s.e[i];
        if (!m) throw new Error(`union type ${i + o.unionBase} unknown at ${pos}`);
        if (stop > end) throw new Error(`union length past the end at ${pos}`);
        const r = read(m, buf, pos, stop, o);
        if (o.unionLen && r[1] !== stop) throw new Error(`union ${m.n}: ${stop - r[1]} bytes left`);
        return [{ type: m.n, value: r[0] }, r[1]];
    }
    // the length-prefixed kinds
    need(buf, pos, 4, end);
    const len = buf.readUInt32BE(pos), stop = pos + 4 + len;
    pos += 4;
    if (stop > end) throw new Error(`${t} length ${len} past the end at ${pos}`);
    if (t === 'Utf8D') {
        if (len < 4 || !buf.slice(pos, pos + 3).equals(BOM) || buf[stop - 1] !== 0) throw new Error(`bad Utf8D at ${pos}`);
        return [buf.slice(pos + 3, stop - 1).toString('utf8'), stop];
    }
    if (t === 'ByteBuffer') return [buf.slice(pos, stop).toString('hex'), stop];
    const out = [];
    while (pos < stop) {
        if (t === 'ArrayD') { const r = read(s.e, buf, pos, stop, o); out.push(r[0]); pos = r[1]; }
        else if (t === 'Map') { const k = read(s.k, buf, pos, stop, o), v = read(s.v, buf, k[1], stop, o); out.push([k[0], v[0]]); pos = v[1]; }
        else throw new Error(`type ${t} not supported`);
    }
    if (pos !== stop) throw new Error(`${t} overran its length`);
    return [out, stop];
}

function decode(schema, buf, opts) {
    const r = read(schema, buf, 0, buf.length, Object.assign({}, DEFAULT, opts));
    return { value: r[0], end: r[1] };
}

function decodeAny(schema, buf, candidates) {
    for (const o of candidates || CANDIDATES) {
        try {
            const r = decode(schema, buf, o);
            if (r.end === buf.length) return { value: r.value, opts: o };
        } catch (e) { /* not this one */ }
    }
    return null;
}

function bytes(n, v) { const b = Buffer.alloc(n); for (let i = n - 1; i >= 0; i--) { b[i] = v % 256; v = Math.floor(v / 256); } return b; }
function write(s, v, o) {
    const t = s.t;
    switch (t) {
        case 'UInt8': return Buffer.from([v & 255]);
        case 'Int8': { const b = Buffer.alloc(1); b.writeInt8(v, 0); return b; }
        case 'UInt16': { const b = Buffer.alloc(2); b.writeUInt16BE(v, 0); return b; }
        case 'Int16': { const b = Buffer.alloc(2); b.writeInt16BE(v, 0); return b; }
        case 'UInt32': { const b = Buffer.alloc(4); b.writeUInt32BE(v, 0); return b; }
        case 'Int32': { const b = Buffer.alloc(4); b.writeInt32BE(v, 0); return b; }
        case 'Float': { const b = Buffer.alloc(4); b.writeFloatBE(v, 0); return b; }
        case 'Double': { const b = Buffer.alloc(8); b.writeDoubleBE(v, 0); return b; }
        case 'Bool': return Buffer.from([v ? 1 : 0]);
        case 'UInt64': case 'Int64': return Buffer.from(String(v || '').padStart(16, '0').slice(-16), 'hex');
        case 'Enum': {
            if (!(v in s.e)) throw new Error(`enum name ${v} unknown`);
            return bytes(s.w || o.enumW, s.e[v]);
        }
        case 'Struct': return Buffer.concat(s.e.map((m) => write(m, v[m.n], o)));
        case 'Union': {
            const i = s.e.findIndex((m) => m.n === v.type);
            if (i < 0) throw new Error(`union member ${v.type} unknown`);
            const body = write(s.e[i], v.value, o), type = bytes(o.unionType, i + o.unionBase);
            return Buffer.concat(o.unionLen ? [bytes(o.unionLen, body.length), type, body] : [type, body]);
        }
        default: {
            let body;
            if (t === 'Utf8D') body = Buffer.concat([BOM, Buffer.from(String(v), 'utf8'), Buffer.from([0])]);
            else if (t === 'ByteBuffer') body = Buffer.from(v || '', 'hex');
            else if (t === 'ArrayD') body = Buffer.concat((v || []).map((x) => write(s.e, x, o)));
            else if (t === 'Map') body = Buffer.concat((v || []).map((kv) => Buffer.concat([write(s.k, kv[0], o), write(s.v, kv[1], o)])));
            else throw new Error(`type ${t} not supported`);
            return Buffer.concat([bytes(4, body.length), body]);
        }
    }
}
function encode(schema, value, opts) { return write(schema, value, Object.assign({}, DEFAULT, opts)); }

/* a value of schema with every field at its plainest (0, '', false, the first enum name, the first union member,
 * empty arrays); over: { 'path.to.member': value } replaces members on the way (tests, fakes) */
function sample(s, over, at) {
    at = at || '';
    if (over && Object.prototype.hasOwnProperty.call(over, at)) return over[at];
    switch (s.t) {
        case 'Struct': return s.e.reduce((o, m) => { o[m.n] = sample(m, over, at ? `${at}.${m.n}` : m.n); return o; }, {});
        case 'Union': return { type: s.e[0].n, value: sample(s.e[0], over, `${at}.${s.e[0].n}`) };
        case 'Enum': return Object.keys(s.e)[0];
        case 'Utf8D': return '';
        case 'Bool': return false;
        case 'UInt64': case 'Int64': return '0000000000000000';
        case 'ByteBuffer': return '';
        case 'ArrayD': case 'Map': return [];
        default: return 0;
    }
}

module.exports = { decode, encode, decodeAny, sample, CANDIDATES, DEFAULT };
