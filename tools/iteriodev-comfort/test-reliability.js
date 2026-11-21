"use strict";
// Regression events and fake axis feedback only. No transport, sockets or live I/O.
const assert=require('assert'),fs=require('fs'),vm=require('vm'),path=require('path'),P=require('./driver-access');let checks=0;
const eq=(a,b)=>{assert.deepStrictEqual(a,b);checks++;};
function fixture(){let clock=100000;const jobs=[],moves=[],logs=[],data={settings:{easyExit:true,driverExitMode:'fixed',driverExitTargetMode:'adaptive',driverExitLevel:2,driverRelativeLimit:{rear:32850,direction:-1}},memories:{driver:[{SLV:33107}]},exit:{driver:{SLV:32950}},pre:{driver:null},relativeExit:{driver:null}};
 const d=new P.DriverExit({entryRecovery:true,data,now:()=>clock,wait:async()=>{},calibrated:()=>true,calibrating:()=>false,occupied:()=>true,returnReady:()=>true,executionEnabled:()=>true,parked:()=>true,inPark:()=>true,capture:async()=>({SLV:33107}),current:async()=>({SLV:32957}),move:async(p,out)=>{moves.push([p.SLV,out]);return 'done';},schedule:(n,fn)=>jobs.push(fn),save:()=>{},changed:()=>{},log:s=>logs.push(s),stopAutomatic:()=>{}});
 return {d,data,jobs,moves,logs,advance:n=>{clock+=n;},flush:async()=>{while(jobs.length)await jobs.shift()();}};}
async function policy(){
 let f=fixture();f.d.door(true);f.d.door(false);f.d.condition(10);await f.flush();eq(f.moves,[[33107,false]]); // observed unknown->10 gap
 f=fixture();f.d.door(true);f.d.condition(8);f.d.condition(10);await f.flush();eq(f.moves,[]);f.d.door(false);await f.flush();eq(f.moves,[[33107,false]]);
 for(const cancel of ['stop','reset','reopen','expiry','disabled','manual','mode','preset deleted','disarmed']){
  f=fixture();f.d.door(true);f.d.door(false);
  if(cancel==='stop'||cancel==='manual')f.d.cancel(cancel,false);
  if(cancel==='reset')f.d.reset('helper reset');
  if(cancel==='reopen')f.d.door(true);
  if(cancel==='expiry')f.advance(10001);
  if(cancel==='disabled')f.data.settings.easyExit=false;
  if(cancel==='mode')f.data.settings.driverExitMode='adaptive';
  if(cancel==='preset deleted')f.data.memories.driver[0]=null;
  if(cancel==='disarmed')f.d.d.executionEnabled=()=>false;
  f.d.condition(10);await f.flush();eq(f.moves,[]);
 }
 f=fixture();f.d.door(true);f.d.door(false);f.d.condition(10);f.advance(10001);await f.flush();eq(f.moves,[]);
 f=fixture();f.d.door(false);f.d.condition(10);await f.flush();eq(f.moves,[]);f.d.condition(null);f.d.condition(10);await f.flush();eq(f.moves,[]);
 f=fixture();f.d.door(true);f.d.door(false);f.d.condition(10);f.d.condition(10);await f.flush();eq(f.moves.length,1);
 f=fixture();f.d.d.move=async(p,out,c)=>{f.advance(10001);eq(c.permission(),null);f.moves.push([p.SLV,out]);return 'done';};f.d.door(true);f.d.door(false);f.d.condition(10);await f.flush();eq(f.moves,[[33107,false]]);
 for(const type of ['recover','persistent','cancel','manual','other']){
  f=fixture();f.d.door(false);f.d.condition(10);let reads=0;
  f.d.d.capture=async()=>{reads++;if(type!=='recover'||reads===1)throw Error(type==='other'?'different failure':'refused by the gateway');return {SLV:33107};};
  if(type==='cancel')f.d.d.wait=async()=>{f.d.cancel('Stop',false);};
  if(type==='manual')f.d.request('exit','app',true);else f.d.condition(12);
  await f.flush();eq(reads,['recover','persistent'].indexOf(type)>=0?2:1);eq(f.moves.length,type==='recover'?1:0);
 }
}
const moduleFake={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'seat.js'),'utf8'),{module:moduleFake,require:()=>{throw Error('unexpected dependency');},setTimeout:f=>{Promise.resolve().then(f);return 1;},setInterval:()=>1,clearInterval:()=>{},Date,console,process:{argv:[]},Buffer});
async function motor(){const M=moduleFake.exports.Mover;
 async function run(values,options){options=options||{};const m=new M({},()=>true);let reads=0,drives=0,stopped=false;m.read=async()=>({SLV:values[Math.min(reads++,values.length-1)]});m.drive=async()=>{drives++;if(options.stop)stopped=true;return options.end?'end stop':'there';};m.pulse=()=>0;m.nap=async()=>{};const result=await m.approach('driver','SLV',33107,false,Date.now(),()=>stopped?'cancelled':null);return {result,reads,drives,m};}
 let r=await run([32957,33123,33123,33084,33084]);eq(r.result,'short');eq(r.drives,1);eq(r.m.lastApproachReason,'reverse pulse estimate unavailable');
 r=await run([32957,33084,33107]);eq(r.result,'there');eq(r.drives,1); // settling confirmation prevents correction
 r=await run([32957,33084,undefined]);eq(r.result,'position feedback lost');eq(r.drives,1);
 r=await run([undefined]);eq(r.result,'position feedback lost');eq(r.drives,0);
 r=await run([33100]);eq(r.result,'there');eq(r.drives,0);
 r=await run([32957,33084],{stop:true});eq(r.result,'cancelled');eq(r.reads,1);
 r=await run([32957,33084],{end:true});eq(r.result,'short');eq(r.drives<=4,true);
 const m=new M({},()=>true);m.approach=async()=> 'short';eq(await m.recall('driver',{SLV:33107},false),'short');m.approach=async()=> 'position unverified';eq(await m.recall('driver',{SLV:33107},false),'position unverified');
}
(async()=>{await policy();await motor();console.log('reliability: '+checks+' assertions passed (fake events/position feedback only)');})().catch(e=>{console.error(e);process.exitCode=1;});
