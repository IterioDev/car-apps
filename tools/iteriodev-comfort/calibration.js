"use strict";
// Operator-controlled snapshots only. Never jogs, recalls or probes an end stop.
const policy = require('./driver-access');
const BUFFER = 30, LEASE_MS = 5 * 60 * 1000, STABLE = 8;
const clone = p => JSON.parse(JSON.stringify(p));
function stable(a,b) {
    if(!policy.position(a) || !policy.position(b))return false;
    const keys=Object.keys(a).sort();
    return JSON.stringify(keys)===JSON.stringify(Object.keys(b).sort()) && keys.every(k=>
        k==='wheel'?stable(a[k],b[k]):Math.abs(a[k]-b[k])<=STABLE);
}
function plan(driving,rear,exit) {
    if(!policy.position(driving) || !policy.position(rear) ||
        ![driving.SLV,rear.SLV].every(n=>Number.isInteger(n) && n>=8192 && n<=57344))throw Error('Longitudinal position unavailable');
    const distance=rear.SLV-driving.SLV;
    if(Math.abs(distance)<=BUFFER)throw Error('Rear point must be more than 30 counts behind the driving point');
    const direction=Math.sign(distance),limit=rear.SLV-direction*BUFFER;
    const result={driving:clone(driving),limit:{rear:limit,direction}};
    if(exit) {
        if(!policy.position(exit) || !Number.isInteger(exit.SLV) || exit.SLV<8192 || exit.SLV>57344)throw Error('Easy Exit position unavailable');
        if((exit.SLV-limit)*direction>0)throw Error('Move forward inside the buffered rear limit before saving Easy Exit');
        result.exit=clone(exit);result.actual=clone(exit);
    }
    return result;
}
class Calibration {
    constructor(deps) {this.d=deps;this.owner=null;this.reference=null;this.rear=null;this.limit=null;this.busy=false;this.generation=0;this.until=0;this.message='';}
    active() {return this.owner!==null;}
    view(client) {return {supported:true,active:this.active(),owned:this.owner===client && this.active(),
        busy:this.busy,reference:!!this.reference,rear:!!this.rear,limit:this.limit,buffer:BUFFER,message:this.message};}
    cancel(message,owner) {
        if(owner && this.active() && this.owner!==owner)return 'Calibration belongs to another connection';
        this.generation++;this.owner=null;this.reference=null;this.rear=null;this.limit=null;this.busy=false;this.until=0;
        this.message=message||'Calibration cancelled; saved positions retained';this.d.changed();return null;
    }
    check() {
        if(!this.active())return;
        const reason=this.d.guard();
        if(this.d.now()>=this.until)this.cancel('Calibration expired; saved positions retained');
        else if(reason)this.cancel('Calibration cancelled: '+reason);
    }
    async sample(token) {
        const valid=()=>{if(token!==this.generation || !this.active())throw Error('Calibration cancelled');
            const reason=this.d.guard();if(reason)throw Error(reason);
            if(this.d.now()>=this.until)throw Error('Calibration expired');};
        valid();const a=await this.d.capture();valid();const b=await this.d.capture();valid();
        if(!stable(a,b))throw Error('Seat position changed or is incomplete; release controls and retry');
        if(!Number.isInteger(b.SLV) || b.SLV<8192 || b.SLV>57344)throw Error('Longitudinal position unavailable');
        return b;
    }
    async request(client,action) {
        if(['driving','limit','exit','cancel'].indexOf(action)<0)return 'Invalid calibration action';
        if(this.active() && this.owner!==client)return 'Calibration belongs to another connection';
        if(action==='cancel')return this.cancel(null,client);
        if(this.busy)return 'Calibration read pending';
        const reason=this.d.guard();if(reason)return reason;
        if(action!=='driving' && (!this.active() || !this.reference))return 'Capture the driving position first';
        if(action==='exit' && !this.rear)return 'Capture the rear limit first';
        if(action==='driving'){this.owner=client;this.reference=null;this.rear=null;this.limit=null;this.until=this.d.now()+LEASE_MS;}
        const token=++this.generation;this.busy=true;this.message='Reading stopped seat position';this.d.changed();
        try {
            const p=await this.sample(token);
            if(action==='driving') {this.reference=clone(p);this.message='Driving point captured. Move rearward manually, stop, then capture the rear limit.';}
            else if(action==='limit'){this.limit=plan(this.reference,p).limit;this.rear=clone(p);this.message='Rear limit captured with 30-count buffer. Set your Easy Exit pose inside it, then save.';}
            else {
                const result=plan(this.reference,this.rear,p);
                this.d.commit(result); // synchronous persistence before reporting success
                this.owner=null;this.reference=null;this.rear=null;this.limit=null;this.until=0;
                this.message='Calibration saved: app M1, Exit and 30-count rear buffer. Return to driving position manually.';
            }
            return null;
        }catch(e){if(token===this.generation)this.message=e.message;return e.message;}
        finally {if(token===this.generation){this.busy=false;this.d.changed();}}
    }
}
module.exports={Calibration,BUFFER,LEASE_MS,stable,plan};
