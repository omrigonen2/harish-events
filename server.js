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
const { formatDateTimeIsrael } = require('./lib/datetimeLocal');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.locals.formatDateTimeIsrael = formatDateTimeIsrael;

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
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

app.use('/', publicRoutes);
app.use('/admin', adminRoutes);
app.use('/admin', adminAccountRoutes);

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
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server listening on port ${PORT}`);
    });
  })
  .catch((e) => {
    console.error('MongoDB connection failed:', e);
    process.exit(1);
  });
