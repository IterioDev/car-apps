'use strict';
// H.264 access units (AVCC, from /video) -> fragmented MP4 for Media Source Extensions: an init segment
// (ftyp + moov with the SPS/PPS as avcC) and one moof + mdat per frame. Browser global Mux; Node module (test).
(function (root) {
    const u16 = (n) => [n >> 8 & 255, n & 255];
    const u32 = (n) => [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255];
    const str = (s) => Array.from(s, (c) => c.charCodeAt(0));
    const zeros = (n) => new Uint8Array(n);
    const cat = (parts) => {
        const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
        let at = 0;
        for (const p of parts) { out.set(p, at); at += p.length; }
        return out;
    };
    const box = (type, ...parts) => { const b = cat([u32(0), str(type)].concat(parts)); b.set(u32(b.length)); return b; };
    const full = (type, ver, flags, ...parts) => box(type, [ver].concat(u32(flags).slice(1)), ...parts);
    const MATRIX = [].concat(u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000));
    const TS = 90000;
    const hex = (b) => (b < 16 ? '0' : '') + b.toString(16);

    // one access unit: SPS/PPS (they go into avcC), AUDs dropped, the rest is the sample (still AVCC)
    function frame(au) {
        const keep = [];
        let sps = null, pps = null, key = false;
        for (let at = 0; at + 4 <= au.length;) {
            const n = (au[at] << 24 | au[at + 1] << 16 | au[at + 2] << 8 | au[at + 3]) >>> 0, t = au[at + 4] & 31;
            const unit = au.subarray(at, at + 4 + n);
            at += 4 + n;
            if (t === 7) sps = unit.subarray(4);
            else if (t === 8) pps = unit.subarray(4);
            else if (t !== 9) { keep.push(unit); key = key || t === 5; }
        }
        return { sps, pps, key, data: cat(keep) };
    }

    function Mux(sps, pps, width, height, fps) {
        this.sps = sps; this.pps = pps; this.w = width; this.h = height;
        this.dur = Math.round(TS / fps); this.t = 0; this.seq = 0;
        this.type = `video/mp4; codecs="avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}"`;
    }

    Mux.prototype.init = function () {
        const { sps, pps, w, h } = this;
        const avcC = box('avcC', [1, sps[1], sps[2], sps[3], 0xff, 0xe1], u16(sps.length), sps, [1], u16(pps.length), pps);
        const avc1 = box('avc1', zeros(6), u16(1), zeros(16), u16(w), u16(h), u32(0x480000), u32(0x480000), u32(0),
            u16(1), zeros(32), u16(0x18), u16(0xffff), avcC);
        const stbl = box('stbl', full('stsd', 0, 0, u32(1), avc1), full('stts', 0, 0, u32(0)), full('stsc', 0, 0, u32(0)),
            full('stsz', 0, 0, u32(0), u32(0)), full('stco', 0, 0, u32(0)));
        const minf = box('minf', full('vmhd', 0, 1, zeros(8)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stbl);
        const mdia = box('mdia', full('mdhd', 0, 0, u32(0), u32(0), u32(TS), u32(0), u16(0x55c4), u16(0)),
            full('hdlr', 0, 0, u32(0), str('vide'), zeros(12), str('mgu\0')), minf);
        const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0), zeros(8), zeros(8), MATRIX, u32(w * 65536), u32(h * 65536));
        const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(0), u32(0x10000), u16(0x100), zeros(10), MATRIX, zeros(24), u32(2));
        const mvex = box('mvex', full('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)));
        return cat([box('ftyp', str('isom'), u32(0x200), str('isomiso6avc1mp41')), box('moov', mvhd, box('trak', tkhd, mdia), mvex)]);
    };

    Mux.prototype.fragment = function (f) {
        const t = this.t, seq = ++this.seq;
        this.t += this.dur;
        const moof = (off) => box('moof', full('mfhd', 0, 0, u32(seq)), box('traf',
            full('tfhd', 0, 0x20000, u32(1)),                                  // default-base-is-moof
            full('tfdt', 1, 0, u32(Math.floor(t / 4294967296)), u32(t >>> 0)),
            full('trun', 0, 0x701, u32(1), u32(off), u32(this.dur), u32(f.data.length),  // offset, duration, size, flags
                u32(f.key ? 0x02000000 : 0x01010000))));
        return cat([moof(moof(0).length + 8), box('mdat', f.data)]);
    };

    Mux.frame = frame;
    if (typeof module !== 'undefined') module.exports = Mux; else root.Mux = Mux;
})(this);
