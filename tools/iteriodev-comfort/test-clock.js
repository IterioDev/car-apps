'use strict';
class Clock {
 constructor(o){this.now=100000;this.o=o;this.timers=[];this.id=0;this.seed=o.seed||1;this.events=0;}
 late(){if(this.o.jitter==='seeded'){this.seed=(Math.imul(this.seed,1664525)+1013904223)>>>0;return this.seed%((this.o.maxJitter||4)+1);}return this.o.jitter||0;}
 add(f,ms,period){const id=++this.id;const delay=Math.max(this.o.minimumTimer===undefined?1:this.o.minimumTimer,Number(ms)||0);this.timers.push({id,f,at:this.now+delay+this.late(),period});return id;}
 clear(id){this.timers=this.timers.filter(t=>t.id!==id);}
 async flush(){for(let n=0;n<60;n++)await Promise.resolve();}
 async run(promise){let done=false,result,error;Promise.resolve(promise).then(x=>{done=true;result=x;},e=>{done=true;error=e;});
  for(;;){await this.flush();if(done){if(error)throw error;return result;}this.timers.sort((a,b)=>a.at-b.at||a.id-b.id);const t=this.timers.shift();if(!t)throw Error('No pending timer with unsettled operation');if(++this.events>30000||t.at>400000)throw Error('Simulation exceeded bounded event/time budget');this.now=t.at;if(t.period)this.timers.push({id:t.id,f:t.f,at:this.now+t.period+this.late(),period:t.period});t.f();}
 }
}
module.exports = { Clock };
