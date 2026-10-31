require('dotenv').config();
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const multer = require('multer');

const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const adminAccountRoutes = require('./routes/admin-accounts');
const adminMessagingRoutes = require('./routes/admin-messaging');
const ticketRoutes = require('./routes/tickets');
const { formatDateTimeIsrael } = require('./lib/datetimeLocal');
const messageQueue = require('./lib/messageQueue');
const { eventState, registrationState, limitLabel } = require('./lib/eventStatus');
const { additionalParticipants, participantCounts, deliveryState } = require('./lib/participants');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.locals.formatDateTimeIsrael = formatDateTimeIsrael;
Object.assign(app.locals, { eventState, registrationState, limitLabel, additionalParticipants, participantCounts, deliveryState });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

const mongoUrl = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/event_signup';

app.use(
  session({
    name: 'event_signup_sid',
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl,
      ttl: 60 * 60 * 24 * 7,
    }),
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
    },
  })
);

app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  next();
});
app.use('/', publicRoutes);
app.use('/', ticketRoutes);
app.use('/admin', adminRoutes);
app.use('/admin', adminAccountRoutes);
app.use('/', adminMessagingRoutes);

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).render('error', { title: 'שגיאה', message: 'קובץ גדול מדי או לא תקין' });
  }
  console.error(err);
  res.status(500).render('error', { title: 'שגיאה', message: err.message || 'שגיאת שרת' });
});

mongoose
  .connect(mongoUrl)
  .then(() => {
    messageQueue.start().catch((err) => {
      console.error('Message queue failed to start:', err);
    });
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server listening on port ${PORT}`);
      require('./lib/migrateParticipants').migrateParticipants()
        .then(result => console.log('Participant migration:', JSON.stringify(result)))
        .catch(err => console.error('Participant migration failed:', err.message));
      // Optional one-time maintenance runs after listening and never blocks startup.
      // Matching the original key makes restarts safe after a successful update.
      if (process.env.EVENT_LOGO_OPTIMIZATION) {
        Promise.resolve().then(() => {
          const { optimizeEventLogo } = require('./lib/optimizeEventLogo');
          return optimizeEventLogo(JSON.parse(process.env.EVENT_LOGO_OPTIMIZATION));
        }).then((result) => {
          console.log('Event logo optimization:', JSON.stringify(result));
        }).catch((err) => {
          console.error('Event logo optimization failed:', err.message);
        });
      }
    });
  })
  .catch((e) => {
    console.error('MongoDB connection failed:', e);
    process.exit(1);
  });
