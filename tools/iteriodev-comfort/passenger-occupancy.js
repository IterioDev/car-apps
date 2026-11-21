"use strict";
// Observed G22 seven-byte 3530 profile; notification cache only, never polls or sends commands.
const FRESH_MS=1500;
function crc(bytes){let c=0;for(let i=1;i<bytes.length;i++){c^=bytes[i];for(let bit=0;bit<8;bit++)c=((c<<1)&255)^((c&128)?0x1d:0);}return c^0x21;}
function decode(hex){
 if(typeof hex!=='string'||!/^[0-9a-f]{14}$/i.test(hex))return {valid:false,reason:'unexpected occupancy payload'};
 const b=Buffer.from(hex,'hex'),counter=b[1]&15;
 if(crc(b)!==b[0])return {valid:false,reason:'occupancy checksum mismatch'};
 if(counter===15)return {valid:false,reason:'occupancy counter unavailable'};
 const raw=(b[3]>>2)&7,buckle=b[3]&3;
 return {valid:true,counter,raw,buckle,classification:raw===0?'empty':raw===3?'occupied':raw===1?'child-seat':'unknown',profile:'observed-g22-seven-byte-v1',crcChecked:true};
}
class PassengerOccupancy{
 constructor(now,changed,emit){this.now=now||Date.now;this.changed=changed||(()=>{});this.emit=emit||(()=>{});this.lastReport=null;this.reset('no occupancy data',false);}
 reset(reason,notify){this.sample=null;this.at=null;this.counter=null;this.streak=0;this.reason=reason||'occupancy source reset';if(notify!==false)this.publish();}
 view(){const age=this.at===null?null:this.now()-this.at,fresh=age!==null&&age>=0&&age<FRESH_MS;
  const ready=fresh&&this.streak>=2&&!this.reason,classification=ready?this.sample.classification:'unknown';
  return {classification,raw:this.sample?this.sample.raw:null,buckle:this.sample?this.sample.buckle:null,fresh,ageMs:age,ready,reason:this.reason||(!fresh?'occupancy stale':this.streak<2?'waiting for advancing occupancy frames':classification==='unknown'?'occupancy unavailable':null),profile:'observed-g22-seven-byte-v1',crcChecked:!!this.sample,hardwareChildSeatValidated:false};}
 publish(){const v=this.view(),key=JSON.stringify([v.classification,v.ready,v.fresh,v.reason]);if(key!==this.lastReport){this.lastReport=key;this.emit(v);this.changed();}}
 event(hex){const v=decode(hex),now=this.now();
  if(!v.valid){this.reset(v.reason);return;}
  if(this.at!==null&&(now<this.at||now-this.at>=FRESH_MS)){this.counter=null;this.streak=0;}
  if(this.counter!==null){const delta=(v.counter-this.counter+15)%15;
   if(delta===0){if(this.sample&&v.raw===this.sample.raw&&v.buckle===this.sample.buckle){this.publish();return;}this.reset('occupancy counter repeated with changed data');return;}
   if(delta>7){this.reset('occupancy counter out of order');return;}
  }
  this.streak++;this.counter=v.counter;this.at=now;this.sample=v;this.reason=null;this.publish();
 }
 check(){this.publish();}
}
module.exports={FRESH_MS,crc,decode,PassengerOccupancy};
