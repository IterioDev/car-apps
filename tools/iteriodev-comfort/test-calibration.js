"use strict";
// Local fake positions, clock, persistence and clients only. No native helper or vehicle transport.
const assert=require('assert'),C=require('./calibration'),P=require('./driver-access'),legacy=require('./test-driver-access');
let checks=0;const eq=(a,b)=>{assert.deepStrictEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)));checks++;};
const tick=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
function fixture() {
    const owner={},other={},state={pos:{SLV:33100,LNV:34000},reason:null,now:1000,reads:0,commits:[],fail:false};
    const c=new C.Calibration({guard:()=>state.reason,now:()=>state.now,changed:()=>{},capture:async()=>{state.reads++;return Object.assign({},state.pos);},commit:r=>{if(state.fail)throw Error('disk failed');state.commits.push(r);}});
    return {c,state,owner,other};
}
(async()=>{
 for(const dir of [-1,1]){
  const f=fixture();eq(await f.c.request(f.owner,'driving'),null);eq(f.state.reads,2);eq(f.c.active(),true);eq(f.c.view(f.owner).owned,true);eq(f.c.view(f.other).owned,false);
  f.state.pos={SLV:33100+dir*200,LNV:34020};eq(await f.c.request(f.owner,'limit'),null);eq(f.state.reads,4);eq(f.state.commits.length,0);eq(f.c.active(),true);
  f.state.pos={SLV:33100+dir*100,LNV:34100};eq(await f.c.request(f.owner,'exit'),null);eq(f.state.reads,6);eq(f.state.commits.length,1);eq(f.state.commits[0].limit,{rear:33100+dir*170,direction:dir});eq(f.state.commits[0].driving,{SLV:33100,LNV:34000});eq(f.state.commits[0].exit,{SLV:33100+dir*100,LNV:34100});eq(f.c.active(),false);
 }
 const missing=fixture();eq(await missing.c.request(missing.owner,'limit'),'Capture the driving position first');eq(missing.state.reads,0);eq(await missing.c.request(missing.owner,'bad'),'Invalid calibration action');
 for(const reason of ['Fresh P required','Car must be standing','Seat control is busy','Driver longitudinal feedback required']){const f=fixture();f.state.reason=reason;eq(await f.c.request(f.owner,'driving'),reason);eq(f.state.reads,0);eq(f.c.active(),false);}
 const owner=fixture();await owner.c.request(owner.owner,'driving');eq(await owner.c.request(owner.other,'limit'),'Calibration belongs to another connection');eq(await owner.c.request(owner.other,'cancel'),'Calibration belongs to another connection');eq(owner.c.active(),true);eq(await owner.c.request(owner.owner,'cancel'),null);eq(owner.state.commits,[]);
 const small=fixture();await small.c.request(small.owner,'driving');small.state.pos.SLV-=30;eq(await small.c.request(small.owner,'limit'),'Rear point must be more than 30 counts behind the driving point');eq(small.state.commits,[]);
 const noExit=fixture();await noExit.c.request(noExit.owner,'driving');eq(await noExit.c.request(noExit.owner,'exit'),'Capture the rear limit first');noExit.state.pos.SLV-=200;await noExit.c.request(noExit.owner,'limit');eq(noExit.state.commits.length,0);eq(await noExit.c.request(noExit.owner,'exit'),'Move forward inside the buffered rear limit before saving Easy Exit');eq(noExit.state.commits.length,0);
 const moving=fixture();moving.c.d.capture=async()=>({SLV:33100+(moving.state.reads++*20)});eq(await moving.c.request(moving.owner,'driving'),'Seat position changed or is incomplete; release controls and retry');eq(moving.c.reference,null);
 const partial=fixture();partial.c.d.capture=async()=>partial.state.reads++?{SLV:33100}:{SLV:33100,LNV:34000};eq(await partial.c.request(partial.owner,'driving'),'Seat position changed or is incomplete; release controls and retry');
 const expired=fixture();await expired.c.request(expired.owner,'driving');expired.state.now+=C.LEASE_MS;expired.c.check();eq(expired.c.active(),false);eq(expired.state.commits,[]);
 const park=fixture();await park.c.request(park.owner,'driving');park.state.reason='Fresh P required';park.c.check();eq(park.c.active(),false);eq(park.state.commits,[]);
 const pending=fixture();let resolve;pending.c.d.capture=()=>new Promise(r=>{resolve=r;});const first=pending.c.request(pending.owner,'driving');eq(await pending.c.request(pending.owner,'driving'),'Calibration read pending');pending.c.cancel('socket closed');resolve({SLV:33100});eq(await first,'Calibration cancelled');eq(pending.state.commits,[]);
 const lost=fixture();let done;lost.c.d.capture=()=>new Promise(r=>{done=r;});const read=lost.c.request(lost.owner,'driving');lost.state.reason='Fresh P required';done({SLV:33100});eq(await read,'Fresh P required');eq(lost.c.reference,null);eq(lost.state.commits,[]);
 const disk=fixture();await disk.c.request(disk.owner,'driving');disk.state.pos.SLV-=200;await disk.c.request(disk.owner,'limit');disk.state.pos.SLV+=50;disk.state.fail=true;eq(await disk.c.request(disk.owner,'exit'),'disk failed');eq(disk.c.active(),true);eq(disk.state.commits,[]);
 for(const drive of ['fixed','adaptive'])for(const exit of ['fixed','adaptive']) {
  const f=legacy.serviceFixture({settings:{driverExitMode:drive,driverExitTargetMode:exit},memories:{driver:[{SLV:33100}]},exit:{driver:{SLV:32900}}},{realCalibration:true});
  f.hooks.car.speed=0;f.hooks.car.speedAt=100000;f.hooks.gear('03');f.hooks.door('000000000000000000000000000000');f.hooks.cond('0a000112020802');f.hooks.cond('0a000112020a02');await tick();eq(f.hooks.driverExit.last.result,'complete driver calibration first');f.hooks.cond('0a000112020c02');await tick();eq(f.hooks.driverExit.last.result,'complete driver calibration first');eq(f.events.filter(e=>Array.isArray(e)&&e[0]==='recall'),[]);
  eq(f.request({op:'set',settings:{driverExitMode:'fixed'}})[0].error,'Complete driver calibration first');
 }
 const original={settings:{driverExitMode:'fixed'},memories:{driver:[{SLV:33000},{SLV:33010},{SLV:33020}],passenger:[{SLV:33111}]},exit:{driver:{SLV:32900},passenger:{SLV:32800}}};
 const f=legacy.serviceFixture(original,{realCalibration:true,realPolicyDeps:true}),h=f.hooks,replies=[],client={write:s=>replies.push(JSON.parse(s))};
 h.car.speed=0;h.car.speedAt=100000;h.gear('03');let pos={SLV:33100,LNV:34000};h.mover.read=async()=>Object.assign({},pos);
 h.request(client,{op:'calibrate',action:'driving'});await tick();eq(h.calibration.active(),true);eq(h.calibration.view(client).owned,true);eq(h.status().state.driverExit.calibrated,false);
 const blocked=[];h.request({write:s=>blocked.push(JSON.parse(s))},{op:'memory',seat:'driver',slot:0});eq(blocked[0].error,'Finish or cancel calibration first; use physical controls');eq(h.data.memories.driver[0].SLV,33000);
 pos={SLV:32755,LNV:34100};h.request(client,{op:'calibrate',action:'limit'});await tick();eq(h.calibration.active(),true);eq(h.status().state.driverExit.calibrated,false);eq(h.data.memories.driver[0].SLV,33000);pos={SLV:32900,LNV:34200};h.request(client,{op:'calibrate',action:'exit'});await tick();eq(h.calibration.active(),false);eq(h.status().state.driverExit.calibrated,true);eq(h.data.settings.driverRelativeLimit,{rear:32785,direction:-1});eq(h.data.settings.driverCalibrationVersion,1);eq(h.data.memories.driver,[{SLV:33100,LNV:34000},{SLV:33010},{SLV:33020}]);eq(h.data.exit.driver,{SLV:32900,LNV:34200});eq(h.data.memories.passenger[0],{SLV:33111});eq(h.data.exit.passenger,{SLV:32800});eq(h.data.settings.easyExit,true);eq(h.data.pre.driver,{SLV:33100,LNV:34000});eq(h.data.out.driver,pos);eq(h.data.relativeExit.driver,null);eq(f.events.filter(e=>Array.isArray(e)&&e[0]==='recall'),[]);eq(replies.filter(r=>r.calibrationReply).map(r=>r.calibrationReply),['driving','limit','exit']);
 const saved=JSON.parse(f.files['/fake/data.json']);eq(saved.settings.driverCalibrationVersion,1);eq(saved.exit.driver.SLV,32900);
 // Recalibration is available after success. Abort and failures preserve old positions.
 const before=JSON.stringify(h.data);h.request(client,{op:'calibrate',action:'driving'});await tick();h.request(client,{op:'calibrate',action:'cancel'});await tick();eq(JSON.stringify(h.data),before);eq(h.calibration.active(),false);
 // Persist failure cannot publish the new settings in memory.
 const g=legacy.serviceFixture(original,{realCalibration:true,realPolicyDeps:true});g.hooks.car.speed=0;g.hooks.car.speedAt=100000;g.hooks.gear('03');g.hooks.mover.read=async()=>({SLV:33100});const c={write:()=>{}};g.hooks.request(c,{op:'calibrate',action:'driving'});await tick();g.hooks.mover.read=async()=>({SLV:32755});g.hooks.request(c,{op:'calibrate',action:'limit'});await tick();g.hooks.mover.read=async()=>({SLV:32900});const dataBefore=JSON.stringify(g.hooks.data);const fsWrite=g.files;Object.freeze(fsWrite); // fake writes throw under strict service mode
 g.hooks.request(c,{op:'calibrate',action:'exit'});await tick();eq(g.hooks.calibration.active(),true);eq(JSON.stringify(g.hooks.data),dataBefore);eq(g.hooks.calibration.message,'Calibration was not saved; previous settings retained');
 // A new helper baseline cannot complete an old calibration capture.
 h.request(client,{op:'calibrate',action:'driving'});await tick();h.resetAutomaticSource('test helper loss');eq(h.calibration.active(),false);eq(JSON.stringify(h.data),before);
 // Calibration cannot race an earlier app Save callback or an in-flight motor cleanup.
 const race=legacy.serviceFixture(original,{realCalibration:true,realPolicyDeps:true});race.hooks.car.speed=0;race.hooks.car.speedAt=100000;race.hooks.gear('03');let finishSave;race.hooks.mover.read=()=>new Promise(r=>{finishSave=r;});race.request({op:'memory',seat:'driver',slot:1,save:true});const blockedCal=[];race.hooks.request({write:s=>blockedCal.push(JSON.parse(s))},{op:'calibrate',action:'driving'});await tick();eq(blockedCal[0].error,'Seat control is busy');eq(race.hooks.calibration.active(),false);finishSave({SLV:33100});await tick();eq(race.hooks.data.memories.driver[1],{SLV:33100});
 race.hooks.mover.busy=true;race.hooks.request({write:s=>blockedCal.push(JSON.parse(s))},{op:'calibrate',action:'driving'});await tick();eq(blockedCal[blockedCal.length-2].error,'Seat control is busy');eq(race.hooks.calibration.active(),false);
 eq(P.calibrated({settings:P.settings(),memories:{driver:[{SLV:33100}]},exit:{driver:{SLV:32900}}}),false);
 const invalid=JSON.parse(JSON.stringify(h.data));invalid.memories.driver[0].SLV=100000;eq(P.calibrated(invalid),false);
 console.log('calibration: '+checks+' assertions passed (fake controls, snapshots and storage only)');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
