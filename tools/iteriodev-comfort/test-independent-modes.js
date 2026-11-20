"use strict";
// Dependency-free tests. Every mover, timer, socket and target process is fake.
const assert=require('assert'),fs=require('fs'),vm=require('vm'),path=require('path');
const P=require('./driver-access'),legacy=require('./test-driver-access');
const calibration={rear:32850,direction:-1};
let checks=0;const eq=(a,b)=>{assert.deepStrictEqual(a,b);checks++;},ok=x=>{assert.ok(x);checks++;},tick=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
function fixture(drive,exit,level,start) {
 const data={settings:P.settings({driverExitMode:drive,driverExitTargetMode:exit,driverExitLevel:level,driverRelativeLimit:calibration}),memories:{driver:[{SLV:33107,LNV:34000}]},exit:{driver:{SLV:32948,LNV:34100}},pre:{driver:null},out:{driver:null},relativeExit:{driver:null}};
 const state={pos:{SLV:start===undefined?33107:start,LNV:34000},P:true,standing:true,armed:true,occupied:true};let time=1000;
 const queue=[],moves=[],captures=[],logs=[];
 const d=new P.DriverExit({data,calibrated:()=>true,parked:()=>state.standing,inPark:()=>state.P,occupied:()=>state.occupied,returnReady:()=>true,executionEnabled:()=>state.armed,now:()=>time,wait:async()=>{},capture:async()=>{captures.push(1);return Object.assign({},state.pos);},current:async()=>Object.assign({},state.pos),move:async(t,out,ctx)=>{if(ctx.permission())return ctx.permission();moves.push({target:Object.assign({},t),out,parkedOnly:ctx.parkedOnly});Object.assign(state.pos,t);return 'done';},schedule:(n,f)=>queue.push(f),stopAutomatic:()=>{},save:()=>{},changed:()=>{},log:x=>logs.push(x)});
 d.door(false);d.condition(10);time=2000;
 return {data,d,state,moves,captures,queue,logs,flush:async()=>{while(queue.length)await queue.shift()();}};
}
(async()=>{
 eq(P.settings({driverExitMode:'fixed'}),{easyExit:true,driverExitMode:'fixed',driverExitTargetMode:'fixed',driverExitLevel:2,driverRelativeLimit:null,driverCalibrationVersion:0});
 for(let level=1;level<=3;level++) {eq(P.relativeTarget({SLV:33300},level,-1).target.SLV,33300-[75,150,225][level-1]);eq(P.relativeTarget({SLV:32860},level,-1).target.SLV,32860-[75,150,225][level-1]);}
 for(const n of [32850,32849,32000])eq(P.relativeTarget({SLV:n},3,-1).target.SLV,n-225);
 for(const n of [NaN,Infinity,-1,65536,undefined])eq(P.relativeTarget({SLV:n},2,-1),null);
 eq(P.relativeTarget({SLV:33107},4,-1),null);
 for(const drive of ['fixed','adaptive'])for(const exit of ['fixed','adaptive'])for(const level of [1,2,3]) {
  const f=fixture(drive,exit,level);f.d.door(true);await f.flush();eq(f.moves.length,1);
  eq(f.moves[0].target.SLV,exit==='fixed'?32948:Math.max(32850,33107-[75,150,225][level-1]));
  eq(Object.keys(f.moves[0].target).sort(),exit==='fixed'?['LNV','SLV']:['SLV']);
  f.d.condition(12);await f.flush(); // another exit trigger must reuse relative destination
  if(exit==='fixed')eq(f.moves[1].target,f.moves[0].target);else eq(f.moves.length,1);
  if(exit==='adaptive'){eq(f.captures.length,1);eq(f.data.relativeExit.driver.anchor.SLV,33107);}
  f.d.door(false);f.d.condition(10);await f.flush();eq(f.moves[f.moves.length-1].target,{SLV:33107,LNV:34000});eq(f.moves[f.moves.length-1].parkedOnly,drive==='adaptive');eq(f.data.relativeExit.driver,null);
 }
 const cycle=fixture('adaptive','adaptive',2);cycle.d.door(true);await cycle.flush();cycle.state.pos.SLV=32970;cycle.d.request('exit','app');await cycle.flush();eq(cycle.captures.length,1);eq(cycle.data.pre.driver.SLV,33107);eq(cycle.moves[1].target.SLV,32957);
 const atLimit=fixture('adaptive','adaptive',3,32840);atLimit.d.door(true);await atLimit.flush();eq(atLimit.moves.length,1);eq(atLimit.moves[0].target.SLV,32615);eq(atLimit.data.pre.driver.SLV,32840);
 const moved=fixture('adaptive','adaptive',2);moved.d.door(true);await moved.flush();moved.state.pos.SLV+=100;moved.d.door(false);await moved.flush();eq(moved.moves.length,1);eq(moved.d.last.result,'moved since: stays'); // coupe fix deliberately deferred
 const near=fixture('adaptive','adaptive',2);near.d.door(true);await near.flush();near.state.pos.SLV+=32;near.d.door(false);await near.flush();eq(near.moves.length,2);
 const disabled=fixture('fixed','adaptive',2);disabled.data.settings.easyExit=false;disabled.d.door(true);await disabled.flush();eq(disabled.moves.length,0);disabled.d.request('exit','app',true);await disabled.flush();eq(disabled.moves.length,1);
 const disarmed=fixture('fixed','adaptive',2);disarmed.state.armed=false;disarmed.d.door(true);await disarmed.flush();eq(disarmed.captures.length,0);eq(disarmed.moves.length,0);
 for(const reason of ['P','standing','off','reset','stop','mode']) {
  const f=fixture('fixed','adaptive',3);f.d.door(true);
  if(reason==='P')f.state.P=false;if(reason==='standing')f.state.standing=false;if(reason==='off')f.data.settings.easyExit=false;if(reason==='reset')f.d.reset();if(reason==='stop')f.d.cancel();if(reason==='mode')f.data.settings.driverExitLevel=1;
  await f.flush();eq(f.moves.length,0);eq(f.captures.length,0);
 }
 const captureStop=fixture('adaptive','adaptive',2);let done;captureStop.d.d.capture=()=>new Promise(r=>{done=r;});captureStop.d.door(true);const pending=captureStop.queue.shift()();await tick();captureStop.d.cancel();done({SLV:33107});await pending;eq(captureStop.data.relativeExit.driver,null);eq(captureStop.data.pre.driver,null);eq(captureStop.moves.length,0);
 const settings=fixture('adaptive','adaptive',2);settings.data.pre.driver={SLV:33107};const before=JSON.stringify(settings.data);
 eq(P.updateSettings(settings.data,{driverExitLevel:3},true),'seat job active');eq(JSON.stringify(settings.data),before);
 for(const patch of [{driverExitLevel:0},{driverExitLevel:4},{driverExitLevel:2.5},{driverExitLevel:'2'},{driverExitMode:'foo'},{easyExit:1},{unknown:true}]){ok(P.updateSettings(settings.data,patch,false));eq(JSON.stringify(settings.data),before);}
 eq(P.updateSettings(settings.data,{driverExitTargetMode:'fixed',driverExitLevel:3},false),null);eq(settings.data.pre.driver,null);eq(settings.data.settings.driverExitLevel,3);

 // Explicit calibration is generic in count direction, and never defaults to an owner's car.
 eq(P.relativeTarget({SLV:33107},2,null),null);
 for(const invalid of [null,{},[],{rear:32850},{rear:32850,direction:0},{rear:8191,direction:-1},{rear:57345,direction:1},{rear:32850.5,direction:-1},{rear:32850,direction:-1,extra:true}])eq(P.validCalibration(invalid),false);
 eq(P.relativeTarget({SLV:33000},3,1),{target:{SLV:33225}});
 eq(P.relativeTarget({SLV:57300},1,1),null);
 const missing=fixture('fixed','adaptive',2);missing.data.settings.driverRelativeLimit=null;missing.data.exit.driver=null;missing.d.door(true);await missing.flush();eq(missing.moves.length,0);eq(missing.captures.length,0);eq(missing.d.last.result,'Save Easy Exit behind Driving to establish rearward direction');
 eq(P.updateSettings(missing.data,{easyExit:false},false),null);eq(missing.data.settings.easyExit,false);
 eq(P.updateSettings(missing.data,{driverExitTargetMode:'adaptive'},false),null);
 eq(P.updateSettings(missing.data,{driverRelativeLimit:calibration},false),'unknown setting');
 const held=fixture('fixed','adaptive',2);const heldBefore=JSON.stringify(held.data);eq(P.updateSettings(held.data,{driverExitLevel:3},true),'seat job active');eq(JSON.stringify(held.data),heldBefore);
 held.d.door(true);held.data.settings.driverRelativeLimit={rear:32870,direction:1};held.d.check();await held.flush();eq(held.moves.length,0);
 const copy=fixture('fixed','fixed',2),external={rear:32850,direction:-1};eq(P.settings({driverRelativeLimit:external}).driverRelativeLimit.rear,32850);eq(P.rearDirection(copy.data),-1);
 // Real service wiring and migration, all filesystem/transport/mover effects remain fake.
 const raw={settings:{driverExitMode:'fixed',driverExitTargetMode:'adaptive',driverExitLevel:1,driverRelativeLimit:calibration},memories:{driver:[{SLV:33107}]}},f=legacy.serviceFixture(raw,{realPolicyDeps:true});
 f.hooks.car.speed=0;f.hooks.car.speedAt=100000;f.hooks.mover.read=async()=>({SLV:33107});f.hooks.door('000000000000000000000000000000');f.hooks.cond('0a000112020a02');f.hooks.gear('03');f.hooks.door('000001000000000000000000000000');await tick();
 const recalls=f.events.filter(e=>Array.isArray(e)&&e[0]==='recall');eq(recalls.length,1);eq(recalls[0][2].SLV,33032);eq(f.hooks.status().state.driverExit.relativeConfigured,true);eq(f.hooks.status().state.driverExit.passengerAutomationSupported,true);
 f.hooks.door('000001010000000000000000000000');await tick();eq(f.events.filter(e=>Array.isArray(e)&&e[0]==='recall').length,1);
 const fresh=legacy.serviceFixture({},{realCalibration:true});eq(fresh.hooks.data.settings.driverRelativeLimit,null);eq(fresh.hooks.status().state.driverExit.relativeConfigured,false);fresh.request({op:'set',settings:{driverExitTargetMode:'adaptive'}});eq(fresh.hooks.data.settings.driverExitTargetMode,'adaptive');
 console.log('independent modes: '+checks+' assertions passed (synthetic positions; no car I/O)');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
