import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readNativeGroupLog} from '../dashboard/group-log.mjs';

const e=(seq)=>({seq,event_id:`event-${seq}`,kind:'message.member',payload:{text:`message ${seq}`}});
test('groups.log drains every page using cursor, not latest_seq',async()=>{
  const seen=[];
  const result=await readNativeGroupLog(async({since_seq,limit})=>{
    seen.push([since_seq,limit]);
    if(since_seq===0)return {events:[e(1),e(2)],cursor:2,latest_seq:6,has_more:true};
    if(since_seq===2)return {events:[e(3),e(4)],cursor:4,latest_seq:6,has_more:true};
    return {events:[e(5),e(6)],cursor:6,latest_seq:6,has_more:false};
  },{limit:2});
  assert.deepEqual(seen,[[0,2],[2,2],[4,2]]);
  assert.deepEqual(result.events.map(e=>e.seq),[1,2,3,4,5,6]);
  assert.equal(result.cursor,6);
  assert.equal(result.has_more,false);
});
test('bounded polling saves only events already read and resumes on next tick',async()=>{
  const page=async({since_seq})=>({events:[e(since_seq+1)],cursor:since_seq+1,latest_seq:4,has_more:since_seq+1<4});
  const first=await readNativeGroupLog(page,{maxPages:2});
  assert.deepEqual(first.events.map(e=>e.seq),[1,2]);
  assert.equal(first.cursor,2);
  assert.equal(first.has_more,true);
  const second=await readNativeGroupLog(page,{since:first.cursor,maxPages:2});
  assert.deepEqual(second.events.map(e=>e.seq),[3,4]);
  assert.equal(second.cursor,4);
});
test('initial sync uses numeric cursor zero and empty logs remain valid',async()=>{
  const result=await readNativeGroupLog(async request=>{
    assert.deepEqual(request,{since_seq:0,limit:200});
    return {events:[],cursor:0,latest_seq:0,has_more:false};
  });
  assert.deepEqual(result,{events:[],cursor:0,has_more:false});
});
test('malformed cursors and non-progressing replay fail safely',async()=>{
  const fail=async p=>assert.rejects(()=>readNativeGroupLog(async()=>p),/inválida|fuera de orden|no coincide|no avanza/);
  await fail({events:[e(1)],cursor:10,latest_seq:10,has_more:true});
  await fail({events:[],cursor:0,latest_seq:10,has_more:true});
  await fail({events:[e(1),e(1)],cursor:1,latest_seq:10,has_more:true});
  await fail({events:[e(3)],cursor:3,latest_seq:5,has_more:false});
  await fail({events:[e(1)],cursor:1,latest_seq:0,has_more:false});
  await fail({events:[e(1)],cursor:1,latest_seq:10});
  await assert.rejects(()=>readNativeGroupLog(async()=>{throw new Error('gateway offline')}),/gateway offline/);
});
