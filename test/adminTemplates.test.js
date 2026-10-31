const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { defaultFields } = require('../lib/formFields');
const { eventState, registrationState, limitLabel } = require('../lib/eventStatus');
const { additionalParticipants, participantCounts, totalsForRegistrations, deliveryState } = require('../lib/participants');
const { formatDateTimeIsrael } = require('../lib/datetimeLocal');

const event = { _id: '111111111111111111111111', name: 'אירוע לדוגמה', description: '<p>תיאור</p>', slug: 'example', date: new Date('2035-11-07T09:00:00Z'), isActive: true, hasChildren: true, ticketsEnabled: true, signupLimit: 200, signupLimitCountMode: 'participants' };
const registration = { _id: '222222222222222222222222', parentFirstName: 'משתתף', parentLastName: 'לדוגמה', phone: '0501234567', participants: [{ name: 'ילד לדוגמה', age: 8, category: 'child' }], customFields: {}, createdAt: new Date(), ticketToken: 'example' };
const config = { fields: defaultFields(), colors: { primary: '#126c59', background: '#f8f9fa', text: '#182b3e', button: '#126c59' }, logoUrl: '', organizerLogoUrl: '', backgroundImage: '', logoMaxHeight: 190 };
function data(extra = {}) {
  return { title: 'ניהול אירועים', currentPath: '/admin/events', sessionUser: { role: 'superadmin', displayName: 'מנהל לדוגמה' }, memberships: [], navAccounts: [], event, editEvent: event,
    registration, registrations: [registration], events: [event], allAccounts: [], fields: config.fields,
    stats: totalsForRegistrations([registration], event), builderConfig: config, builderConfigRaw: config, customFieldDefs: config.fields.filter(f=>f.type==='checkbox'),
    saved: false, ticketSent: false, formError: null, formBuilderError: null, formMessage: null, testError: null, testMessage: null, campaigns: [],
    eventDateInput: '2035-11-07T11:00', signupCloseAtInput: '', signupOpenAtInput: '', gateUrl: '/gate/example', baseUrl: 'https://example.test',
    eventState, registrationState, limitLabel, additionalParticipants, participantCounts, deliveryState, formatDateTimeIsrael,
    ...extra };
}
async function render(view, extra) { return ejs.renderFile(path.join(__dirname,'../views',view+'.ejs'), data(extra)); }
function assertNoNestedForms(html) {
  let depth=0;
  for(const match of html.matchAll(/<\/?form\b[^>]*>/g)) { depth += match[0].startsWith('</') ? -1 : 1; assert.ok(depth>=0&&depth<=1,'forms must not be nested'); }
  assert.equal(depth,0);
}
for(const tab of ['overview','page','registration','tickets']) test(`event workspace renders the ${tab} tab with valid forms`, async()=>{
  const html=await render('admin/event-edit',{activeTab:tab});
  assert.match(html,/אירוע לדוגמה/); assert.match(html,/aria-current="page"/); assertNoNestedForms(html);
  if(tab==='registration') { assert.match(html,/קבלת|לקבל עדכונים/); assert.match(html,/registration-settings/); }
  if(tab==='page') assert.match(html,/name="organizerLogoKey"/);
});
test('list, dashboard, messaging, settings and registration screens render',async()=>{
  for(const view of ['events','dashboard','messaging','settings','registrations','registration-detail']) {
    const html=await render('admin/'+view,view==='events'||view==='dashboard'?{stats:{[event._id]:totalsForRegistrations([registration],event)}}:{});
    assert.match(html,/admin-sidebar/);assertNoNestedForms(html);
  }
});
test('field editor JSON preserves labels without allowing HTML to close its data script',async()=>{
  const fields=[...config.fields,{id:'special',type:'text',label:'<b>literal label</b></script>',required:false}];
  const html=await render('admin/partials/fields-editor',{fields});
  const json=html.match(/<script type="application\/json" id="fields-config">([\s\S]*?)<\/script>/)[1];
  assert.equal(JSON.parse(json).at(-1).label,fields.at(-1).label);assert.ok(!json.includes('</script>'));
});
test('campaign history and organization branding screens render',async()=>{
  const html=await render('admin/messaging-campaign',{status:{campaign:{_id:'campaign',status:'completed'},counts:{},recipients:[]}});assertNoNestedForms(html);assert.match(html,/הסתיימה/);
  const branding=await render('admin/account-edit',{account:{_id:'account',name:'אומני חריש',slug:'default'},formError:null});assert.match(branding,/name="brandColor"/);assertNoNestedForms(branding);
});
test('public registration form retains required and optional unchecked defaults',async()=>{
  const html=await render('form',{config,descriptionHtml:'<p>תיאור</p>',fields:config.fields,formErrors:[],oldBody:{},childRows:[{name:'',age:''}],signupAvailability:{open:true},preview:false});
  for(const field of config.fields.filter(f=>f.type==='checkbox')) {
    const input=html.match(new RegExp('<input[^>]*id="custom_'+field.id+'"[^>]*>'))?.[0];
    assert.ok(input);assert.equal(/\schecked(?:\s|>|=)/.test(input),false);assert.equal(/\srequired(?:\s|>|=)/.test(input),field.required);
  }
});
