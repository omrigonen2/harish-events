# Event Signup

מערכת הרשמה לאירועי ילדים — Node.js, Express, EJS, MongoDB.

## הגדרה

1. התקנת MongoDB מקומית או URI לענן.
2. העתקה: `.env.example` → `.env` ועריכת ערכים (במיוחד `MONGODB_URI`, `SESSION_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`).
3. `npm install`
4. `npm start`
5. אתר: `http://localhost:3000/events` · מנהלים: `/admin/login`

## מבנה

- טופס ציבורי: שם הורה, טלפון, ילדים דינמיים, שדות נוספים לפי הגדרה.
- מנהל: אירועים, עיצוב טופס (צבעים, תמונות, שדות נוספים), צפייה בנרשמים וייצוא CSV.
