"use strict";
// Driver-only automatic policy. No transport, timers, filesystem or vehicle I/O.
const STARTUP_SETTLE_MS = 50; // Seat-module startup settling; hardware tuning remains vehicle-dependent.
const NEAR = 32; // Upstream position-change comparison, sensor counts not millimetres.
function near(p,q) { const keys=Object.keys(q||{}).filter(a=>a!=='wheel' && typeof p[a]==='number');return keys.length>0 && keys.every(a=>Math.abs(p[a]-q[a])<=NEAR); }
const VALID = [1,2,3,5,7,8,10,12];
const ready = v => v === 10;
const mode = v => v === 'fixed' ? 'fixed' : 'adaptive';
const EXIT_COUNTS = [75,150,225];
// Keep the prior setup fields for data compatibility. Only their direction can inform a relative move.
function validCalibration(c) {
    return !!(c && typeof c === 'object' && !Array.isArray(c) &&
        Object.keys(c).length === 2 && Number.isInteger(c.rear) && c.rear >= 8192 && c.rear <= 57344 &&
        (c.direction === -1 || c.direction === 1));
}
function validLongitudinal(value) {
    return Number.isInteger(value) && value >= 8192 && value <= 57344;
}

function rearDirection(data) {
    const legacy = data.settings && data.settings.driverRelativeLimit;
    if (validCalibration(legacy)) return legacy.direction;
    const driving = data.memories && data.memories.driver && data.memories.driver[0];
    const exit = data.exit && data.exit.driver;
    if (!driving || !exit || !validLongitudinal(driving.SLV) || !validLongitudinal(exit.SLV)) return null;
    // The two named presets express the owner's intended driving-to-exit direction.
    const difference = exit.SLV - driving.SLV;
    return Math.abs(difference) > 8 ? Math.sign(difference) : null;
}
function settings(raw) { raw=raw||{};return {easyExit:raw.easyExit!==false,driverExitMode:mode(raw.driverExitMode),
    driverExitTargetMode:raw.driverExitTargetMode==='adaptive'?'adaptive':'fixed',driverExitLevel:[1,2,3].indexOf(raw.driverExitLevel)>=0?raw.driverExitLevel:2,
    driverCalibrationVersion:raw.driverCalibrationVersion===1?1:0,
    driverRelativeLimit:validCalibration(raw.driverRelativeLimit)?{rear:raw.driverRelativeLimit.rear,direction:raw.driverRelativeLimit.direction}:null}; }
function updateSettings(data, patch, busy) {
    if(!patch || typeof patch!=='object' || Array.isArray(patch))return 'invalid settings';
    const keys=Object.keys(patch), allowed=['easyExit','driverExitMode','driverExitTargetMode','driverExitLevel'];
    if(keys.some(k=>allowed.indexOf(k)<0))return 'unknown setting';
    if(patch.easyExit!==undefined && typeof patch.easyExit!=='boolean')return 'invalid easy exit';
    if(['driverExitMode','driverExitTargetMode'].some(k=>patch[k]!==undefined && patch[k]!=='fixed' && patch[k]!=='adaptive'))return 'invalid mode';
    if(patch.driverExitLevel!==undefined && [1,2,3].indexOf(patch.driverExitLevel)<0)return 'invalid exit level';
    const changed=keys.some(k=>k!=='easyExit' && JSON.stringify(patch[k])!==JSON.stringify(data.settings[k]));
    if(changed && busy)return 'seat job active';
    if(changed){data.pre.driver=null;if(data.relativeExit)data.relativeExit.driver=null;}
    keys.forEach(k=>{data.settings[k]=patch[k];});return null;
}
function relativeTarget(anchor, level, direction) {
    if (!anchor || !validLongitudinal(anchor.SLV) ||
        ![1,2,3].includes(level) || (direction !== -1 && direction !== 1)) return null;
    const target = anchor.SLV + direction * EXIT_COUNTS[level - 1];
    return validLongitudinal(target) ? { target: { SLV: target } } : null;
}
function decodeCondition(hex) {
    if(typeof hex !== 'string' || !/^[0-9a-f]{14}$/i.test(hex)) return null;
    const value=parseInt(hex.slice(10,12),16), qualifier=parseInt(hex.slice(12,14),16);
    return qualifier === 2 && VALID.indexOf(value)>=0 ? value : null;
}
function transition(previous,next) {
    if(VALID.indexOf(previous)<0 || VALID.indexOf(next)<0 || previous===next) return null;
    if(next===10 && previous!==10) return 'driving';
    if(previous===10 && next===12) return 'exit';
    return null;
}
function setMode(data,value,busy) {
    if(value!=='fixed' && value!=='adaptive')return 'invalid driver return mode';
    if(value===data.settings.driverExitMode)return null;
    if(busy)return 'seat job active';
    data.pre.driver=null;data.settings.driverExitMode=value;return null;
}
function position(p) {
    return !!(p && typeof p==='object' && !Array.isArray(p) && Object.keys(p).length &&
        Object.keys(p).every(k=>k==='wheel' ? position(p[k]) : typeof p[k]==='number' && Number.isFinite(p[k])));
}
const copy = p => JSON.parse(JSON.stringify(p));
class DriverExit {
    constructor(deps) { this.d=deps;this.conditionValue=null;this.doorValue=null;this.last=null;this.generation=0;this.action=null;this.startupUntil=0;this.entryUntil=0; }
    report(which,reason,result) {
        this.last={target:which,reason,result};this.d.log('driver easy exit: '+which+': '+result);this.d.changed();
    }
    cancel(reason, notify) {
        this.entryUntil=0;
        this.generation++;
        const action=this.action;this.action=null;
        if(action) {
            this.report(action.which,action.reason,reason || 'cancelled');
            if(reason && notify !== false && this.d.stopAutomatic)this.d.stopAutomatic();
        }
    }
    reset(reason) { this.cancel(reason || 'source reset');this.conditionValue=null;this.doorValue=null;this.startupUntil=0;this.entryUntil=0; }
    condition(next) {
        const previous=this.conditionValue;
        this.conditionValue=VALID.indexOf(next)>=0 ? next : null;
        if(this.conditionValue===10 && previous!==10)this.startupUntil=(this.d.now?this.d.now():0)+STARTUP_SETTLE_MS;
        this.check();
        const which=transition(previous,this.conditionValue);
        const pending=this.entryUntil>0 && (this.d.now?this.d.now():0)<this.entryUntil;
        if(which || (this.conditionValue===10 && this.doorValue===false && pending)) {
            this.entryUntil=0;this.request(which || 'driving',which?'vehicle condition':'recent entry');
        }
        if(this.conditionValue!==null && this.conditionValue!==10 && [7,8].indexOf(this.conditionValue)<0)this.entryUntil=0;
    }
    door(open) {
        const previous=this.doorValue;
        if(open!==false)this.entryUntil=0;
        this.doorValue=typeof open==='boolean' ? open : null;
        this.check();
        if(previous===null || this.doorValue===null || previous===this.doorValue)return;
        if(!open && this.d.entryRecovery && mode(this.d.data.settings.driverExitMode)==='fixed' &&
            this.d.data.settings.easyExit && position(this.target('driving', 'fixed')) &&
            this.d.executionEnabled() && [null,7,8].indexOf(this.conditionValue)>=0)
            this.entryUntil=(this.d.now?this.d.now():0)+10000;
        if(!ready(this.conditionValue)) { this.report(open?'exit':'driving','driver door','driver not ready');return; }
        this.request(open?'exit':'driving','driver door');
    }
    target(which,selected) {
        const d=this.d.data;return which==='exit' ? d.exit.driver : selected==='fixed' ? d.memories.driver[0] : d.pre.driver;
    }
    blocked(a) {
        if(a.expires && (this.d.now?this.d.now():0)>=a.expires)return 'entry request expired';
        if(!a.manual && !this.d.data.settings.easyExit)return 'easy exit disabled';
        if(mode(this.d.data.settings.driverExitMode)!==a.selected)return 'return mode changed';
        if((this.d.data.settings.driverExitTargetMode||'fixed')!==a.exitMode || (this.d.data.settings.driverExitLevel||2)!==a.level)return 'exit settings changed';
        if (a.which === 'exit' && a.exitMode === 'adaptive') {
            if (!a.direction) return 'Save Easy Exit behind Driving to establish rearward direction';
            if (a.direction !== rearDirection(this.d.data)) return 'rearward direction changed';
        }
        if(!(a.which==='driving' && a.selected==='fixed') && !this.d.parked())return 'car not standing';
        if(!a.manual && !this.d.occupied())return 'occupancy blocked'; // legacy occupancy policy; no new sensor claim
        if(a.which==='driving' && (this.doorValue!==false || !ready(this.conditionValue) || !this.d.returnReady()))return 'driver not ready';
        if(a.which==='exit' && a.reason==='driver door') {
            if(this.doorValue!==true || !ready(this.conditionValue))return 'exit context ended';
            if(!this.d.inPark || !this.d.inPark())return 'P unavailable or not selected';
        }
        if(a.which==='exit' && a.reason==='vehicle condition') {
            // A validated 10->12 shutdown request may finish across the observed temporary
            // qualifier14/unavailable interval, but never across helper reset or a new valid state.
            if(this.conditionValue!==12 && this.conditionValue!==null)return 'shutdown context ended';
        }
        return null;
    }
    check() {
        if(this.entryUntil && ((this.d.now?this.d.now():0)>=this.entryUntil || !this.d.data.settings.easyExit ||
            mode(this.d.data.settings.driverExitMode)!=='fixed' || !position(this.target('driving', 'fixed')) ||
            !this.d.executionEnabled()))this.entryUntil=0;
        if(!this.action)return;
        const reason=this.blocked(this.action);
        if(reason)this.cancel(reason);
    }
    request(which,reason,manual) {
        const config=this.d.data.settings,selected=mode(config.driverExitMode),a={which,reason,selected,manual:!!manual,exitMode:config.driverExitTargetMode||'fixed',level:config.driverExitLevel||2};
        if(reason==='recent entry')a.expires=(this.d.now?this.d.now():0)+10000;
        const relative=which==='exit' && a.exitMode==='adaptive';
        a.direction=relative?rearDirection(this.d.data):null;
        let denied=this.blocked(a);
        const target=this.target(which,selected);
        if(!denied && !relative && !position(target))denied=which==='exit'?'Exit not saved':selected==='fixed'?'app Memory 1 not saved':'no prior position';
        if(denied){this.report(which,reason,denied);return;}
        if(!manual && !this.d.executionEnabled()){this.report(which,reason,'observe only: movement disarmed');return;}
        a.target=relative?null:copy(target); // one immutable destination per request, including time spent queued
        const generation=++this.generation;this.action=a;
        const permission=()=>generation!==this.generation || this.action!==a ? 'cancelled' : this.blocked(a);
        const run=async()=>{
            const finish=result=>{if(this.action===a){this.action=null;this.report(which,reason,result);}return result;};
            let blocked=permission();if(blocked)return finish(blocked);
            const data=this.d.data;
            // Only the initial read/capture may retry; never replay movement writes.
            const initial=async read=>{
                try{return await read();}catch(e){
                    if(a.manual || !this.d.wait || !/refused by the gateway/.test(e.message) || permission())throw e;
                    this.d.log('initial position read retry: '+e.message+' code='+String(e.code));
                    await this.d.wait(150);const denied=permission();if(denied)throw new Error(denied);
                    return read();
                }
            };
            try {
                if(which==='driving' && this.d.wait) {
                    const remaining=this.startupUntil-(this.d.now?this.d.now():0);
                    if(remaining>0) { this.report(which,reason,'startup settling');await this.d.wait(remaining); }
                    blocked=permission();if(blocked)return finish(blocked);
                }
                if(which==='driving' && selected==='adaptive' && this.d.current) {
                    const current=await initial(()=>this.d.current());blocked=permission();if(blocked)return finish(blocked);
                    if(!position(current))return finish('no current position');
                    const reference=(data.out && data.out.driver)||data.exit.driver;
                    if(!near(current,reference)) {data.pre.driver=null;if(data.relativeExit)data.relativeExit.driver=null;this.d.save();this.d.changed();return finish('moved since: stays');}
                }
                if (relative) {
                    if (!data.relativeExit) data.relativeExit = { driver: null };
                    let cycle = data.relativeExit.driver;
                    if (cycle && cycle.direction !== -1 && cycle.direction !== 1) cycle = null; // discard old capped targets
                    if (!cycle) {
                        const captured = await initial(() => this.d.capture());
                        blocked = permission(); if (blocked) return finish(blocked);
                        const plan = relativeTarget(captured, a.level, a.direction);
                        if (!plan || !position(captured)) return finish('no valid relative position');
                        if (selected === 'adaptive') data.pre.driver = copy(captured);
                        cycle = { anchor: copy(captured), target: plan.target, level: a.level, direction: a.direction };
                        data.relativeExit.driver = cycle;
                        this.d.save(); this.d.changed();
                    } else {
                        if (cycle.terminal) return finish(cycle.terminal);
                        const current = await initial(() => this.d.current ? this.d.current() : this.d.capture());
                        blocked = permission(); if (blocked) return finish(blocked);
                        if (!current || !validLongitudinal(current.SLV)) return finish('position feedback lost');
                        if (cycle.target) {
                            const remaining = (cycle.target.SLV - current.SLV) * a.direction;
                            if (remaining <= 8) return finish('no further rearward travel requested');
                            if (remaining > EXIT_COUNTS[a.level - 1]) return finish('seat moved outside Exit cycle');
                        }
                    }
                    if (cycle.direction !== a.direction || cycle.level !== a.level || !position(cycle.anchor))
                        return finish('invalid relative cycle');
                    const expected = relativeTarget(cycle.anchor, a.level, a.direction);
                    if (!expected || !position(cycle.target) || Object.keys(cycle.target).length !== 1 ||
                        cycle.target.SLV !== expected.target.SLV) return finish('invalid relative target');
                    a.cycle = cycle;
                    a.target = copy(cycle.target);
                } else if(which==='exit' && selected==='adaptive') {
                    const captured=await initial(()=>this.d.capture());blocked=permission();
                    if(blocked)return finish(blocked);
                    if(!position(captured))return finish('no captured position');
                    if(!data.pre.driver || !near(captured,(data.out && data.out.driver)||data.exit.driver)) {data.pre.driver=copy(captured);this.d.save();this.d.changed();}
                }
                blocked=permission();if(blocked)return finish(blocked);
                a.expires=0; // Entry expiry bounds waiting, not an already-authorized movement.
                this.report(which,reason,'moving');
                const result=await this.d.move(a.target,which==='exit',{
                    parkedOnly:!(which==='driving' && selected==='fixed'),permission,
                    fixedReturn:which==='driving' && selected==='fixed'});
                if (relative && data.relativeExit.driver === a.cycle &&
                    ['never started', 'no progress', 'position feedback lost', 'STOP unconfirmed'].includes(result)) {
                    a.cycle.terminal = result;
                    this.d.save();
                }
                blocked=permission();if(blocked)return finish(blocked);
                if (result === 'STOP unconfirmed' || result === 'position feedback lost') return finish(result);
                if(selected==='adaptive' && this.d.current) {
                    try { const actual=await this.d.current();blocked=permission();if(blocked)return finish(blocked);
                        if(position(actual)){if(!data.out)data.out={driver:null,passenger:null};data.out.driver=copy(actual);this.d.save();this.d.changed();}
                    } catch(e) { this.d.log('driver last-out read: '+e.message); }
                }
                blocked=permission();if(blocked)return finish(blocked);
                if(which==='driving' && selected==='adaptive' && result==='done') {
                    data.pre.driver=null;if(data.relativeExit)data.relativeExit.driver=null;this.d.save();this.d.changed();
                }
                if(which==='driving' && result==='done' && data.relativeExit && data.relativeExit.driver) {data.relativeExit.driver=null;this.d.save();}
                return finish(result);
            }catch(e){return finish('error: '+e.message);}
        };
        this.d.schedule(which==='exit'?'exit':'back',run,!!manual);
    }
}
module.exports={rearDirection,EXIT_COUNTS,validCalibration,relativeTarget,updateSettings,STARTUP_SETTLE_MS,near,DriverExit,settings,setMode,mode,ready,driveReady:ready,transition,decodeCondition,position};
