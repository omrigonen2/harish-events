const test = require('node:test');
const assert = require('node:assert/strict');
const Event = require('../models/Event');
const Registration = require('../models/Registration');
const WasenderSettings = require('../models/WasenderSettings');
const { previewTicket, redeemTicket } = require('../lib/tickets');
const { sendTestMessage } = require('../lib/messageQueue');
const event={_id:'111111111111111111111111',hasChildren:false,ticketsEnabled:true,ticketsGateAllowCountEdit:false};

test('cancelled tickets cannot be previewed or redeemed',async t=>{
  t.mock.method(Event,'findOne',()=>({lean:async()=>event}));const registration={status:'cancelled'};t.mock.method(Registration,'findOne',()=>Object.assign(Promise.resolve(registration),{lean:async()=>registration}));
  assert.equal((await previewTicket('gate','token')).status,'cancelled');assert.equal((await redeemTicket('gate','token')).ok,false);
});
test('check-in is claimed once atomically and counts adult group members correctly',async t=>{
  t.mock.method(Event,'findOne',()=>({lean:async()=>event}));const registration={_id:'222222222222222222222222',participants:[{name:'A',category:'general',age:null},{name:'B',category:'adult',age:20}],save:()=>{throw Error('must use atomic update');}};t.mock.method(Registration,'findOne',async()=>registration);
  const update=t.mock.method(Registration,'findOneAndUpdate',async(filter,change)=>({...registration,...change.$set}));
  const result=await redeemTicket('gate','token');assert.equal(result.status,'checked_in');assert.deepEqual(result.counts,{adults:3,children:0});
  const [filter,change]=update.mock.calls[0].arguments;assert.equal(filter.ticketCheckedInAt,null);assert.deepEqual(filter.status,{$ne:'cancelled'});assert.equal(change.$push.checkInHistory.adults,3);
});
test('a repeated concurrent scan returns the original successful check-in',async t=>{
  t.mock.method(Event,'findOne',()=>({lean:async()=>event}));const registration={_id:'222222222222222222222222',participants:[]};t.mock.method(Registration,'findOne',async()=>registration);t.mock.method(Registration,'findOneAndUpdate',async()=>null);const at=new Date();t.mock.method(Registration,'findById',()=>({lean:async()=>({...registration,ticketCheckedInAt:at,ticketCheckInAdults:1,ticketCheckInChildren:0})}));
  const result=await redeemTicket('gate','token');assert.equal(result.status,'already_checked_in');assert.equal(result.checkedInAt,at);
});
test('test messages and test ticket attachments go only to the test phone',async t=>{
  const oldKey=process.env.WASENDER_API_KEY;process.env.WASENDER_API_KEY='test-key';t.after(()=>{if(oldKey===undefined)delete process.env.WASENDER_API_KEY;else process.env.WASENDER_API_KEY=oldKey;});
  t.mock.method(WasenderSettings,'findOne',async()=>({apiKeyEncrypted:'',baseUrl:'https://example.test'}));
  const registration={phone:'0509999999',parentFirstName:'Example',ticketToken:'test-token',toObject(){return {...this};}};t.mock.method(Registration,'findOne',async()=>registration);
  const requests=[];t.mock.method(global,'fetch',async(url,options)=>{requests.push(JSON.parse(options.body));return{ok:true,json:async()=>({success:true})};});
  await sendTestMessage({event,registrationId:'example',to:'0501234567',messageText:'Example',publicBaseUrl:'https://example.test',attachTicket:true});
  assert.equal(requests.length,2);assert.deepEqual(requests.map(r=>r.to),['+972501234567','+972501234567']);assert.equal(registration.phone,'0509999999');
});
test('test ticket validation fails before sending any message without a selected registration',async t=>{
  const fetch=t.mock.method(global,'fetch',async()=>{throw Error('must not send');});
  await assert.rejects(()=>sendTestMessage({event,to:'0501234567',messageText:'Example',attachTicket:true}),/נרשם/);assert.equal(fetch.mock.callCount(),0);
});
