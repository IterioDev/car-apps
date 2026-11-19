'use strict';
// Node 8. All clocks, helper processes, sockets and vehicle replies are fake.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert'),EE=require('events');
const root=path.resolve(process.argv[2]||__dirname),service=fs.readFileSync(path.join(root,'comfort.js'),'utf8').replace(/\r\n/g,'\n');
let checks=0;const eq=(a,b)=>{assert.deepStrictEqual(a,b);checks++;},ok=(v,m)=>{assert.ok(v,m);checks++;};
const ticks=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
const watch=setTimeout(()=>{console.error('shutdown test did not settle');process.exit(1);},5000);
const start=service.indexOf('    function shutdown() {');
const snippet=service.slice(start>=0?start:service.indexOf("    process.on('SIGTERM'"),service.indexOf('    log(`comfort:'));
async function stopping(fail,ambient,deadlineOnly,delayedAmbient,wheel){
 const events=[],timers=[],acks=[],module={exports:{}};let exited=null,kills=0,handler,haltCalls=0,release;
 const timer=(fn,ms)=>{const t={fn,ms,active:true};timers.push(t);return t;};
 vm.runInNewContext(fs.readFileSync(path.join(root,'seat.js'),'utf8'),{module,require:()=>{throw Error('unexpected import');},Buffer,process:{argv:[]},console,setInterval:()=>1,setTimeout:timer,clearTimeout:t=>{if(t)t.active=false;}});
 const m=new module.exports.Mover({send:(target,sid,data)=>{eq(target,wheel?0x40:0x6d);eq(Array.from(data),wheel?[0xd0,0x72,0,0]:[0xd7,8,0,0,0]);return new Promise((resolve,reject)=>{events.push('STOP');acks.push(()=>{events.push('reply');if(fail)reject(Error('test failure'));else resolve([0x6e]);});});}},()=>true,()=>{});
 m.hall=()=>false;m.session=async()=>{};m.write=async()=>events.push('motor');const halt=m.halt.bind(m);m.halt=()=>{haltCalls++;halt();};
 if(wheel)m.read=async()=>{m.wheel={norm:1,soft:{LEN:{1:false}},moving:true};return {LEN:10};};
 const move=m.drive(wheel?'wheel':'driver',wheel?'LEN':'SLV',1,()=>null,{});await ticks();eq(m.busy,true);
 const ctx={shuttingDown:false,transportClosed:false,busy:null,queue:[],lowQueue:[],SEATS:['driver','passenger'],want:{driver:{},passenger:{}},SHUTDOWN_LIMIT_MS:20000,mover:m,busyJob:null,autoRun:false,writing:!!delayedAmbient,lightTimer:null,saveTimer:null,busyTimer:null,data:{},save:()=>{},log:x=>events.push(x),diag:{beginShutdown:()=>events.push('gate'),send:()=>{events.push('ambient release');return delayedAmbient?new Promise(r=>{release=r;}):Promise.resolve();}},lit:ambient,mods:ambient?[{}]:null,amb:{BDC:64,release:()=>[]},child:{kill:()=>{kills++;}},process:{on:(n,f)=>{handler=f;},exit:c=>{exited=c;}},setTimeout:timer,clearTimeout:t=>{if(t)t.active=false;}};
 vm.runInNewContext(snippet,ctx);handler();handler();await ticks();eq(kills,0);eq(haltCalls,1);eq(ctx.want.driver,null);eq(ctx.want.passenger,null);eq(acks.length,1);
 if(deadlineOnly){timers.find(t=>t.ms===20000).fn();eq(exited,1);eq(kills,1);ok(events.some(x=>x.includes('deadline')));return;}
 acks.shift()();await ticks();eq(kills,0);eq(acks.length,1);acks.shift()();await move;await ticks();
 if(delayedAmbient){eq(events.includes('ambient release'),false);ctx.writing=false;}
 const poll=timers.find(t=>t.ms===20&&t.active);ok(poll);poll.fn();await ticks();
 if(delayedAmbient){eq(kills,0);ok(release);release();await ticks();}
 eq(kills,1);eq(exited,fail?1:0);eq(events.includes('ambient release'),ambient);eq(ctx.transportClosed,true);eq(m.stopFailures,fail?2:0);
}
async function transport(){
 const U=require(path.join(root,'uds')),wire=[],u=new U.Uds((l,low,cleanup)=>{wire.push({l,cleanup});return Promise.resolve('ok');});u.arm=()=>{};
 const current=u.send(0x6d,0x22,[0xd7,2]);const queued=u.send(0x6d,0x2e,[0xd7,8,0,1,100]).then(()=>'',e=>e.message);const stop=u.send(0x6d,0x2e,[0xd7,8,0,0,0]);
 await ticks();u.beginShutdown();u.beginShutdown();eq(await queued,'service shutting down');eq(wire.length,1);u.finish([0x62]);await current;await ticks();eq(wire.length,2);eq(wire[1].cleanup,true);u.finish([0x6e]);await stop;
 eq(await u.send(0x6d,0x2e,[0xd7,8,0,1,100]).then(()=>'',e=>e.message),'service shutting down');eq(wire.length,2);
 const release=u.send(0x40,0x2e,[0xd5,0],undefined,true);await ticks();eq(wire[2].cleanup,true);u.finish([0x6e]);await release;
}
function fixture(){
 const timers=[],children=[],commands=[],logs=[],writes=[];let now=100000,exited=null,halted=0;
 const server=new EE();server.listen=(p,f)=>{if(f)f();};
 const fakefs={readFileSync:()=>JSON.stringify({memories:{driver:[{SLV:33000}]},exit:{driver:{SLV:32900}}}),mkdirSync:()=>{},unlinkSync:()=>{},chmodSync:()=>{},statSync:()=>({size:0}),appendFileSync:()=>{},writeFileSync:(p,b)=>writes.push(p),renameSync:()=>{}};
 class FakeUds {constructor(hmi){this.hmi=hmi;}beginShutdown(){this.stopping=true;}send(t,sid,data,ms,cleanup){if(this.stopping&&!cleanup)return Promise.reject(Error('service shutting down'));commands.push({t,sid,data,cleanup});return Promise.resolve([]);}onEvent(){}}
 class Mover {constructor(uds){this.uds=uds;this.pos={driver:{},passenger:{}};this.stopFailures=0;this.hasWheel=false;}axes(){return ['SLV'];}hall(){return true;}halt(){halted++;}probe(){}read(){return Promise.resolve({SLV:33000});}recall(){return this.uds.send(0x6d,0x2e,[0xd7,8,0,1,100]).then(()=> 'done');}jog(){commands.push('jog');}}
 const spawn=()=>{const c=new EE();c.stdout=new EE();c.stdin=new EE();c.stdin.write=l=>c.lines.push(l.trim());c.lines=[];c.kill=()=>{c.killed=true;};children.push(c);return c;};
 const req=id=>{if(id==='fs')return fakefs;if(id==='net')return {createServer:()=>server};if(id==='path')return path;if(id==='child_process')return {spawn};if(id==='./ambient')return require('./ambient');if(id==='./uds')return {Uds:FakeUds};if(id==='./seat')return {Mover,AXES:['SLV']};throw Error(id);};
 const mod={exports:{}};const context={module:mod,require:req,__dirname:root,Buffer,console:{log:l=>logs.push(l)},Date:class extends Date{static now(){return now;}},process:{argv:[],env:{},on:()=>{},exit:c=>{exited=c;}},setInterval:()=>1,setTimeout:(fn,ms)=>{const t={fn,ms,active:true};timers.push(t);return t;},clearTimeout:t=>{if(t)t.active=false;}};
 const marker='    subscribe();\n    setInterval';ok(service.includes(marker));const s=service.replace(marker,'    module.exports.hooks={shutdown,request,hmi,subscribe,poll,door,cond,mover,diag,data};return;\n    setInterval');vm.runInNewContext(s,context,{filename:'fake-service.js'});
 const h=mod.exports.hooks;return {h,commands,children,timers,logs,writes,advance:ms=>{now+=ms;},exited:()=>exited,halted:()=>halted,request:q=>{let reply;h.request({write:s=>{reply=JSON.parse(s);}},q);return reply;}};
}
async function serviceGates(){
 const f=fixture();f.h.shutdown();f.h.shutdown();eq(f.halted(),1);eq(f.exited(),0);
 for(const q of [{op:'jog',seat:'driver',axis:'SLV',dir:1},{op:'memory',seat:'driver',slot:0},{op:'exit',seat:'driver'},{op:'set',settings:{easyExit:false}},{op:'ambient',settings:{on:true}}])eq(f.request(q).error,'service shutting down');
 f.h.cond('0a000112020a02');f.h.door('000001000000000000000000000000');f.h.subscribe();f.h.poll('call test',()=>{});await ticks();eq(f.commands.filter(c=>c.sid!==0x22).length,0);eq(f.children.length,0);eq(await f.h.hmi('sub later'),'error service shutting down');
 // A capture already awaiting its read cannot become a new movement after shutdown.
 const capture=fixture();capture.h.cond('0a000112020102');let finish;capture.h.mover.read=()=>new Promise(r=>{finish=r;});capture.request({op:'exit',seat:'driver'});await ticks();ok(finish);capture.h.shutdown();finish({SLV:33000});await ticks();eq(capture.commands.filter(c=>c.sid!==0x22).length,0);
 // An acknowledged deferred save does not change saved memories after shutdown.
 const save=fixture();let finishSave;save.h.mover.read=()=>new Promise(r=>{finishSave=r;});save.request({op:'memory',seat:'driver',slot:1,save:true});save.h.shutdown();finishSave({SLV:33100});await ticks();eq(save.h.data.memories.driver[1],null);
 // Helper remains alive for allowed cleanup, normal queued lines are discarded.
 const q=fixture();q.h.mover.busy=true;const first=q.h.hmi('call ordinary in-flight'),pending=q.h.hmi('call queued motor');q.h.shutdown();const stop=q.h.hmi('call STOP',false,true);await ticks();eq(await pending,'error service shutting down');eq(q.children[0].lines.length,1);q.children[0].stdout.emit('data','ok\n');await first;await ticks();eq(q.children[0].lines[1],'call STOP');q.children[0].stdout.emit('data','ok\n');await stop;
 q.children[0].emit('exit',1);eq(q.timers.some(t=>t.ms===2000),false);eq(await q.h.hmi('call STOP again',false,true),'error service shutting down');eq(q.children.length,1);
}
(async()=>{await stopping(false,false,false,false);await stopping(false,true,false,false);await stopping(true,false,false,false);await stopping(false,false,true,false);await stopping(false,true,false,true);await stopping(false,false,false,false,true);await transport();await serviceGates();const unit=fs.readFileSync(path.join(root,'iteriodev-comfort.service'),'utf8');ok(unit.includes('TimeoutStopSec=25s'));clearTimeout(watch);console.log('shutdown: '+checks+' assertions passed (fake vehicle/process/time only)');})().catch(e=>{clearTimeout(watch);console.error(e.stack);process.exitCode=1;});