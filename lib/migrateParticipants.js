const Event = require('../models/Event');
const FormConfig = require('../models/FormConfig');
const Registration = require('../models/Registration');

/** Backfill the canonical participant list in small batches, retaining legacy fields. */
async function migrateParticipants() {
  const events = await Event.find().select('_id hasChildren').lean();
  let modified = 0;
  for (const event of events) {
    const config = await FormConfig.findOne({ eventId: event._id }).select('fields').lean();
    const peopleField = config?.fields?.find(field => field.type === 'children');
    const collectAge = event.hasChildren !== false && peopleField?.collectAge !== false;
    let operations = [];
    const flush = async () => { if (!operations.length) return; const result = await Registration.bulkWrite(operations, { ordered: false, timestamps: false }); modified += result.modifiedCount; operations = []; };
    for await (const registration of Registration.find({ eventId: event._id, participants: { $exists: false } }).select('children').lean().cursor({ batchSize: 100 })) {
      operations.push({ updateOne: { filter: { _id: registration._id, participants: { $exists: false } }, update: { $set: { participants: (registration.children || []).map(person => ({ name: person.name, age: collectAge ? person.age : null, category: event.hasChildren === false ? 'general' : 'child' })) } } } });
      if (operations.length >= 100) await flush();
    }
    await flush();
  }
  return { modified };
}

module.exports = { migrateParticipants };
