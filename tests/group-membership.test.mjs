import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findNativeRoom, isMembershipChanged, assertNativeMembershipEditable, assertNativeRoomMembers } from '../dashboard/group-membership.mjs';

test('membership compares native roster, ignoring order', () => {
  assert.equal(isMembershipChanged(['alpha','beta'],['beta','alpha']),false);
  assert.equal(isMembershipChanged(['alpha'],['alpha','beta']),true);
  assert.equal(assertNativeRoomMembers(['beta','alpha'], {room_id:'r',members:[{member_id:'alpha'},{profile:'beta'}]}),true);
  assert.throws(() => assertNativeRoomMembers(['alpha'],{room_id:'r',members:[{member_id:'beta'}]}),/no coinciden/);
  assert.throws(() => assertNativeRoomMembers(['alpha'],{room_id:'r'}),/no coinciden/);
});

test('finds a hosted room across pages using next_offset', async () => {
  const seen=[];
  const target={room_id:'wanted',members:[{member_id:'alpha'}]};
  const found=await findNativeRoom('wanted',async ({offset})=>{
    seen.push(offset);
    if(offset===0) return {rooms:[{room_id:'a'}],next_offset:250};
    if(offset===250) return {rooms:[{room_id:'b'}],next_offset:500};
    return {rooms:[target],next_offset:null};
  });
  assert.deepEqual(seen,[0,250,500]);
  assert.equal(found,target);
  assert.throws(() => assertNativeMembershipEditable(['alpha'],['beta'],found),/membresía/);
});

test('only a complete list can show a room has not been created',async()=>{
  const result=await findNativeRoom('missing',async ({offset})=>offset===0
    ? {rooms:[{room_id:'other'}],next_offset:250}
    : {rooms:[],next_offset:null});
  assert.equal(result,null);
  assert.equal(assertNativeMembershipEditable(['alpha'],['beta'],result),true);
  assert.equal(assertNativeMembershipEditable(['alpha'],['alpha'],{room_id:'x'}),true);
});

test('missing, repeated, invalid and endless cursor streams fail closed',async()=>{
  await assert.rejects(()=>findNativeRoom('x',async()=>({rooms:[]})),/paginación/);
  await assert.rejects(()=>findNativeRoom('x',async()=>({rooms:[],next_offset:0})),/paginación/);
  await assert.rejects(()=>findNativeRoom('x',async()=>({rooms:[],next_offset:'250'})),/paginación/);
  await assert.rejects(()=>findNativeRoom('x',async()=>({rooms:'bad',next_offset:null})),/inválida/);
  await assert.rejects(()=>findNativeRoom('x',async({offset})=>({rooms:[],next_offset:offset+250}),{maxPages:2}),/demasiado grande/);
  await assert.rejects(()=>findNativeRoom('x',async()=>{throw Error('offline');}),/offline/);
});
