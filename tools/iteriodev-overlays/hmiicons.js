'use strict';
/*
 * hmiicons.js - the head unit's own HMI icons for the shortcuts (user 2026-11-12: pick any icon per shortcut, taken
 * from the head unit like mgu-deploy takes the MainApp SDK from donor apps). Nothing of BMW's travels in the package:
 * the tool reads the icons of the firmware on this car, at run time.
 *   ROOT/<id>/wbitmaps.res   one icon per folder (id = the folder, e.g. icon_Spotify), a RAMSES 27 resource file: the
 *                            texture descriptor (u32 w, h, format, swizzle 00 01 02 03, mips, type, 16-byte hash) then
 *                            u32 uncompressed size, compressed size, blob offset, blob size; the pixels = an LZ4 block
 *                            49 bytes into the blob, 2 bytes/px grey + alpha (the HMI tints them), rows bottom-up.
 *                            (scripts/hmi-tools/build_icons.py does the same on the PC.)
 * class_default only: the 84 px glyphs (class_menu_large are opaque plates). Decoded on demand, kept as white PNGs in
 * CACHE (the strip draws pictures from files).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = process.env.OVERLAYS_HMI_ICONS || '/mnt/dataro/data/hmi8/bmw/id8/assetDB/icons/class_default';
const CACHE = process.env.OVERLAYS_ICON_CACHE || '/var/opt/iteriodev-overlays/hmi-icons';
const PAGE = 24;
const ID = /^icon_[A-Za-z0-9_]{1,80}$/;
const WHITE = 240;                                   // the strip's white (tools/hmi_icons.js)
// page 1 without a search: what shortcuts are for (missing ones are left out)
const SUGGESTED = ['Carplay', 'AndroidAuto', 'Spotify', 'AmazonMusic', 'BrowseMusic', 'MediaRadio', 'Navigation', 'Call_Filled',
    'Smartphone', 'MessageService', 'Menu', 'MainMenu', 'Fan', 'Settings', 'Information', 'Record', 'EngineSound', 'Store',
    'Playlist', 'Podcast', 'Bluetooth', 'Car', 'Camera', 'WeatherCondition'].map((n) => `icon_${n}`);

const nameOf = (id) => id.replace(/^icon_/, '').replace(/_/g, ' ');

let listed = null;
/** every icon folder, sorted by its name: [{ id, name }] (read once) */
function list(root) {
    if (listed && listed.root === (root || ROOT)) return listed.items;
    let dirs = [];
    try { dirs = fs.readdirSync(root || ROOT).filter((d) => ID.test(d)); } catch (e) { dirs = []; }
    const items = dirs.map((id) => ({ id, name: nameOf(id) })).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    listed = { root: root || ROOT, items };
    return items;
}
const known = (id, root) => typeof id === 'string' && ID.test(id) && list(root).some((x) => x.id === id);

/** a page: no search = the suggested page, then all; a search = names holding it (case and spaces ignored) */
function page(q, n, root) {
    const all = list(root), key = String(q || '').toLowerCase().replace(/\s+/g, '');
    let pages;
    if (key) {
        const hits = all.filter((x) => x.name.toLowerCase().replace(/\s+/g, '').indexOf(key) >= 0);
        pages = (i) => hits.slice(i * PAGE, (i + 1) * PAGE);
        const count = Math.max(1, Math.ceil(hits.length / PAGE)), p = Math.max(0, Math.min(count - 1, n | 0));
        return { q: String(q), page: p, pages: count, total: hits.length, suggested: false, items: pages(p) };
    }
    const sug = SUGGESTED.map((id) => all.find((x) => x.id === id)).filter(Boolean);
    const count = 1 + Math.ceil(all.length / PAGE), p = Math.max(0, Math.min(count - 1, n | 0));
    return { q: '', page: p, pages: count, total: all.length, suggested: p === 0,
        items: p === 0 ? sug : all.slice((p - 1) * PAGE, p * PAGE) };
}

function lz4(src, outLen) {
    const dst = Buffer.alloc(outLen);
    let i = 0, o = 0;
    while (i < src.length) {
        const tok = src[i++];
        let lit = tok >> 4;
        if (lit === 15) { let b; do { b = src[i++]; lit += b; } while (b === 255); }
        if (o + lit > outLen || i + lit > src.length) throw new Error('bad lz4 literals');
        src.copy(dst, o, i, i + lit); i += lit; o += lit;
        if (i >= src.length || o >= outLen) break;
        const off = src[i] | (src[i + 1] << 8); i += 2;
        let ml = tok & 15;
        if (ml === 15) { let b; do { b = src[i++]; ml += b; } while (b === 255); }
        ml += 4;
        const start = o - off;
        if (start < 0 || !off || o + ml > outLen) throw new Error('bad lz4 match');
        for (let k = 0; k < ml; k++) dst[o + k] = dst[start + k];
        o += ml;
    }
    if (o !== outLen) throw new Error('lz4 size');
    return dst;
}
/** wbitmaps.res -> { w, h, data } RGBA top-down, white + the icon's alpha */
function decodeRes(b) {
    const p = b.indexOf(Buffer.from([0, 1, 2, 3]));
    if (p < 12) throw new Error('no texture');
    const w = b.readUInt32LE(p - 12), h = b.readUInt32LE(p - 8);
    const usize = b.readUInt32LE(p + 28), csize = b.readUInt32LE(p + 32), blob = b.readUInt32LE(p + 36);
    if (!w || !h || w > 512 || h > 512 || blob + 49 + csize > b.length) throw new Error('bad texture');
    const pix = lz4(b.slice(blob + 49, blob + 49 + csize), usize), ch = usize / (w * h);
    if ([1, 2, 4].indexOf(ch) < 0) throw new Error(`${ch} channels`);
    const data = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const s = ((h - 1 - y) * w + x) * ch, d = (y * w + x) * 4;
            data[d] = data[d + 1] = data[d + 2] = WHITE;
            data[d + 3] = ch === 1 ? pix[s] : ch === 2 ? pix[s + 1] : pix[s + 3];
        }
    }
    return { w, h, data };
}

const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
    const len = Buffer.alloc(4), crc = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type), data]);
    len.writeUInt32BE(data.length, 0); crc.writeUInt32BE(crc32(td), 0);
    return Buffer.concat([len, td, crc]);
}
function encodePng(img) {
    const raw = Buffer.alloc((img.w * 4 + 1) * img.h);
    for (let y = 0; y < img.h; y++) img.data.copy(raw, y * (img.w * 4 + 1) + 1, y * img.w * 4, (y + 1) * img.w * 4);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(img.w, 0); ihdr.writeUInt32BE(img.h, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** the icon's PNG file in CACHE (made once from the head unit's file), or null (unknown / undecodable) */
function file(id, root, cache) {
    if (!known(id, root)) return null;
    const f = path.join(cache || CACHE, `${id}.png`), res = path.join(root || ROOT, id, 'wbitmaps.res');
    try { if (fs.statSync(f).mtime >= fs.statSync(res).mtime) return f; } catch (e) { /* not made yet */ }   // (a firmware update: again)
    try {
        const img = decodeRes(fs.readFileSync(res));
        try { fs.mkdirSync(cache || CACHE); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        fs.writeFileSync(`${f}.tmp`, encodePng(img));
        fs.renameSync(`${f}.tmp`, f);
        return f;
    } catch (e) { console.log(`hmi icon ${id}: ${e.message}`); return null; }
}
/** a page (or the ids asked for) with each icon's PNG, base64 (null: no picture) */
function withPics(items, root, cache) {
    return items.map((x) => {
        const f = file(x.id, root, cache);
        let pic = null;
        try { if (f) pic = fs.readFileSync(f).toString('base64'); } catch (e) { /* none */ }
        return { id: x.id, name: x.name, pic };
    });
}

/* ---- self-check (node hmiicons.js --test [icon folder]): a made-up icon, then the real folder if given ---- */
function test(real) {
    const assert = require('assert');
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hmiicons-'));
    // a 2x2 grey+alpha texture, rows bottom-up, LZ4 literals only
    const pix = Buffer.from([255, 10, 255, 20, 255, 30, 255, 40]);
    const lzb = Buffer.concat([Buffer.from([pix.length << 4]), pix]);
    const hdr = Buffer.alloc(64), body = Buffer.alloc(49);
    hdr.write('[RamsesVersion:27]\n', 0);
    const p = 24;
    hdr.writeUInt32LE(2, p - 12); hdr.writeUInt32LE(2, p - 8); hdr.writeUInt32LE(5, p - 4);
    Buffer.from([0, 1, 2, 3]).copy(hdr, p);
    hdr.writeUInt32LE(8, p + 28); hdr.writeUInt32LE(lzb.length, p + 32); hdr.writeUInt32LE(64, p + 36);
    fs.mkdirSync(path.join(tmp, 'icons'));                // (Node 8: no recursive mkdir)
    ['icon_Spotify', 'icon_Call_Filled', 'icon_Zebra', 'bogus'].forEach((d) => {
        fs.mkdirSync(path.join(tmp, 'icons', d));
        fs.writeFileSync(path.join(tmp, 'icons', d, 'wbitmaps.res'), Buffer.concat([hdr, body, lzb]));
    });
    const R = path.join(tmp, 'icons'), C = path.join(tmp, 'cache');
    listed = null;
    assert.deepStrictEqual(list(R).map((x) => x.name), ['Call Filled', 'Spotify', 'Zebra'], 'icon_ folders only, by name');
    const img = decodeRes(fs.readFileSync(path.join(R, 'icon_Spotify', 'wbitmaps.res')));
    assert.deepStrictEqual([img.w, img.h, img.data[3], img.data[7], img.data[11], img.data[15], img.data[0]], [2, 2, 30, 40, 10, 20, WHITE], 'top row first, white');
    assert.deepStrictEqual(page('', 0, R).items.map((x) => x.id), ['icon_Spotify', 'icon_Call_Filled'], 'suggested first');
    assert.deepStrictEqual([page('', 1, R).items.length, page('', 0, R).pages], [3, 2]);
    assert.deepStrictEqual(page('callf', 0, R).items.map((x) => x.id), ['icon_Call_Filled'], 'spaces ignored');
    assert.deepStrictEqual([page('nothing', 5, R).total, page('nothing', 5, R).page], [0, 0]);
    assert.strictEqual(file('../etc', R, C), null, 'only listed ids');
    const f = file('icon_Zebra', R, C), png = require('./png');
    assert.deepStrictEqual([png.decode(fs.readFileSync(f)).w, withPics([{ id: 'icon_Zebra', name: 'Zebra' }], R, C)[0].pic.length > 20], [2, true]);
    if (real) {
        listed = null;
        const all = list(real);
        let bad = 0;
        const t0 = Date.now();
        all.forEach((x) => { try { decodeRes(fs.readFileSync(path.join(real, x.id, 'wbitmaps.res'))); } catch (e) { bad++; } });
        console.log(`real: ${all.length} icons, ${bad} undecodable, ${Date.now() - t0} ms`);
        assert(all.length > 900 && bad < 20, 'the real folder decodes');
        listed = null;
    }
    console.log('hmiicons self-check ok');
}

module.exports = { ROOT, CACHE, PAGE, list, known, page, file, withPics, decodeRes, encodePng, nameOf };
if (require.main === module && process.argv[2] === '--test') test(process.argv[3]);
