const test = require('node:test');
const assert = require('node:assert/strict');
const Event = require('../models/Event');
const Registration = require('../models/Registration');
const FormConfig = require('../models/FormConfig');
const Account = require('../models/Account');
const MessageCampaign = require('../models/MessageCampaign');
const router = require('../routes/admin');
const publicRouter = require('../routes/public');
const mongoose = require('mongoose');
const { defaultFields } = require('../lib/formFields');
const eventId = '111111111111111111111111';
const registrationId = '222222222222222222222222';
function handler(path,method='post',source=router) { return source.stack.find(layer=>layer.route?.path===path&&layer.route.methods[method]).route.stack.at(-1).handle; }
function response(){return {code:200,status(code){this.code=code;return this;},render(view,data){this.view=view;this.data=data;return this;},send(value){this.value=value;return this;},redirect(url){this.url=url;return this;},setHeader(){return this;}};}
function request(body={},session={role:'superadmin',userId:'333333333333333333333333'}){return {body,session,params:{id:eventId,eventId,registrationId},query:{},protocol:'https',get:()=> 'example.test'};}
function eventDocument(extra={}){return {_id:eventId,accountId:'444444444444444444444444',name:'אירוע',description:'original',date:new Date('2035-11-07T09:00Z'),isActive:true,hasChildren:true,signupLimit:200,signupLimitCountMode:'participants',signupPhoneUnique:false,ticketsEnabled:false,save:async function(){return this;},toObject(){return {...this};},...extra};}

test('editing an event outside the active account is rejected before changing data',async t=>{
  const event=eventDocument();const save=t.mock.method(event,'save');t.mock.method(Event,'findById',async()=>event);
  const res=response();await handler('/events/:id/page')(request({name:'changed'},{role:'user',activeAccountId:'555555555555555555555555'}),res);
  assert.equal(res.code,404);assert.equal(save.mock.callCount(),0);
});
test('page editing preserves form fields, registration capacity and ticket settings',async t=>{
  const event=eventDocument({ticketsEnabled:true});t.mock.method(Event,'findById',async()=>event);t.mock.method(Event,'findOne',async()=>null);
  const fields=defaultFields();const config={fields,customFields:[],logoUrl:'uploads/old.webp',save:async()=>{}};t.mock.method(FormConfig,'findOne',async()=>config);
  const res=response();await handler('/events/:id/page')(request({name:'שם חדש',description:'<p>תוכן חדש</p>',date:'2035-11-07T11:00',isActive:'on',slug:'new-event',logoMaxHeight:'190'}),res);
  assert.equal(res.code,200);assert.match(res.url,/tab=page&saved=1/);assert.equal(event.signupLimit,200);assert.equal(event.ticketsEnabled,true);assert.equal(config.fields,fields);assert.equal(config.logoUrl,'uploads/old.webp');
});
test('malformed form configuration cannot reset existing registration fields',async t=>{
  const event=eventDocument();t.mock.method(Event,'findById',async()=>event);const save=t.mock.method(event,'save');const res=response();
  await handler('/events/:id/registration-settings')(request({fieldsJson:'not json'}),res);assert.equal(res.code,400);assert.equal(save.mock.callCount(),0);
});
test('quick creation of a group event adds participants before the two default checkboxes',async t=>{
  const event=eventDocument({hasChildren:false,isActive:false});t.mock.method(Event,'findOne',async()=>null);t.mock.method(Event,'create',async()=>event);
  t.mock.method(Event,'findById',()=>({select:()=>({lean:async()=>({accountId:event.accountId})})}));t.mock.method(Account,'findById',()=>({lean:async()=>({brandColor:'#126c59',logoUrl:'uploads/brand.webp'})}));
  t.mock.method(FormConfig,'findOne',async()=>null);let config;t.mock.method(FormConfig,'create',async value=>(config={...value,save:async()=>{}}));
  const res=response();await handler('/events/create')(request({name:'Group',registrationType:'group',accountId:event.accountId,hasChildrenPresent:'1'}),res);
  assert.match(res.url,/\/edit/);const peopleIndex=config.fields.findIndex(f=>f.type==='children');const checkIndex=config.fields.findIndex(f=>f.type==='checkbox');assert.ok(peopleIndex>=0&&peopleIndex<checkIndex);assert.equal(config.fields[peopleIndex].collectAge,false);assert.equal(config.fields.filter(f=>f.type==='checkbox').length,2);assert.equal(config.organizerLogoUrl,'uploads/brand.webp');
});
test('CSV export skips cancelled registrations and supports Hebrew event slugs',async t=>{
  const event=eventDocument({slug:'אירוע'});t.mock.method(Event,'findById',async()=>event);let queried;t.mock.method(Registration,'find',filter=>{queried=filter;return{sort:()=>({lean:async()=>[{parentFirstName:'A',participants:[{name:'B',category:'general',age:null}],customFields:{}}]})};});t.mock.method(FormConfig,'findOne',()=>({lean:async()=>({fields:defaultFields()})}));
  const res=response();const headers={};res.setHeader=(key,value)=>{headers[key]=value;};await handler('/events/:id/registrations/export.csv','get')(request(),res);
  assert.deepEqual(queried.status,{$ne:'cancelled'});assert.match(res.value,/מספר משתתפים/);assert.match(headers['Content-Disposition'],/filename\*=UTF-8''/);assert.doesNotMatch(headers['Content-Disposition'],/[\u0590-\u05ff]/);
});
test('archive preserves registrations and pauses future campaigns',async t=>{
  const event=eventDocument();t.mock.method(Event,'findById',async()=>event);const deleteRegs=t.mock.method(Registration,'deleteMany',async()=>{throw Error('must not delete');});const update=t.mock.method(MessageCampaign,'updateMany',async()=>({modifiedCount:1}));const res=response();
  await handler('/events/:id/archive')(request(),res);assert.ok(event.archivedAt instanceof Date);assert.equal(deleteRegs.mock.callCount(),0);assert.equal(update.mock.calls[0].arguments[1].$set.status,'cancelled');
});
test('cancelling a registration preserves its ticket and check-in history',async t=>{
  const event=eventDocument();t.mock.method(Event,'findById',async()=>event);const record={ticketToken:'existing',ticketCheckedInAt:new Date(),save:async()=>{}};t.mock.method(Registration,'findOne',async()=>record);const res=response();
  await handler('/events/:eventId/registrations/:registrationId/delete')(request(),res);assert.equal(record.status,'cancelled');assert.equal(record.ticketToken,'existing');assert.ok(record.ticketCheckedInAt);assert.equal(record.updatedBy,'333333333333333333333333');
});
test('required agreement is validated server-side without creating a registration',async t=>{
  const event=eventDocument({signupLimit:null});t.mock.method(Event,'findById',()=>({lean:async()=>event}));t.mock.method(FormConfig,'findOne',()=>({lean:async()=>({fields:defaultFields(),colors:{}})}));const create=t.mock.method(Registration,'create',async()=>{throw Error('must not create');});const req=request({parentFirstName:'A',parentLastName:'B',phone:'0501234567',children:[{name:'C',age:'8'}]});req.params={eventId};const res=response();
  await handler('/register/:eventId','post',publicRouter)(req,res);assert.equal(res.code,400);assert.equal(res.view,'form');assert.ok(res.data.formErrors.some(e=>e.includes('אין להשאיר ילדים')));assert.equal(create.mock.callCount(),0);
});

test('a valid group is committed with canonical participants inside a capacity transaction',async t=>{
  const event=eventDocument({signupLimit:3});t.mock.method(Event,'findById',()=>({lean:async()=>event}));t.mock.method(Event,'findOneAndUpdate',()=>({lean:async()=>event}));t.mock.method(FormConfig,'findOne',()=>({lean:async()=>({fields:defaultFields(),colors:{}})}));
  const session={test:true};const transaction=t.mock.method(mongoose.connection,'transaction',async callback=>callback(session));
  t.mock.method(Registration,'find',()=>({select:()=>({session(){return this;},lean:async()=>[{participants:[]}]})}));
  t.mock.method(Registration,'countDocuments',()=>Object.assign(Promise.resolve(1),{session:async()=>1}));
  const create=t.mock.method(Registration,'create',async()=>[{_id:registrationId}]);const req=request({parentFirstName:'A',parentLastName:'B',phone:'0501234567',children:[{name:'C',age:'8'}],custom_f_wevh93oni4lpb2mk2ygah:'true'});req.params={eventId};const res=response();
  await handler('/register/:eventId','post',publicRouter)(req,res);assert.match(res.url,/^\/success/);assert.equal(transaction.mock.callCount(),1);
  assert.deepEqual(create.mock.calls[0].arguments[0][0].participants,[{name:'C',age:8,category:'child'}]);assert.equal(create.mock.calls[0].arguments[1].session,session);
});

test('a group larger than the remaining seats is rejected with a visible explanation',async t=>{
  const event=eventDocument({signupLimit:3});t.mock.method(Event,'findById',()=>({lean:async()=>event}));t.mock.method(FormConfig,'findOne',()=>({lean:async()=>({fields:defaultFields(),colors:{}})}));
  t.mock.method(Registration,'find',()=>({select:()=>({lean:async()=>[{participants:[{name:'already',category:'child'}]}]})}));
  const create=t.mock.method(Registration,'create',async()=>{throw Error('must not create');});const req=request({parentFirstName:'A',parentLastName:'B',phone:'0501234567',children:[{name:'C',age:'8'}],custom_f_wevh93oni4lpb2mk2ygah:'true'});req.params={eventId};const res=response();
  await handler('/register/:eventId','post',publicRouter)(req,res);assert.equal(res.code,403);assert.match(res.data.formErrors.join(' '),/נותרו 1/);assert.equal(create.mock.callCount(),0);
});
