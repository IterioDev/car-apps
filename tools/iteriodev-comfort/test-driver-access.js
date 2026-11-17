"use strict";
// Fake clock, scheduler, mover, filesystem, sockets and child processes only.
const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm'),EE=require('events');
const policy=require('./driver-access');let checks=0;
function eq(a,b){assert.deepStrictEqual(a,b);checks++;}
const ticks=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
function fixture(selected){
 const data={settings:policy.settings({driverExitMode:selected}),exit:{driver:{SLV:20}},pre:{driver:null},memories:{driver:[{SLV:80}]}};
 const state={parked:true,P:true,occupied:true,ready:true,armed:true,captures:0,stops:0,saves:0,capture:{SLV:55},result:'done'};
 const queued=[],moves=[],contexts=[];
 const d=new policy.DriverExit({data,calibrated:()=>true,parked:()=>state.parked,inPark:()=>state.P,occupied:()=>state.occupied,returnReady:()=>state.ready,
 executionEnabled:()=>state.armed,capture:async()=>{state.captures++;return state.capture;},
 move:async(p,out,c)=>{moves.push([p.SLV,out]);contexts.push(c);return state.result;},
 schedule:(name,fn)=>queued.push(fn),stopAutomatic:()=>state.stops++,save:()=>state.saves++,changed:()=>{},log:()=>{}});
 return {d,data,state,queued,moves,contexts,flush:async()=>{while(queued.length)await queued.shift()();}};
}
function baseline(f){f.d.door(false);f.d.condition(10);}
async function policyTests(){
 eq(policy.settings(),{easyExit:true,driverExitMode:'adaptive',driverExitTargetMode:'fixed',driverExitLevel:2,driverRelativeLimit:null,driverCalibrationVersion:0});
 eq(policy.settings({easyExit:false,driverExitMode:'bad'}),{easyExit:false,driverExitMode:'adaptive',driverExitTargetMode:'fixed',driverExitLevel:2,driverRelativeLimit:null,driverCalibrationVersion:0});
 for(let q=0;q<256;q++)eq(policy.decodeCondition('0a000112020a'+q.toString(16).padStart(2,'0')),q===2?10:null);
 ['','0a','00000000000a','00000000000a0200','ZZ000000000a02'].forEach(s=>eq(policy.decodeCondition(s),null));
 eq(policy.transition(null,10),null);eq(policy.transition(8,10),'driving');eq(policy.transition(7,8),null);
 eq(policy.transition(10,12),'exit');eq(policy.transition(8,12),null);eq(policy.transition(10,10),null);
 for(const m of ['fixed','adaptive']){
  const f=fixture(m);baseline(f);eq(f.queued.length,0);
  f.d.door(true);await f.flush();f.d.door(false);await f.flush();
  eq(f.moves,[[20,true],[m==='fixed'?80:55,false]]);eq(f.state.captures,m==='adaptive'?1:0);eq(f.data.pre.driver,null);
  eq(f.contexts[1].parkedOnly,m!=='fixed');
  f.moves.length=0;f.d.condition(12);f.d.condition(null);await f.flush();eq(f.moves,[[20,true]]);
  f.d.condition(8);await f.flush();eq(f.moves.length,1);f.d.condition(10);await f.flush();eq(f.moves[1],[m==='fixed'?80:55,false]);
  f.d.condition(null);f.d.condition(10);eq(f.queued.length,0); // recovered10 is baseline, not a replay
 }
 for(const m of ['fixed','adaptive']){
  const p=fixture(m);baseline(p);p.state.P=false;p.d.door(true);eq(p.queued.length,0);eq(p.d.last.result,'P unavailable or not selected');
  p.state.P=true;p.d.check();eq(p.queued.length,0);p.d.door(false);await p.flush();
  const q=fixture(m);baseline(q);q.d.door(true);q.state.P=false;q.d.check();await q.flush();eq(q.moves,[]);eq(q.state.stops,1);
  const source=fixture(m);baseline(source);source.d.door(true);source.d.reset('source lost');source.d.door(false);source.d.condition(10);await source.flush();eq(source.moves,[]);
  const off=fixture(m);off.data.settings.easyExit=false;baseline(off);off.d.door(true);off.d.condition(12);eq(off.queued.length,0);
  const disarmed=fixture(m);disarmed.state.armed=false;baseline(disarmed);disarmed.d.door(true);eq(disarmed.queued.length,0);eq(disarmed.state.captures,0);
 }
 const fixed=fixture('fixed');fixed.state.parked=false;fixed.state.P=false;fixed.d.door(false);fixed.d.condition(8);eq(fixed.queued.length,0);fixed.d.condition(10);await fixed.flush();eq(fixed.moves,[[80,false]]);
 eq(fixed.contexts[0].parkedOnly,false);eq(fixed.contexts[0].permission(),'cancelled'); // finished jobs cannot dispatch delayed writes
 const adaptive=fixture('adaptive');adaptive.data.pre.driver={SLV:55};adaptive.state.parked=false;adaptive.d.door(false);adaptive.d.condition(8);adaptive.d.condition(10);await adaptive.flush();eq(adaptive.moves,[]);eq(adaptive.d.last.result,'car not standing');
 const snap=fixture('fixed');snap.d.door(false);snap.d.condition(8);snap.d.condition(10);snap.data.memories.driver[0].SLV=99;await snap.flush();eq(snap.moves,[[80,false]]);
 const missing=fixture('fixed');missing.data.memories.driver[0]=null;missing.d.door(false);missing.d.condition(8);missing.d.condition(10);eq(missing.d.last.result,'app Memory 1 not saved');
 const noPrior=fixture('adaptive');noPrior.d.door(false);noPrior.d.condition(8);noPrior.d.condition(10);eq(noPrior.d.last.result,'no prior position');
 const capture=fixture('adaptive');baseline(capture);let resolve;capture.d.d.capture=()=>new Promise(r=>{resolve=r;});capture.d.door(true);
 const running=capture.queued.shift()();capture.d.cancel();resolve({SLV:55});await running;eq(capture.moves,[]);eq(capture.data.pre.driver,null);
 const busy=fixture('adaptive');busy.data.pre.driver={SLV:70};eq(policy.setMode(busy.data,'fixed',true),'seat job active');eq(busy.data.pre.driver.SLV,70);
 eq(policy.setMode(busy.data,'fixed',false),null);eq(busy.data.pre.driver,null);eq(policy.setMode(busy.data,'wrong',false),'invalid driver return mode');
 const active=fixture('fixed');baseline(active);let finishMove;active.d.d.move=(p,out,c)=>{active.contexts.push(c);return new Promise(r=>{finishMove=r;});};
 active.d.door(true);const pending=active.queued.shift()();await ticks();active.state.P=false;active.d.check();eq(active.state.stops,1);eq(active.contexts[0].permission(),'cancelled');finishMove('done');await pending;eq(active.d.last.result,'P unavailable or not selected');
 const returning=fixture('fixed');returning.d.door(false);returning.d.condition(8);returning.d.condition(10);let endReturn;
 returning.d.d.move=(p,out,c)=>{returning.contexts.push(c);return new Promise(r=>{endReturn=r;});};
 const back=returning.queued.shift()();await ticks();returning.state.P=false;returning.state.parked=false;returning.d.check();eq(returning.state.stops,0);eq(returning.contexts[0].permission(),null);
 returning.data.settings.easyExit=false;returning.d.check();eq(returning.state.stops,1);eq(returning.contexts[0].permission(),'cancelled');endReturn('done');await back;
 const changed=fixture('fixed');baseline(changed);changed.d.door(true);changed.d.door(false);await changed.flush();eq(changed.moves,[[80,false]]);eq(changed.d.last.result,'done');
 const invalidDoor=fixture('fixed');baseline(invalidDoor);invalidDoor.d.door(null);invalidDoor.d.door(true);eq(invalidDoor.queued.length,0);
}
function serviceFixture(raw,options){
 options=options||{};const files={},events=[],timers=[];let clock=100000;
 const fakefs={readFileSync:()=>JSON.stringify(raw||{}),mkdirSync:()=>{},unlinkSync:()=>{},chmodSync:()=>{},writeFileSync:(p,v)=>{files[p]=v;},renameSync:(a,b)=>{files[b]=files[a];delete files[a];}};
 const noIO=()=>{throw new Error('Live I/O attempted');};const server=new EE();server.listen=(p,cb)=>{if(cb)cb();};
 class Mover{constructor(){this.pos={driver:{},passenger:{},wheel:{}};this.motion=null;this.hasWheel=false;}
 axes(){return ['SLV'];}hall(){return true;}probe(){events.push('probe');}read(s){events.push(['read',s]);return Promise.resolve({SLV:55});}
 recall(s,p,parkedOnly,permission){events.push(['recall',s,p,parkedOnly,permission&&permission()]);return Promise.resolve('done');}halt(){events.push('halt');}jog(){events.push('jog');}}
 const req=id=>{
  if(id==='fs')return fakefs;if(id==='net')return {createServer:()=>server};if(id==='path')return path;
  if(id==='child_process')return {spawn:options.spawn||noIO};if(id==='./uds')return {Uds:class{beginShutdown(){}}};
  if(id==='./seat')return {Mover,AXES:['SLV']};if(id==='./calibration')return require('./calibration');if(id==='./driver-access')return policy;if(id==='./ambient')return require('./ambient');throw new Error(id);
 };
 const module={exports:{}};const context={module,require:req,__dirname,Buffer,Date:class extends Date{static now(){return clock;}},console:{log:()=>{}},process:{env:{COMFORT_DATA:'/fake/data.json'},argv:[],exit:options.exit||(()=>{})},setTimeout:(f,ms)=>{timers.push({f,ms});return timers.length;},clearTimeout:()=>{},setInterval:noIO};
 let source=fs.readFileSync(path.join(__dirname,'comfort.js'),'utf8');if(options.armed)source=source.replace('const DRIVER_MOVEMENT_ARMED = false;','const DRIVER_MOVEMENT_ARMED = true;');
 const marker='    subscribe();';eq(source.split(marker).length,2);
 source=source.replace(marker,'    module.exports.hooks={cond,door,gear,inPark,resetAutomaticSource,hmi,request,status,data,car,mover,driverExit,calibration}; return;');source+='\nmodule.exports.startForTest=main;';
 vm.runInNewContext(source,context,{filename:'comfort.js'});eq(events,[]);module.exports.startForTest();const hooks=module.exports.hooks;if(!options.realCalibration)hooks.driverExit.d.calibrated=()=>true;const rawDoor=hooks.door;hooks.door=(hex,event)=>rawDoor(hex,event===undefined?0x8001:event);
 if(!options.realPolicyDeps){hooks.driverExit.d.wait=async()=>{};hooks.driverExit.d.current=async()=>({SLV:55});}
 return {hooks,events,files,timers,advance:ms=>{clock+=ms;},request:q=>{const replies=[];hooks.request({write:v=>replies.push(JSON.parse(v))},q);return replies;}};
}
const cond=n=>'0a00011202'+n.toString(16).padStart(2,'0')+'02';
const door=(d,p)=>{const b=Buffer.alloc(15);b[2]=d?1:0;b[3]=p?1:0;return b.toString('hex');};
async function serviceTests(){
 const raw={settings:{driverExitMode:'fixed'},memories:{driver:[{SLV:80}]},exit:{driver:{SLV:20},passenger:{SLV:30}}};
 const f=serviceFixture(raw);f.hooks.car.speed=0;f.hooks.car.speedAt=100000;f.hooks.door(door(false,false));f.hooks.cond(cond(8));eq(f.hooks.driverExit.last,null);
 f.hooks.gear('03');eq(f.hooks.inPark(),true);f.advance(2000);eq(f.hooks.inPark(),false);f.hooks.gear('04');eq(f.hooks.inPark(),false);f.hooks.gear('not hex');eq(f.hooks.car.gear,null);
 f.request({op:'set',settings:{easyExit:false}});eq(f.hooks.data.settings.easyExit,false);eq(f.events.filter(x=>x==='halt').length,0);
 f.request({op:'jog',seat:'passenger',axis:'SLV',dir:1});eq(f.events[f.events.length-1],'jog');
 const g=serviceFixture(raw,{armed:true});g.hooks.door(door(false,false));g.hooks.cond(cond(8));g.hooks.cond(cond(10));await ticks();
 eq(JSON.stringify(g.events),JSON.stringify([['recall','driver',{SLV:80},false,null]]));g.events.length=0;
 g.hooks.car.speed=0;g.hooks.car.speedAt=100000;g.hooks.gear('03');g.hooks.door(door(true,false));await ticks();
 eq(JSON.stringify(g.events),JSON.stringify([['recall','driver',{SLV:20},true,null]]));
 const passenger=serviceFixture({settings:{easyExit:false},pre:{passenger:{SLV:60}},exit:{passenger:{SLV:30}}});
 passenger.hooks.car.speed=0;passenger.hooks.car.speedAt=100000;passenger.hooks.cond(cond(10));passenger.hooks.door(door(false,false));await ticks();eq(passenger.events,[]);
 passenger.hooks.door(door(false,true));await ticks();eq(passenger.events,[]);
 passenger.request({op:'memory',seat:'driver',slot:0,save:false});eq(passenger.events,[]);
 const deferredPassenger=serviceFixture({exit:{passenger:{SLV:30}}});deferredPassenger.hooks.car.speed=0;deferredPassenger.hooks.car.speedAt=100000;deferredPassenger.hooks.door(door(false,false),0x8001);deferredPassenger.hooks.door(door(false,true),0x8001);await ticks();eq(deferredPassenger.events.filter(e=>Array.isArray(e)&&e[0]==='recall').length,0);
 const manual=serviceFixture(raw);manual.hooks.car.speed=9999;manual.hooks.car.speedAt=100000;manual.request({op:'memory',seat:'driver',slot:0,save:false});await ticks();
 eq(JSON.stringify(manual.events),JSON.stringify([['recall','driver',{SLV:80},null,null]]).replace(',null,null',',null,null')); // undefined args stringify as null
 const manualBusy=serviceFixture(raw);let finishManual;manualBusy.hooks.mover.recall=()=>new Promise(r=>{finishManual=r;});manualBusy.request({op:'memory',seat:'driver',slot:0,save:false});eq(manualBusy.request({op:'set',settings:{driverExitMode:'adaptive'}})[0].error,'seat job active');eq(manualBusy.hooks.data.settings.driverExitMode,'fixed');manualBusy.request({op:'set',settings:{easyExit:false}});eq(manualBusy.events,[]);manualBusy.request({op:'stop'});eq(manualBusy.events,['halt']);finishManual('done');await ticks();
 const malformed=serviceFixture(raw);malformed.hooks.cond(cond(10));malformed.hooks.door('000001');eq(malformed.hooks.driverExit.doorValue,null);malformed.hooks.cond('0a000112020a0e');eq(malformed.hooks.driverExit.conditionValue,null);
 const stopCapture=serviceFixture({exit:{driver:{SLV:20}}},{armed:true});stopCapture.hooks.car.speed=0;stopCapture.hooks.car.speedAt=100000;stopCapture.hooks.gear('03');stopCapture.hooks.door(door(false,false));stopCapture.hooks.cond(cond(10));
 let resolveRead;stopCapture.hooks.mover.read=()=>new Promise(r=>{resolveRead=r;});stopCapture.hooks.door(door(true,false));eq(typeof resolveRead,'function');stopCapture.request({op:'stop'});resolveRead({SLV:55});await ticks();eq(stopCapture.events,['halt']);eq(stopCapture.hooks.data.pre.driver,null);
 // A helper exit rejects queued old traffic, resets baselines and cannot replay a cached P.
 const children=[];const spawn=()=>{const c=new EE();c.stdout=new EE();c.stdin=new EE();c.stdin.write=()=>{};c.kill=()=>{};c.writes=[];c.stdin.write=line=>c.writes.push(line);children.push(c);return c;};
 const lost=serviceFixture(raw,{spawn});lost.hooks.gear('03');lost.hooks.cond(cond(10));const first=lost.hooks.hmi('sub one'),second=lost.hooks.hmi('sub two');
 children[0].emit('exit',1);eq(await first,'error hmictl exited');eq(await second,'error hmictl exited');eq(children.length,1);eq(lost.hooks.inPark(),false);eq(lost.hooks.driverExit.conditionValue,null);
 children[0].stdout.emit('data','ev 0x1536 0x8004 03\n');eq(lost.hooks.inPark(),false);
 const noSpawn=serviceFixture(raw,{spawn:()=>{throw new Error('spawn failed');}});eq(await noSpawn.hooks.hmi('call old'),'error hmictl failed to start');eq(noSpawn.hooks.driverExit.conditionValue,null);
 const dispatch=serviceFixture(raw,{spawn});let allow=true;const before=children.length;const one=dispatch.hooks.hmi('sub first');const two=dispatch.hooks.hmi('call cancelled',false,undefined,()=>allow?null:'cancelled');allow=false;children[before].stdout.emit('data','ok\n');eq(await one,'ok');eq(await two,'error cancelled');eq(children[before].writes,['sub first\n']);
}
async function udsTests(){
 const source=fs.readFileSync(path.join(__dirname,'uds.js'),'utf8'),module={exports:{}};
 vm.runInNewContext(source,{module,exports:module.exports,require,Buffer,console,process:{argv:[]},setTimeout:()=>1,clearTimeout:()=>{}},{filename:'uds.js'});
 const wire=[];const u=new module.exports.Uds((line,low,cleanup,permission)=>{wire.push({line,permission});return Promise.resolve('ok');});
 let allowed=true;const first=u.send(0x6d,0x22,[0xd7,0x02]);
 const second=u.send(0x6d,0x2e,[0xd7,0x08,0,1,100],()=>allowed?null:'cancelled');
 const rejected=second.then(()=>{throw new Error('Cancelled queued write resolved')},e=>e.message);
 allowed=false;u.finish([0x62],null);eq(await first,[0x62]);eq(await rejected,'cancelled');eq(wire.length,1);
 const failed=new module.exports.Uds(()=>Promise.reject(new Error('transport failed')));eq(await failed.send(0x6d,0x22,[0xd7,0x02]).then(()=>'',e=>e.message),'transport failed');eq(failed.cur,null);
 const pass=u.send(0x6d,0x2e,[0xd7,0x08,0,1,100],()=>null);eq(typeof wire[1].permission,'function');u.finish([0x6e],null);eq(await pass,[0x6e]);
}
async function moverTests(){
 const source=fs.readFileSync(path.join(__dirname,'seat.js'),'utf8'),module={exports:{}};let now=100000;
 const context={module,exports:module.exports,require,Buffer,console,process:{argv:[]},Date:class extends Date{static now(){return now;}},setInterval:()=>1,clearInterval:()=>{},setTimeout:f=>{now+=50;Promise.resolve().then(f);}};
 vm.runInNewContext(source,context,{filename:'seat.js'});const Mover=module.exports.Mover;
 function mover(standing){const stops=[],writes=[];const m=new Mover({send:async(u,s,d)=>{stops.push([s,d]);return [];}},()=>standing);m.session=async()=>{};m.hall=()=>true;m.read=async()=>({SLV:10});m.write=async()=>{writes.push('move');};return {m,stops,writes};}
 const fixed=mover(false);eq(await fixed.m.drive('driver','SLV',1,()=> 'there',{limit:1000,parkedOnly:false,permission:()=>null}),'there');eq(fixed.writes.length,1);eq(fixed.stops.length,2);
 const adaptive=mover(false);eq(await adaptive.m.drive('driver','SLV',1,()=> 'there',{limit:1000,parkedOnly:true,permission:()=>null}),'not parked');eq(adaptive.writes.length,0);
 const wheel=mover(false);eq(await wheel.m.drive('wheel','HGT',1,()=> 'there',{limit:1000,parkedOnly:false,permission:()=>null}),'not parked');eq(wheel.writes.length,0); // column exemption remains gated
 const lost=mover(true);let denied=null;lost.m.write=async()=>{lost.writes.push('move');denied='P unavailable or not selected';};eq(await lost.m.drive('driver','SLV',1,()=>null,{limit:1000,parkedOnly:true,permission:()=>denied}),'P unavailable or not selected');eq(lost.writes.length,1);eq(lost.stops.length,2);
 const capture=mover(true);let block=null;capture.m.read=async()=>{block='cancelled';return {SLV:0};};capture.m.drive=()=>{throw new Error('axis must not start after cancelled read');};eq(await capture.m.recall('driver',{SLV:20},false,()=>block),'cancelled');
}
async function run(){const watchdog=setTimeout(()=>{throw new Error('Test did not settle')},5000);try{await policyTests();await serviceTests();await udsTests();await moverTests();}finally{clearTimeout(watchdog);}console.log('driver access: '+checks+' assertions passed (fake vehicle dependencies only)');}
module.exports={run,serviceFixture,fixture};if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});
