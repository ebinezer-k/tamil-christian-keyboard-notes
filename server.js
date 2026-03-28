/**
 * Tamil Christian Keyboard Notes — Admin Server
 * Run: node server.js  (or: npm run dev  for auto-reload)
 * Requires: .env file with ADMIN_PASSWORD, SESSION_SECRET, and DATABASE_URL
 *
 * DATABASE_URL = MongoDB connection string (e.g. from MongoDB Atlas)
 * All data (songs, users, messages, contributors) is persisted in MongoDB
 * so nothing is lost when the server restarts on Render's free tier.
 */

require('dotenv').config();
const express         = require('express');
const session         = require('express-session');
const multer          = require('multer');
const cors            = require('cors');
const path            = require('path');
const fs              = require('fs');
const crypto          = require('crypto');
const { MongoClient } = require('mongodb');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Paths ───────────────────────────────────────────────────────────────────
const DATA_FILE    = path.join(__dirname, 'songs-data.json');
const BACKUP_FILE  = path.join(__dirname, 'songs-data.backup.json');
const NOTES_DIR    = path.join(__dirname, 'Notes');
const ALL_SONGS    = path.join(NOTES_DIR, 'All Songs');
const USERS_FILE   = path.join(__dirname, 'users.json');
const CONTRIB_FILE = path.join(__dirname, 'contributors.json');
const MESSAGES_FILE = path.join(__dirname, 'messages.json');

if (!fs.existsSync(ALL_SONGS)) fs.mkdirSync(ALL_SONGS, { recursive: true });

// ── Null-byte safe file helpers (OneDrive pads files with nulls) ────────────
function readJsonSafe(filePath) {
  const buf = fs.readFileSync(filePath);
  let end = buf.length - 1;
  while (end >= 0 && buf[end] === 0) end--;
  return JSON.parse(buf.slice(0, end + 1).toString('utf8'));
}
function writeJsonSafe(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

// ── MongoDB ─────────────────────────────────────────────────────────────────
let db = null;

async function connectDB() {
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.warn('⚠️  DATABASE_URL not set — falling back to JSON files.');
    console.warn('    Data will NOT persist across Render restarts!');
    return;
  }
  try {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    db = client.db(); // database name comes from the URI
    console.log('✅ Connected to MongoDB');
  } catch (e) {
    console.error('❌ MongoDB connection failed:', e.message);
    console.warn('   Falling back to JSON files.');
  }
}

// ── In-memory song store ─────────────────────────────────────────────────────
let songsStore = [];

async function loadSongs() {
  // 1. Try MongoDB first
  if (db) {
    try {
      const songs = await db.collection('songs')
        .find({}, { projection: { _id: 0 } })
        .sort({ title: 1 })
        .toArray();
      if (songs.length > 0) {
        songsStore = songs;
        console.log(`✅ Loaded ${songsStore.length} songs from MongoDB`);
        return;
      }
    } catch (e) {
      console.warn('⚠️  MongoDB songs load failed, falling back to file:', e.message);
    }
  }

  // 2. Fall back to songs-data.json (from git repo)
  try {
    const data = readJsonSafe(DATA_FILE);
    songsStore = data.songs || [];
    if (songsStore.length === 0) throw new Error('songs array is empty');
    console.log(`✅ Loaded ${songsStore.length} songs from songs-data.json`);

    // Seed MongoDB so future restarts use the DB
    if (db && songsStore.length > 0) {
      try {
        const count = await db.collection('songs').countDocuments();
        if (count === 0) {
          await db.collection('songs').insertMany(
            songsStore.map(s => ({ _id: s.id, ...s }))
          );
          console.log(`✅ Seeded ${songsStore.length} songs into MongoDB`);
        }
      } catch (e) {
        console.warn('⚠️  MongoDB seed failed:', e.message);
      }
    }
  } catch (e) {
    console.error('❌ Could not load songs-data.json:', e.message);
    // Try backup
    if (fs.existsSync(BACKUP_FILE)) {
      try {
        songsStore = readJsonSafe(BACKUP_FILE).songs || [];
        console.warn(`⚠️  Loaded ${songsStore.length} songs from BACKUP file`);
      } catch (e2) {
        console.error('❌ Backup also failed:', e2.message);
        songsStore = [];
      }
    }
  }
}

// Persist a single song change to MongoDB
async function dbPersistSong(song) {
  if (!db) return;
  try {
    await db.collection('songs').replaceOne(
      { _id: song.id },
      { _id: song.id, ...song },
      { upsert: true }
    );
  } catch (e) {
    console.error('⚠️  Song persist failed:', e.message);
  }
}

async function dbDeleteSong(id) {
  if (!db) return;
  try {
    await db.collection('songs').deleteOne({ _id: id });
  } catch (e) {
    console.error('⚠️  Song delete failed:', e.message);
  }
}

// ── In-memory contributors store ─────────────────────────────────────────────
let contribStore = [];

async function loadContributors() {
  if (db) {
    try {
      const contribs = await db.collection('contributors')
        .find({}, { projection: { _id: 0 } })
        .toArray();
      if (contribs.length > 0) {
        contribStore = contribs;
        console.log(`✅ Loaded ${contribStore.length} contributors from MongoDB`);
        return;
      }
    } catch (e) {
      console.warn('⚠️  MongoDB contributors load failed, falling back:', e.message);
    }
  }
  // Fallback to file
  try {
    if (fs.existsSync(CONTRIB_FILE)) {
      contribStore = readJsonSafe(CONTRIB_FILE);
      console.log(`✅ Loaded ${contribStore.length} contributors from contributors.json`);
      // Seed MongoDB
      if (db && contribStore.length > 0) {
        try {
          const count = await db.collection('contributors').countDocuments();
          if (count === 0) {
            await db.collection('contributors').insertMany(
              contribStore.map((c, i) => ({ _id: i, ...c }))
            );
            console.log(`✅ Seeded ${contribStore.length} contributors into MongoDB`);
          }
        } catch (e) {
          console.warn('⚠️  Contributors seed failed:', e.message);
        }
      }
    }
  } catch (e) {
    console.error('❌ Could not load contributors:', e.message);
    contribStore = [];
  }
}

async function dbSaveContributors(contribs) {
  contribStore = contribs;
  if (db) {
    try {
      await db.collection('contributors').deleteMany({});
      if (contribs.length > 0) {
        await db.collection('contributors').insertMany(
          contribs.map((c, i) => ({ _id: i, ...c }))
        );
      }
      return;
    } catch (e) {
      console.error('⚠️  Contributors save to MongoDB failed:', e.message);
    }
  }
  // Fallback to file
  writeJsonSafe(CONTRIB_FILE, contribs);
}

// ── User DB helpers ──────────────────────────────────────────────────────────

// File-based fallbacks for local dev
function _fileLoadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8').replace(/\0/g, '')).users || [];
  } catch (e) { return []; }
}
function _fileSaveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2), 'utf8');
}

async function dbFindUser(filter) {
  if (db) return db.collection('users').findOne(filter, { projection: { _id: 0 } });
  const users = _fileLoadUsers();
  return users.find(u => Object.entries(filter).every(([k, v]) => u[k] === v)) || null;
}

async function dbGetAllUsers() {
  if (db) return db.collection('users').find({}, { projection: { _id: 0 } }).toArray();
  return _fileLoadUsers();
}

async function dbInsertUser(user) {
  if (db) {
    await db.collection('users').insertOne({ _id: user.id, ...user });
    return;
  }
  const users = _fileLoadUsers();
  users.push(user);
  _fileSaveUsers(users);
}

async function dbUpdateUser(id, updates) {
  if (db) {
    await db.collection('users').updateOne({ _id: id }, { $set: updates });
    return;
  }
  const users = _fileLoadUsers();
  const idx = users.findIndex(u => u.id === id);
  if (idx !== -1) { Object.assign(users[idx], updates); _fileSaveUsers(users); }
}

async function dbDeleteUser(id) {
  if (db) {
    await db.collection('users').deleteOne({ _id: id });
    return;
  }
  const users = _fileLoadUsers();
  const filtered = users.filter(u => u.id !== id);
  _fileSaveUsers(filtered);
}

// ── Message DB helpers ───────────────────────────────────────────────────────

function _fileLoadMessages() {
  try {
    if (!fs.existsSync(MESSAGES_FILE)) return [];
    return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8').replace(/\0/g, '')).messages || [];
  } catch (e) { return []; }
}
function _fileSaveMessages(msgs) {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify({ messages: msgs }, null, 2), 'utf8');
}

async function dbGetAllMessages() {
  if (db) {
    return db.collection('messages')
      .find({}, { projection: { _id: 0 } })
      .sort({ receivedAt: -1 })
      .toArray();
  }
  return _fileLoadMessages();
}

async function dbInsertMessage(msg) {
  if (db) {
    await db.collection('messages').insertOne({ _id: msg.id, ...msg });
    return;
  }
  const msgs = _fileLoadMessages();
  msgs.push(msg);
  _fileSaveMessages(msgs);
}

async function dbUpdateMessage(id, updates) {
  if (db) {
    await db.collection('messages').updateOne({ _id: id }, { $set: updates });
    return;
  }
  const msgs = _fileLoadMessages();
  const m = msgs.find(m => m.id === id);
  if (m) { Object.assign(m, updates); _fileSaveMessages(msgs); }
}

async function dbDeleteMessage(id) {
  if (db) {
    await db.collection('messages').deleteOne({ _id: id });
    return;
  }
  const msgs = _fileLoadMessages();
  _fileSaveMessages(msgs.filter(m => m.id !== id));
}

// ── Multer file upload config ────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ALL_SONGS),
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[/\\?%*:|"<>]/g, '-');
    const dest = path.join(ALL_SONGS, file.originalname);
    cb(null, fs.existsSync(dest) ? `${base}_${Date.now()}}${ext}` : file.originalname);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Only PDF, JPG, and PNG files are allowed'));
  }
});

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'keyboard-notes-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 hours
}));

// Serve static files (index.html, notes images, etc.)
app.use(express.static(__dirname));

// ── Password helpers ─────────────────────────────────────────────────────────
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.createHmac('sha256', s).update(password).digest('hex');
  return { hash: h, salt: s };
}
function verifyPassword(password, hash, salt) {
  return crypto.createHmac('sha256', salt).update(password).digest('hex') === hash;
}

// ── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && (req.session.authenticated || req.session.userId)) return next();
  res.status(401).json({ error: 'Unauthorized. Please log in.' });
}

// ── Helper: generate next song ID ────────────────────────────────────────────
function nextId() {
  const nums = songsStore
    .map(s => parseInt((s.id || '').replace('S', ''), 10))
    .filter(n => !isNaN(n));
  const max = nums.length > 0 ? Math.max(...nums) : 0;
  return `S${String(max + 1).padStart(4, '0')}`;
}

// ── Helper: sanitize a song object ───────────────────────────────────────────
function sanitizeSong(body) {
  return {
    title:       (body.title       || '').trim(),
    category:    (body.category    || '').trim(),
    fileType:    (body.fileType    || 'pdf').trim(),
    pages:       parseInt(body.pages, 10) || 1,
    difficulty:  (body.difficulty  || '').trim(),
    primaryFile: (body.primaryFile || '').trim(),
    allFiles:    Array.isArray(body.allFiles)
                   ? body.allFiles.map(f => f.trim()).filter(Boolean)
                   : [(body.primaryFile || '').trim()].filter(Boolean),
    style:       (body.style       || '').trim(),
    scale:       (body.scale       || '').trim(),
    tempo:       (body.tempo       || '').trim(),
    lyricsUrl:   (body.lyricsUrl   || '').trim(),
  };
}

// ══════════════════════════════════════════════════════════════════════════
//  API ROUTES
// ══════════════════════════════════════════════════════════════════════════

// ── POST /api/login ──────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  const adminPw = process.env.ADMIN_PASSWORD || 'admin123';
  if (password === adminPw) {
    req.session.authenticated = true;
    res.json({ success: true, message: 'Logged in successfully' });
  } else {
    res.status(401).json({ error: 'Incorrect password' });
  }
});

// ── POST /api/logout ─────────────────────────────────────────────────────────
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ── GET /api/auth/status ─────────────────────────────────────────────────────
app.get('/api/auth/status', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// ══════════════════════════════════════════════════════════════════════════
//  USER AUTH ROUTES
// ══════════════════════════════════════════════════════════════════════════

// ── GET /api/user/check ──────────────────────────────────────────────────────
app.get('/api/user/check', (req, res) => {
  if (req.session && (req.session.userId || req.session.authenticated)) {
    return res.json({
      loggedIn: true,
      name:  req.session.userName  || 'Admin',
      email: req.session.userEmail || ''
    });
  }
  res.json({ loggedIn: false });
});

// ── POST /api/user/signup ────────────────────────────────────────────────────
app.post('/api/user/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Name, email and password are required.' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    const existing = await dbFindUser({ email: email.toLowerCase().trim() });
    if (existing)
      return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });

    const { hash, salt } = hashPassword(password);
    const newUser = {
      id:        crypto.randomUUID(),
      name:      name.trim(),
      email:     email.toLowerCase().trim(),
      hash, salt,
      createdAt: new Date().toISOString()
    };
    await dbInsertUser(newUser);

    req.session.userId    = newUser.id;
    req.session.userName  = newUser.name;
    req.session.userEmail = newUser.email;

    console.log(`✅ New user registered: ${newUser.email}`);
    res.status(201).json({ success: true, name: newUser.name, email: newUser.email });
  } catch (e) {
    console.error('Signup error:', e);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

// ── POST /api/user/login ─────────────────────────────────────────────────────
app.post('/api/user/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required.' });

    const user = await dbFindUser({ email: email.toLowerCase().trim() });
    if (!user || !verifyPassword(password, user.hash, user.salt))
      return res.status(401).json({ error: 'Incorrect email or password.' });

    if (user.active === false)
      return res.status(403).json({ error: 'Your account has been suspended. Please contact the administrator.' });

    // Record last login time
    await dbUpdateUser(user.id, { lastLogin: new Date().toISOString() });

    req.session.userId    = user.id;
    req.session.userName  = user.name;
    req.session.userEmail = user.email;

    console.log(`✅ User logged in: ${user.email}`);
    res.json({ success: true, name: user.name, email: user.email });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ── POST /api/user/logout ────────────────────────────────────────────────────
app.post('/api/user/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ══════════════════════════════════════════════════════════════════════════
//  CONTACT FORM
// ══════════════════════════════════════════════════════════════════════════
const CONTACT_UPLOADS = path.join(__dirname, 'Notes', 'ContactUploads');
if (!fs.existsSync(CONTACT_UPLOADS)) fs.mkdirSync(CONTACT_UPLOADS, { recursive: true });

const contactStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, CONTACT_UPLOADS),
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[/\\?%*:|"<>]/g, '-');
    cb(null, `${base}_${Date.now()}${ext}`);
  }
});
const contactUpload = multer({
  storage: contactStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Only PDF, JPG, and PNG files are allowed'));
  }
});

// ── POST /api/contact ────────────────────────────────────────────────────────
app.post('/api/contact', contactUpload.single('attachment'), async (req, res) => {
  try {
    const { name, email, message } = req.body || {};
    if (!name || !email || !message)
      return res.status(400).json({ error: 'All fields are required.' });

    const entry = {
      id:         crypto.randomUUID(),
      name:       name.trim(),
      email:      email.trim().toLowerCase(),
      message:    message.trim(),
      receivedAt: new Date().toISOString(),
      read:       false
    };
    if (req.file) {
      entry.attachment     = 'Notes/ContactUploads/' + req.file.filename;
      entry.attachmentName = req.file.originalname;
    }
    await dbInsertMessage(entry);
    console.log(`📩 New contact message from ${email}${req.file ? ' (with attachment)' : ''}`);
    res.json({ success: true });
  } catch (e) {
    console.error('Contact form error:', e);
    res.status(500).json({ error: 'Could not save message.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  ADMIN — USER MANAGEMENT ROUTES
// ══════════════════════════════════════════════════════════════════════════

// ── GET /api/admin/users ─────────────────────────────────────────────────────
app.get('/api/admin/users', async (req, res) => {
  if (!req.session || !req.session.authenticated)
    return res.status(403).json({ error: 'Admin access required.' });
  try {
    const users = (await dbGetAllUsers()).map(({ hash, salt, ...safe }) => safe);
    res.json({ users, total: users.length });
  } catch (e) {
    res.status(500).json({ error: 'Could not load users.' });
  }
});

// ── POST /api/admin/users/:id/toggle ────────────────────────────────────────
app.post('/api/admin/users/:id/toggle', async (req, res) => {
  if (!req.session || !req.session.authenticated)
    return res.status(403).json({ error: 'Admin access required.' });
  try {
    const { active } = req.body;
    const user = await dbFindUser({ id: req.params.id });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    await dbUpdateUser(req.params.id, { active: !!active });
    console.log(`${active ? '✅' : '🚫'} User ${user.email} ${active ? 'activated' : 'suspended'} by admin`);
    res.json({ success: true, active: !!active });
  } catch (e) {
    res.status(500).json({ error: 'Could not update user.' });
  }
});

// ── DELETE /api/admin/users/:id ──────────────────────────────────────────────
app.delete('/api/admin/users/:id', async (req, res) => {
  if (!req.session || !req.session.authenticated)
    return res.status(403).json({ error: 'Admin access required.' });
  try {
    const user = await dbFindUser({ id: req.params.id });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    await dbDeleteUser(req.params.id);
    console.log(`🗑  User deleted by admin: ${user.email}`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not delete user.' });
  }
});

// ── GET /api/admin/messages ──────────────────────────────────────────────────
app.get('/api/admin/messages', async (req, res) => {
  if (!req.session || !req.session.authenticated)
    return res.status(403).json({ error: 'Admin access required.' });
  try {
    res.json({ messages: await dbGetAllMessages() });
  } catch (e) {
    res.status(500).json({ error: 'Could not load messages.' });
  }
});

// ── POST /api/admin/messages/:id/read ───────────────────────────────────────
app.post('/api/admin/messages/:id/read', async (req, res) => {
  if (!req.session || !req.session.authenticated)
    return res.status(403).json({ error: 'Admin access required.' });
  try {
    await dbUpdateMessage(req.params.id, { read: true });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not update message.' });
  }
});

// ── DELETE /api/admin/messages/:id ──────────────────────────────────────────
app.delete('/api/admin/messages/:id', async (req, res) => {
  if (!req.session || !req.session.authenticated)
    return res.status(403).json({ error: 'Admin access required.' });
  try {
    await dbDeleteMessage(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not delete message.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  SONGS
// ══════════════════════════════════════════════════════════════════════════

// ── GET /api/songs ───────────────────────────────────────────────────────────
app.get('/api/songs', requireAuth, (req, res) => {
  res.json({ songs: songsStore, total: songsStore.length });
});

// ── GET /api/songs/:id ───────────────────────────────────────────────────────
app.get('/api/songs/:id', requireAuth, (req, res) => {
  const song = songsStore.find(s => s.id === req.params.id);
  if (!song) return res.status(404).json({ error: 'Song not found' });
  res.json(song);
});

// ── POST /api/songs ──────────────────────────────────────────────────────────
app.post('/api/songs', requireAuth, async (req, res) => {
  try {
    const id   = nextId();
    const data = sanitizeSong(req.body);
    if (!data.title) return res.status(400).json({ error: 'Title is required' });

    const song = { id, ...data };
    songsStore.push(song);
    songsStore.sort((a, b) => a.title.localeCompare(b.title));

    // Persist to MongoDB immediately
    await dbPersistSong(song);

    res.status(201).json({ success: true, song });
  } catch (e) {
    console.error('Add song error:', e);
    res.status(500).json({ error: 'Could not add song.' });
  }
});

// ── PUT /api/songs/:id ───────────────────────────────────────────────────────
app.put('/api/songs/:id', requireAuth, async (req, res) => {
  try {
    const idx = songsStore.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Song not found' });

    const data = sanitizeSong(req.body);
    songsStore[idx] = { id: req.params.id, ...data };

    // Persist to MongoDB immediately
    await dbPersistSong(songsStore[idx]);

    res.json({ success: true, song: songsStore[idx] });
  } catch (e) {
    console.error('Update song error:', e);
    res.status(500).json({ error: 'Could not update song.' });
  }
});

// ── DELETE /api/songs/:id ────────────────────────────────────────────────────
app.delete('/api/songs/:id', requireAuth, async (req, res) => {
  try {
    const idx = songsStore.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Song not found' });
    const removed = songsStore.splice(idx, 1)[0];

    // Remove from MongoDB immediately
    await dbDeleteSong(removed.id);

    res.json({ success: true, removed });
  } catch (e) {
    console.error('Delete song error:', e);
    res.status(500).json({ error: 'Could not delete song.' });
  }
});

// ── POST /api/upload ─────────────────────────────────────────────────────────
app.post('/api/upload', requireAuth, upload.array('files', 20), (req, res) => {
  if (!req.files || req.files.length === 0)
    return res.status(400).json({ error: 'No files uploaded' });
  const uploaded = req.files.map(f => {
    const ext      = path.extname(f.filename).toLowerCase();
    const fileType = ext === '.pdf' ? 'pdf' : 'image';
    return { filename: f.filename, path: `Notes/All Songs/${f.filename}`, fileType, size: f.size };
  });
  res.json({ success: true, files: uploaded });
});

// ── DELETE /api/upload/:filename ─────────────────────────────────────────────
app.delete('/api/upload/:filename', requireAuth, (req, res) => {
  const filePath = path.join(ALL_SONGS, req.params.filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// ── GET /api/contributors ────────────────────────────────────────────────────
app.get('/api/contributors', (req, res) => {
  res.json(contribStore);
});

// ── PUT /api/contributors ────────────────────────────────────────────────────
app.put('/api/contributors', async (req, res) => {
  if (!req.session || !req.session.authenticated)
    return res.status(403).json({ error: 'Admin access required' });
  try {
    const updated = req.body;
    if (!Array.isArray(updated)) return res.status(400).json({ error: 'Expected an array' });
    await dbSaveContributors(updated);
    res.json({ success: true, count: updated.length });
  } catch (e) {
    res.status(500).json({ error: 'Could not save contributors: ' + e.message });
  }
});

// ── POST /api/publish ────────────────────────────────────────────────────────
app.post('/api/publish', requireAuth, async (req, res) => {
  try {
    // 1. Back up current songs-data.json
    if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BACKUP_FILE);

    // 2. Write songs-data.json
    writeJsonSafe(DATA_FILE, { songs: songsStore });

    // 3. Update the inline `var SONGS = [...]` in index.html
    const INDEX_FILE = path.join(__dirname, 'index.html');
    if (fs.existsSync(INDEX_FILE)) {
      const rawBuf = fs.readFileSync(INDEX_FILE);
      let rawEnd = rawBuf.length - 1;
      while (rawEnd >= 0 && rawBuf[rawEnd] === 0) rawEnd--;
      let html = rawBuf.slice(0, rawEnd + 1).toString('utf8');
      const inlineData = JSON.stringify(songsStore);

      const varStart = html.indexOf('var SONGS');
      if (varStart !== -1) {
        const arrStart = html.indexOf('[', varStart);
        if (arrStart !== -1) {
          let depth = 0, arrEnd = -1;
          for (let i = arrStart; i < html.length; i++) {
            if (html[i] === '[') depth++;
            else if (html[i] === ']') { depth--; if (depth === 0) { arrEnd = i; break; } }
          }
          if (arrEnd !== -1) {
            const semiPos    = html.indexOf(';', arrEnd);
            const replaceEnd = semiPos !== -1 ? semiPos + 1 : arrEnd + 1;
            html = html.substring(0, varStart) + 'var SONGS = ' + inlineData + ';' + html.substring(replaceEnd);
            fs.writeFileSync(INDEX_FILE, html, 'utf8');
            console.log(`✅ index.html updated — embedded ${songsStore.length} songs`);
          }
        }
      }
    }

    // 4. Also bulk-sync all songs to MongoDB to ensure full consistency
    if (db) {
      try {
        await db.collection('songs').deleteMany({});
        if (songsStore.length > 0) {
          await db.collection('songs').insertMany(
            songsStore.map(s => ({ _id: s.id, ...s }))
          );
        }
        console.log(`✅ MongoDB songs fully synced (${songsStore.length} songs)`);
      } catch (e) {
        console.warn('⚠️  MongoDB bulk sync failed:', e.message);
      }
    }

    res.json({
      success: true,
      message: `Published successfully. ${songsStore.length} songs saved.`,
      count: songsStore.length
    });
  } catch (e) {
    res.status(500).json({ error: 'Publish failed: ' + e.message });
  }
});

// ── POST /api/restore-backup ─────────────────────────────────────────────────
app.post('/api/restore-backup', requireAuth, async (req, res) => {
  if (!fs.existsSync(BACKUP_FILE))
    return res.status(404).json({ error: 'No backup file found' });
  fs.copyFileSync(BACKUP_FILE, DATA_FILE);
  await loadSongs();
  res.json({ success: true, message: 'Backup restored. Reload the page to see changes.' });
});

// ── GET /api/stats ───────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, (req, res) => {
  const byCategory = {};
  songsStore.forEach(s => {
    const c = s.category || 'Uncategorized';
    byCategory[c] = (byCategory[c] || 0) + 1;
  });
  const incomplete = songsStore.filter(
    s => !s.scale || !s.style || !s.tempo || !s.difficulty
  ).length;
  res.json({ total: songsStore.length, byCategory, incomplete });
});

// ── Start server (async to connect DB first) ─────────────────────────────────
async function startServer() {
  await connectDB();
  await loadSongs();
  await loadContributors();

  app.listen(PORT, () => {
    console.log(`\n🎹 Tamil Christian Keyboard Notes — Admin Server`);
    console.log(`   Public site : http://localhost:${PORT}/`);
    console.log(`   Admin panel : http://localhost:${PORT}/admin.html`);
    console.log(`   Port        : ${PORT}`);
    console.log(`   DB          : ${db ? 'MongoDB ✅' : 'JSON files ⚠️ (not persistent)'}\n`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
