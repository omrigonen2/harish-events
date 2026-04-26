const express = require('express');
const Event = require('../models/Event');
const Registration = require('../models/Registration');
const {
  buildTicketQrPngBuffer,
  buildTicketUrl,
  redeemTicket,
} = require('../lib/tickets');

const router = express.Router();

router.get('/ticket/:ticketToken', async (req, res) => {
  try {
    const registration = await Registration.findOne({ ticketToken: req.params.ticketToken }).lean();
    if (!registration) {
      return res.status(404).render('error', { title: 'לא נמצא', message: 'הכרטיס לא נמצא' });
    }

    const event = await Event.findById(registration.eventId).lean();
    if (!event) {
      return res.status(404).render('error', { title: 'לא נמצא', message: 'האירוע לא נמצא' });
    }

    return res.render('ticket', {
      title: `כרטיס — ${event.name}`,
      event,
      registration,
      ticketUrl: buildTicketUrl(req, registration.ticketToken),
      qrUrl: `/ticket/${encodeURIComponent(registration.ticketToken)}/qr.png`,
    });
  } catch (err) {
    console.error('ticket page error', err);
    return res.status(500).render('error', { title: 'שגיאה', message: 'שגיאת שרת' });
  }
});

router.get('/ticket/:ticketToken/qr.png', async (req, res) => {
  try {
    const registration = await Registration.findOne({ ticketToken: req.params.ticketToken }).select('_id ticketToken').lean();
    if (!registration) return res.status(404).send('Not found');

    const ticketUrl = buildTicketUrl(req, registration.ticketToken);
    const png = await buildTicketQrPngBuffer(ticketUrl);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.send(png);
  } catch (err) {
    console.error('ticket qr error', err);
    return res.status(500).send('Error');
  }
});

router.get('/gate/:checkInToken', async (req, res) => {
  try {
    const event = await Event.findOne({ checkInToken: req.params.checkInToken, ticketsEnabled: true }).lean();
    if (!event) {
      return res.status(404).render('error', { title: 'לא נמצא', message: 'קישור הסריקה אינו תקין או שהכרטיסים כבויים.' });
    }

    return res.render('gate', {
      title: `סריקת כרטיסים — ${event.name}`,
      event,
      checkInToken: req.params.checkInToken,
    });
  } catch (err) {
    console.error('gate page error', err);
    return res.status(500).render('error', { title: 'שגיאה', message: 'שגיאת שרת' });
  }
});

router.post('/gate/:checkInToken/redeem', async (req, res) => {
  try {
    const scanned = req.body.ticketToken || req.body.value || req.body.scanned || '';
    const result = await redeemTicket(req.params.checkInToken, scanned);
    return res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    console.error('ticket redeem error', err);
    return res.status(500).json({ ok: false, status: 'error', message: 'שגיאת שרת' });
  }
});

module.exports = router;
