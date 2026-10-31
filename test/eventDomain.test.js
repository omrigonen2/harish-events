const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultFields, getFieldsForRender, normalizeStoredFields } = require('../lib/formFields');
const { eventState, registrationState } = require('../lib/eventStatus');
const { additionalParticipants, participantCounts, totalsForRegistrations, deliveryState } = require('../lib/participants');

test('new forms have the two original checkbox settings without injecting them into existing configured forms',()=>{
  for(const hasChildren of [true,false]) {
    const fields=defaultFields({hasChildren});const checkboxes=fields.filter(f=>f.type==='checkbox');assert.equal(checkboxes.length,2);
    assert.deepEqual(checkboxes.map(f=>[f.required,f.checkedByDefault]),[[false,false],[true,false]]);
    assert.equal(new Set(fields.map(f=>f.id)).size,fields.length);
  }
  const old=defaultFields().filter(f=>f.type!=='checkbox');assert.equal(getFieldsForRender({fields:old}).filter(f=>f.type==='checkbox').length,0);
  const custom={id:'legacy',type:'checkbox',label:'אישור קיים',required:true};
  assert.equal(normalizeStoredFields({customFields:[custom]}).filter(f=>f.type==='checkbox').length,1);
});
test('publication, event date and registration availability have separate states',()=>{
  const now=new Date('2026-10-31T08:00:00Z');const event={isActive:true,date:new Date('2026-11-07T09:00:00Z')};
  assert.equal(eventState(event,now).key,'upcoming');assert.equal(registrationState(event,now).key,'open');
  assert.equal(eventState({...event,signupPaused:true},now).key,'upcoming');assert.equal(registrationState({...event,signupPaused:true},now).key,'paused');
  assert.equal(registrationState({...event,signupOpenAt:new Date('2026-11-01')},now).key,'scheduled');
  assert.equal(registrationState({...event,date:new Date('2026-10-30')},now).key,'ended');
  assert.equal(eventState({...event,isActive:false},now).key,'draft');assert.equal(registrationState({...event,archivedAt:now},now).open,false);
});
test('canonical participant counts include the contact and distinguish adults from children',()=>{
  const registration={participants:[{name:'A',category:'adult',age:40},{name:'B',category:'child',age:8},{name:'C',category:'general',age:null}],children:[{name:'stale legacy',age:0}]};
  assert.deepEqual(participantCounts(registration),{adults:3,children:1,total:4,additional:3});
  assert.equal(participantCounts({children:[{name:'guest',age:0}]},{hasChildren:false}).adults,2);
  assert.equal(additionalParticipants({children:[{name:'guest',age:0}]},{hasChildren:false})[0].age,null);
  assert.equal(participantCounts({participants:[],children:[{name:'legacy'}]}).total,1);
});
test('cancelled registrations release capacity but retain historical data',()=>{
  const rows=[{participants:[{category:'child'}],ticketCheckedInAt:new Date(),ticketCheckInAdults:1,ticketCheckInChildren:1},{status:'cancelled',participants:[{category:'child'}],ticketCheckedInAt:new Date()}];
  const stats=totalsForRegistrations(rows);assert.equal(stats.registrations,1);assert.equal(stats.participants,2);assert.equal(stats.cancelled,1);assert.equal(stats.checkedInPeople,2);
});
test('creating a ticket is never mistaken for successful WhatsApp delivery',()=>{
  assert.equal(deliveryState({ticketToken:'token'}).key,'pending');
  assert.equal(deliveryState({ticketToken:'token',ticketWhatsAppError:'failed'}).key,'failed');
  assert.equal(deliveryState({ticketWhatsAppSentAt:new Date()}).key,'sent');
});
