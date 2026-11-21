'use strict';
const assert = require('assert');
const driver = require('./driver-access');
const { serviceFixture } = require('./test-driver-access');

const flush = async () => { for (let i = 0; i < 120; i++) await Promise.resolve(); };
const door = (open) => open ? '000001000000000000000000000000' : '000000000000000000000000000000';
const condition = n => '0a00011202' + n + '02';
const eq = (a,b) => assert.strictEqual(a,b);

async function test() {
    const f = serviceFixture({settings:{easyExit:false}}, {realPolicyDeps:true});
    const h = f.hooks;
    h.car.speed = 0; h.car.speedAt = 100000;
    h.door(door(false)); h.cond(condition('0a'));
    h.gear('03');
    eq(f.request({op:'calibrate',seat:'driver',action:'driving'})[0].error, 'Use SET on the Seats screen to save a position');
    f.request({op:'set',settings:{easyExit:true,driverExitMode:'fixed',driverExitTargetMode:'fixed'}});
    eq(h.data.settings.easyExit, true);
    h.door(door(true)); await flush();
    eq(h.driverExit.last.result, 'Exit not saved');
    assert(!f.events.some(e=>Array.isArray(e)&&e[0]==='recall'));
    eq(h.status().state.driverExit.relativeConfigured, false);

    let live = {SLV:33100};
    h.mover.read = async () => live;
    f.request({op:'memory',seat:'driver',slot:0,save:true}); await flush();
    live = {SLV:32900};
    f.request({op:'exit',seat:'driver',save:true}); await flush();
    eq(h.data.memories.driver[0].SLV,33100);
    eq(h.data.exit.driver.SLV,32900);
    eq(h.status().state.driverExit.relativeConfigured,true);
    eq(h.status().state.calibration,undefined);

    let result = 'done';
    const targets = [];
    h.mover.recall = async (seat, target) => { targets.push([seat,target.SLV]); return result; };
    f.request({op:'exit',seat:'driver'}); await flush();
    eq(targets[0][1],32900); // Fixed Exit uses the ordinary preset exactly.

    f.request({op:'set',settings:{driverExitTargetMode:'adaptive',driverExitLevel:3}});
    eq(h.data.settings.driverExitTargetMode,'adaptive');
    result = 'no progress';
    f.request({op:'exit',seat:'driver'}); await flush();
    eq(targets[1][1],32675); // Adaptive target can extend beyond the ordinary saved Exit pose.
    eq(h.data.relativeExit.driver.terminal,'no progress');
    f.request({op:'exit',seat:'driver'}); await flush();
    eq(targets.length,2); // Another trigger cannot push on the same suspected endpoint.

    result = 'done';
    f.request({op:'memory',seat:'driver',slot:0,save:false}); await flush();
    eq(targets[2][1],33100);
    eq(h.data.relativeExit.driver,null);
    live = {SLV:33100};
    result = 'STOP unconfirmed';
    f.request({op:'exit',seat:'driver'}); await flush();
    eq(targets[3][1],32875);
    eq(h.data.relativeExit.driver.terminal,'STOP unconfirmed');
    f.request({op:'exit',seat:'driver'}); await flush();
    eq(targets.length,4);

    const unseeded = serviceFixture({settings:{driverExitTargetMode:'adaptive'}},{realPolicyDeps:true});
    unseeded.hooks.car.speed = 0; unseeded.hooks.car.speedAt = 100000;
    unseeded.request({op:'exit',seat:'driver'}); await flush();
    eq(unseeded.hooks.driverExit.last.result,'Save Easy Exit behind Driving to establish rearward direction');
    assert(!unseeded.events.some(e=>Array.isArray(e)&&e[0]==='recall'));

    const migrated = {settings:{driverRelativeLimit:{rear:32790,direction:-1}},memories:{driver:[{SLV:33100}]},exit:{driver:{SLV:32900}}};
    eq(driver.rearDirection(migrated),-1);
    eq(driver.relativeTarget({SLV:32800},2,driver.rearDirection(migrated)).target.SLV,32650);
    migrated.settings.driverRelativeLimit=null;
    migrated.exit.driver={SLV:33200};
    eq(driver.rearDirection(migrated),1);
    eq(driver.relativeTarget({SLV:33200},1,1).target.SLV,33275);
    migrated.exit.driver={SLV:33101};
    eq(driver.rearDirection(migrated),null);
    console.log('Saved-position setup, both sensor directions, migration and terminal Exit cycle passed (fake service and mover)');
}
test().catch(e=>{console.error(e);process.exitCode=1;});
