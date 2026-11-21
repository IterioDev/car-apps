"use strict";
// Reuse the proven driver planner through an explicit passenger data view. No transport or timers.
const driver=require('./driver-access');
const MAP={easyExit:'passengerEasyExit',driverExitMode:'passengerExitMode',driverExitTargetMode:'passengerExitTargetMode',driverExitLevel:'passengerExitLevel',driverCalibrationVersion:'passengerCalibrationVersion',driverRelativeLimit:'passengerRelativeLimit'};
function settings(raw){raw=raw||{};return {passengerEasyExit:raw.passengerEasyExit===true,passengerExitMode:raw.passengerExitMode==='adaptive'?'adaptive':'fixed',passengerExitTargetMode:raw.passengerExitTargetMode==='adaptive'?'adaptive':'fixed',passengerExitLevel:[1,2,3].indexOf(raw.passengerExitLevel)>=0?raw.passengerExitLevel:2,passengerCalibrationVersion:raw.passengerCalibrationVersion===1?1:0,passengerRelativeLimit:driver.validCalibration(raw.passengerRelativeLimit)?{rear:raw.passengerRelativeLimit.rear,direction:raw.passengerRelativeLimit.direction}:null};}
function project(data){
 const view={},props=(object,keys,get,set)=>{keys.forEach(k=>Object.defineProperty(object,k,{enumerable:true,get:()=>get(k),set:v=>set(k,v)}));return object;};
 view.settings=props({},Object.keys(MAP),k=>data.settings[MAP[k]],(k,v)=>{data.settings[MAP[k]]=v;});
 ['memories','exit','pre','out','relativeExit'].forEach(name=>{view[name]=props({},['driver'],()=>data[name]&&data[name].passenger,(k,v)=>{if(!data[name])data[name]={};data[name].passenger=v;});});
 return view;
}
function rearDirection(data){return driver.rearDirection(project(data));}
function updateSettings(data,patch,busy){
 if(!patch||typeof patch!=='object'||Array.isArray(patch))return 'invalid passenger settings';
 const reverse={};Object.keys(MAP).forEach(k=>{reverse[MAP[k]]=k;});const translated={};
 for(const k of Object.keys(patch)){if(!reverse[k]||k==='passengerCalibrationVersion')return 'unknown passenger setting';translated[reverse[k]]=patch[k];}
 const error=driver.updateSettings(project(data),translated,busy);
 if(!error&&Object.keys(patch).some(k=>k!=='passengerEasyExit'))data.passengerCycle=false;
 return error&&error.replace(/driver/g,'passenger');
}
class PassengerExit{
 constructor(d){this.d=d;this.lastOccupancy=null;this.waitingReturn=false;this.waitingUntil=0;const self=this;
  this.core=new driver.DriverExit(Object.assign({},d,{data:project(d.data),occupied:()=>true,
   log:message=>d.log(message.replace('driver easy exit','passenger automation')),
   move:async(p,out,context)=>{
    if(self.core.action)self.core.action.started=true;
    if(out){d.data.passengerCycle=true;d.save();}
    const result=await d.move(p,out,Object.assign({},context,{parkedOnly:true}));
    if(!out&&result==='done'){d.data.passengerCycle=false;d.save();}
    return result;
   }}));
  const blocked=this.core.blocked.bind(this.core),request=this.core.request.bind(this.core),cancel=this.core.cancel.bind(this.core);
  this.core.cancel=function(reason,notify){self.waitingReturn=false;return cancel(reason,notify);};
  this.core.blocked=function(a){const reason=blocked(a);if(reason)return reason;
   if(!d.parked())return 'car not standing';
   if(!a.manual){
    if(!a.started&&d.manualBusy&&d.manualBusy())return 'manual controls active';
    const o=d.occupancy();
    if(!o.ready)return o.reason||'passenger occupancy unavailable';
    // An authorized outward move may finish after departure; never a new move or return.
    if(o.classification!=='occupied'&&!(a.which==='exit'&&a.started&&o.classification==='empty'))return 'passenger '+o.classification;
   }
   return null;
  };
  this.core.request=function(which,reason,manual){
   if(!manual&&which==='driving'&&!d.data.passengerCycle){this.report(which,reason,'no passenger exit cycle');return;}
   self.waitingReturn=false;
   if(!manual&&which==='driving'&&['driver door','vehicle condition'].indexOf(reason)>=0&&this.doorValue===false&&this.conditionValue===10){const o=d.occupancy();self.waitingReturn=!!(d.data.settings.passengerEasyExit&&driver.position(this.target('driving',driver.mode(this.d.data.settings.driverExitMode)))&&d.parked()&&d.returnReady()&&(!d.manualBusy||!d.manualBusy())&&d.executionEnabled()&&(!o.ready||o.classification!=='occupied'));}
   if(self.waitingReturn)self.waitingUntil=(d.now?d.now():Date.now())+1500;
   return request(which,reason,manual);
  };
 }
 get action(){return this.core.action;}get last(){const a=this.core.last;return a?Object.assign({},a,{reason:a.reason==='driver door'?'passenger door':a.reason}):null;}
 condition(v){if(v!==10)this.waitingReturn=false;this.core.condition(v);}
 door(v){if(v!==false)this.waitingReturn=false;this.core.door(v);}
 check(){if(this.waitingReturn&&(this.d.now?this.d.now():Date.now())>=this.waitingUntil)this.waitingReturn=false;this.core.check();}
 cancel(reason,notify){this.core.cancel(reason,notify);}
 reset(reason){this.lastOccupancy=null;this.waitingReturn=false;this.core.reset(reason);}
 request(which,reason,manual){return this.core.request(which,reason,manual);}
 occupancy(){const v=this.d.occupancy(),was=this.lastOccupancy;this.lastOccupancy=v.ready?v.classification:'unknown';this.check();
  if(this.waitingReturn&&this.lastOccupancy==='occupied'&&was!=='occupied'&&this.d.data.passengerCycle&&this.core.doorValue===false&&this.core.conditionValue===10&&!this.core.action)this.core.request('driving','passenger occupancy');
 }
}
module.exports={MAP,settings,project,rearDirection,updateSettings,PassengerExit};
