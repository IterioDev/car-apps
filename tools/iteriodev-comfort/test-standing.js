'use strict';
// Fake filesystem, helper, clock and mover only; never opens a real socket or sends diagnostics.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert'),EE=require('events');
const source=fs.readFileSync(path.resolve(process.argv[2]||path.join(__dirname,'comfort.js')),'utf8').replace(/\r\n/g,'\n');
let checks=0;const eq=(a,b)=>{assert.deepStrictEqual(a,b);checks++;},tick=async()=>{for(let i=0;i<70;i++)await Promise.resolve();};
function fixture(){
 let now=100000;const commands=[],children=[],timers=[],mod={exports:{}};
 const fakefs={readFileSync:()=>JSON.stringify({memories:{driver:[{SLV:33000}]},exit:{driver:{SLV:32900}}}),mkdirSync:()=>{},unlinkSync:()=>{},chmodSync:()=>{},statSync:()=>({size:0}),appendFileSync:()=>{},writeFileSync:()=>{},renameSync:()=>{}};
 const server=new EE();server.listen=(p,f)=>{if(f)f();};
 class Uds{send(){throw Error('unexpected diagnostic request');}onEvent(){}}
 class Mover{constructor(){this.pos={driver:{SLV:33000},passenger:{SLV:33000}};this.hasWheel=false;}axes(){return ['SLV'];}hall(){return true;}halt(){}probe(){}read(){return Promise.resolve({SLV:33000});}recall(){commands.push('memory');return Promise.resolve('done');}room(){commands.push('room');return Promise.resolve({why:'done',was:{SLV:33000}});}jog(){commands.push('jog');}}
 const spawn=()=>{const c=new EE();c.stdin=new EE();c.stdout=new EE();c.stdin.write=()=>{};c.kill=()=>{};children.push(c);return c;};
 const req=id=>{if(id==='fs')return fakefs;if(id==='net')return {createServer:()=>server};if(id==='path')return path;if(id==='child_process')return {spawn};if(id==='./uds')return {Uds};if(id==='./seat')return {Mover,AXES:['SLV']};if(id==='./ambient')return require('./ambient');throw Error(id);};
 const ctx={module:mod,require:req,__dirname,Buffer,console:{log:()=>{}},Date:class extends Date{static now(){return now;}},process:{argv:[],env:{},on:()=>{},exit:()=>{}},setTimeout:(f,ms)=>{timers.push({f,ms});return timers.length;},clearTimeout:()=>{},setInterval:()=>1};
 const marker='    subscribe();\n    setInterval';assert(source.includes(marker));vm.runInNewContext(source.replace(marker,'    module.exports.h={car,cond,door,status,request,hmi};return;\n    setInterval'),ctx,{filename:'fake-standing-service.js'});
 const h=mod.exports.h;return {h,commands,children,timers,now:()=>now,advance:n=>{now+=n;},standing:()=>h.status().state.parked,request:q=>h.request({write:()=>{}},q)};
}
const condition=(n,q=2)=>'0a00011202'+n.toString(16).padStart(2,'0')+q.toString(16).padStart(2,'0');
(async()=>{
 const initial=fixture();eq(initial.standing(),false);initial.request({op:'gentleman'});await tick();eq(initial.commands,[]);initial.h.door('000000000000000000000000000000');initial.h.door('000001000000000000000000000000');await tick();eq(initial.commands,[]);
 for(const v of [1,2,3,5]){const f=fixture();f.h.cond(condition(v));eq(f.standing(),true);f.advance(60000);eq(f.standing(),true);f.request({op:'gentleman'});await tick();eq(f.commands,['room']);}
 for(const v of [7,8,10,12,4,255]){const f=fixture();f.h.cond(condition(v));eq(f.standing(),false);}
 for(const bad of ['',null,'zz','0a00011202010200',condition(1,14),condition(3,7)]){const f=fixture();f.h.cond(condition(1));eq(f.standing(),true);f.h.cond(bad);eq(f.standing(),false);}
 const speed=fixture();speed.h.car.speed=0;speed.h.car.speedAt=speed.now();eq(speed.standing(),true);speed.h.car.speed=128;eq(speed.standing(),false);speed.h.car.rpm=0;speed.h.car.rpmAt=speed.now();eq(speed.standing(),false); // fresh moving speed takes precedence
 speed.h.car.speed=0;speed.advance(3000);eq(speed.standing(),false);
 const rpm=fixture();rpm.h.car.rpm=3200;rpm.h.car.rpmAt=rpm.now();eq(rpm.standing(),true);rpm.h.car.rpm=4000;eq(rpm.standing(),false);rpm.advance(3000);rpm.h.car.rpm=0;eq(rpm.standing(),false);
 const fallback=fixture();fallback.h.cond(condition(1));fallback.h.car.speed=6400;fallback.h.car.speedAt=fallback.now();eq(fallback.standing(),false);fallback.advance(3000);eq(fallback.standing(),true);
 const future=fixture();future.h.car.speed=0;future.h.car.speedAt=future.now()+1;eq(future.standing(),false);
 for(const event of ['exit','error','stdin-error']){
  const f=fixture();f.h.cond(condition(1));f.h.car.speed=0;f.h.car.speedAt=f.now();f.h.car.rpm=0;f.h.car.rpmAt=f.now();eq(f.standing(),true);const pending=f.h.hmi('sub fake');
  if(event==='exit'){f.children[0].emit('exit',1);await pending;}else if(event==='error')f.children[0].emit('error',Error('fake'));else f.children[0].stdin.emit('error',Error('fake'));
  eq(f.standing(),false);eq(f.h.car.speedAt,0);eq(f.h.car.rpmAt,0);f.h.cond(condition(1));eq(f.standing(),true);
 }
 const manual=fixture();manual.h.car.speed=6400;manual.h.car.speedAt=manual.now();manual.request({op:'jog',seat:'driver',axis:'SLV',dir:1});manual.request({op:'memory',seat:'driver',slot:0});await tick();eq(manual.commands,['jog','memory']);manual.request({op:'gentleman'});await tick();eq(manual.commands,['jog','memory']);
 console.log('standing guard: '+checks+' assertions passed (fake inputs/processes only)');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});