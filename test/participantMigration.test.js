const test=require('node:test');
const assert=require('node:assert/strict');
const Event=require('../models/Event');
const FormConfig=require('../models/FormConfig');
const Registration=require('../models/Registration');
const {migrateParticipants}=require('../lib/migrateParticipants');
test('participant migration retains legacy data and distinguishes unknown ages from newborns',async t=>{
  const events=[{_id:'family',hasChildren:true},{_id:'group',hasChildren:false}];
  t.mock.method(Event,'find',()=>({select:()=>({lean:async()=>events})}));
  t.mock.method(FormConfig,'findOne',()=>({select:()=>({lean:async()=>({fields:[{type:'children',collectAge:true}]})})}));
  t.mock.method(Registration,'find',filter=>{assert.deepEqual(filter.participants,{$exists:false});return{select:()=>({lean:()=>({cursor:async function*(){yield{_id:filter.eventId,children:[{name:'Example',age:0}]};}})})};});
  const updates=[];t.mock.method(Registration,'bulkWrite',async(operations,options)=>{updates.push(...operations);assert.equal(options.timestamps,false);return{modifiedCount:operations.length};});
  const result=await migrateParticipants();assert.equal(result.modified,2);
  assert.deepEqual(updates[0].updateOne.update.$set.participants,[{name:'Example',age:0,category:'child'}]);
  assert.deepEqual(updates[1].updateOne.update.$set.participants,[{name:'Example',age:null,category:'general'}]);
  for(const item of updates){assert.deepEqual(item.updateOne.filter.participants,{$exists:false});assert.equal(item.updateOne.update.$unset,undefined);assert.deepEqual(Object.keys(item.updateOne.update.$set),['participants']);}
});
