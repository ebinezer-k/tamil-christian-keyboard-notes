/**
 * Tamil Christian Keyboard Notes — Admin Server
 * Run: node server.js  (or: npm run dev  for auto-reload)
 * Requires: .env file with ADMIN_PASSWORD and SESSION_SECRET
 */

require('dotenv').config();
const express    = require('express');
const session    = require('express-session');
const multer     = require('multer');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Paths ──────────────────────────────────────────────────────────────────
const DATA_FILE   = path.join(__dirname, 'songs-data.json');
const BACKUP_FILE = path.join(__dirname, 'songs-data.backup.json');
const NOTES_DIR   = path.join(__dirname, 'Notes');
const ALL_SONGS   = path.join(NOTES_DIR, 'All Songs');
const USERS_FILE   = path.join(__dirname, 'users.json');
const CONTRIB_FILE = path.join(__dirname, 'contributors.json');

// Ensure Notes/All Songs directory exists
if (!fs.existsSync(ALL_SONGS)) fs.mkdirSync(ALL_SONGS, { recursive: true });

// ── Null-byte safe file helpers (OneDrive pads files with nulls) ───────────
function readJsonSafe(filePath) {
  const buf = fs.readFileSync(filePath);          // read as Buffer
  let end = buf.length - 1;
  while (end >= 0 && buf[end] === 0) end--;       // strip trailing null bytes
  return JSON.parse(buf.slice(0, end + 1).toString('utf8'));
}
function writeJsonSafe(filePath, obj) {
  const content = JSON.stringify(obj, null, 2);
  fs.writeFileSync(filePath, content, 'utf8');
}

// ── In-memory contributors store ───────────────────────────────────────────
let contribStore = [];
function loadContributors() {
  try {
    if (fs.existsSync(CONTRIB_FILE)) {
      contribStore = readJsonSafe(CONTRIB_FILE);
      console.log(`✅ Loaded ${contribStore.length} contributors from contributors.json`);
    }
  } catch (e) {
    console.error('❌ Could not load contributors.json:', e.message);
    contribStore = [];
  }
}
loadContributors();

// ── In-memory song store ───────────────────────────────────────────────────
let songsStore = [];
function loadSongs() {
  try {
    const data = readJsonSafe(DATA_FILE);
    songsStore = data.songs || [];
    if (songsStore.length === 0) throw new Error('songs array is empty');
    console.log(`✅ Loaded ${songsStore.length} songs from songs-data.json`);
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
loadSongs();
console.log(`   In-memory store: ${songsStore.length} songs`);

// ── Multer file upload config ──────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // All files (images and PDFs) go to Notes/All Songs/
    cb(null, ALL_SONGS);
  },
  filename: (req, file, cb) => {
    // Preserve original filename; avoid collisions with timestamp suffix
    const ext  = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[/\\?%*:|"<>]/g, '-');
    const dest = path.join(ALL_SONGS, file.originalname);
    // Use original name if not taken, otherwise append timestamp
    if (!fs.existsSync(dest)) {
      cb(null, file.originalname);
    } else {
      cb(null, `${base}_${Date.now()}${ext}`);
    }
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only PDF, JPG, and PNG files are allowed'));
  }
});

// ── Middleware ─────────────────────────────────────────────────────────────
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

// ── User store helpers ─────────────────────────────────────────────────────
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    const raw = fs.readFileSync(USERS_FILE, 'utf8').replace(/\0/g, '');
    return JSON.parse(raw).users || [];
  } catch(e) { return []; }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2), 'utf8');
}
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.createHmac('sha256', s).update(password).digest('hex');
  return { hash: h, salt: s };
}
function verifyPassword(password, hash, salt) {
  return crypto.createHmac('sha256', salt).update(password).digest('hex') === hash;
}

// ── Auth middleware ────────────────────────────────────────────────────────
// Allows both admin sessions AND regular user sessions
function requireAuth(req, res, next) {
  if (req.session && (req.session.authenticated || req.session.userId)) return next();
  res.status(401).json({ error: 'Unauthorized. Please log in.' });
}

// ── Helper: generate next song ID ─────────────────────────────────────────
function nextId() {
  const nums = songsStore
    .map(s => parseInt((s.id || '').replace('S', ''), 10))
    .filter(n => !isNaN(n));
  const max = nums.length > 0 ? Math.max(...nums) : 0;
  return `S${String(max + 1).padStart(4, '0')}`;
}

// ── Helper: sanitize a song object ────────────────────────────────────────
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

// ── POST /api/login ────────────────────────────────────────────────────────
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

// ── POST /api/logout ───────────────────────────────────────────────────────
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ── GET /api/auth/status ───────────────────────────────────────────────────
app.get('/api/auth/status', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// ══════════════════════════════════════════════════════════════════════════
//  USER AUTH ROUTES
// ══════════════════════════════════════════════════════════════════════════

// ── GET /api/user/check — is a regular user logged in? ────────────────────
app.get('/api/user/check', (req, res) => {
  if (req.session && (req.session.userId || req.session.authenticated)) {
    return res.json({
      loggedIn: true,
      name: req.session.userName || 'Admin',
      email: req.session.userEmail || ''
    });
  }
  res.json({ loggedIn: false });
});

// ── POST /api/user/signup ─────────────────────────────────────────────────
app.post('/api/user/signup', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Name, email and password are required.' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const users = loadUsers();
  const existing = users.find(u => u.email === email.toLowerCase().trim());
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
  users.push(newUser);
  saveUsers(users);

  // Auto-login after signup
  req.session.userId    = newUser.id;
  req.session.userName  = newUser.name;
  req.session.userEmail = newUser.email;

  console.log(`✅ New user registered: ${newUser.email}`);
  res.status(201).json({ success: true, name: newUser.name, email: newUser.email });
});

// ── POST /api/user/login ──────────────────────────────────────────────────
app.post('/api/user/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required.' });

  const users = loadUsers();
  const user  = users.find(u => u.email === email.toLowerCase().trim());
  if (!user || !verifyPassword(password, user.hash, user.salt))
    return res.status(401).json({ error: 'Incorrect email or password.' });

  if (user.active === false)
    return res.status(403).json({ error: 'Your account has been suspended. Please contact the administrator.' });

  // Record last login time
  user.lastLogin = new Date().toISOString();
  const allUsers = loadUsers();
  const idx = allUsers.findIndex(u => u.id === user.id);
  if (idx !== -1) { allUsers[idx].lastLogin = user.lastLogin; saveUsers(allUsers); }

  req.session.userId    = user.id;
  req.session.userName  = user.name;
  req.session.userEmail = user.email;

  console.log(`✅ User logged in: ${user.email}`);
  res.json({ success: true, name: user.name, email: user.email });
});

// ── POST /api/user/logout ─────────────────────────────────────────────────
app.post('/api/user/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ── POST /api/contact — save user message ─────────────────────────────────
const MESSAGES_FILE    = path.join(__dirname, 'messages.json');
const CONTACT_UPLOADS  = path.join(__dirname, 'Notes', 'ContactUploads');
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

function loadMessages() {
  try {
    if (!fs.existsSync(MESSAGES_FILE)) return [];
    const raw = fs.readFileSync(MESSAGES_FILE, 'utf8').replace(/\0/g, '');
    return JSON.parse(raw).messages || [];
  } catch(e) { return []; }
}
function saveMessages(msgs) {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify({ messages: msgs }, null, 2), 'utf8');
}
app.post('/api/contact', contactUpload.single('attachment'), (req, res) => {
  const { name, email, message } = req.body || {};
  if (!name || !email || !message)
    return res.status(400).json({ error: 'All fields are required.' });
  const msgs = loadMessages();
  const entry = {
    id: crypto.randomUUID(),
    name: name.trim(),
    email: email.trim().toLowerCase(),
    message: message.trim(),
    receivedAt: new Date().toISOString(),
    read: false
  };
  if (req.file) {
    entry.attachment = 'Notes/ContactUploads/' + req.file.filename;
    entry.attachmentName = req.file.originalname;
  }
  msgs.push(entry);
  saveMessages(msgs);
  console.log(`📩 New contact message from ${email}${req.file ? ' (with attachment)' : ''}`);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════
//  ADMIN — USER MANAGEMENT ROUTES  (admin session required)
// ══════════════════════════════════════════════════════════════════════════

// ── GET /api/admin/users ─────────────────────────────────────────────────
app.get('/api/admin/users', (req, res) => {
  if (!req.session || !req.session.authenticated)
    return res.status(403).json({ error: 'Admin access required.' });
  const users = loadUsers().map(({ hash, salt, ...safe }) => safe); // strip passwords
  res.json({ users, total: users.length });
});

// ── POST /api/admin/users/:id/toggle ─────────────────────────────────────
app.post('/api/admin/users/:id/toggle', (req, res) => {
  if (!req.session || !req.session.authenticated)
    return res.status(403).json({ error: 'Admin access required.' });
  const { active } = req.body;
  const users = loadUsers();
  const idx   = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found.' });
  users[idx].active = !!active;
  saveUsers(users);
  console.log(`${active ? '✅' : '🚫'} User ${users[idx].email} ${active ? 'activated' : 'suspended'} by admin`);
  res.json({ success: true, active: !!active });
});

// ── DELETE /api/admin/users/:id ───────────────────────────────────────────
app.delete('/api/admin/users/:id', (req, res) => {
  if (!req.session || !req.session.authenticated)
    return res.status(403).json({ error: 'Admin access required.' });
  let users = loadUsers();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found.' });
  const removed = users.splice(idx, 1)[0];
  saveUsers(users);
  console.log(`🗑  User deleted by admin: ${removed.email}`);
  res.json({ success: true });
});

// ── GET /api/admin/messages ───────────────────────────────────────────────
app.get('/api/admin/messages', (req, res) => {
  if (!req.session || !req.session.authenticated)
    return res.status(403).json({ error: 'Admin access required.' });
  res.json({ messages: loadMessages() });
});

// ── POST /api/admin/messages/:id/read ────────────────────────────────────
app.post('/api/admin/messages/:id/read', (req, res) => {
  if (!req.session || !req.session.authenticated)
    return res.status(403).json({ error: 'Admin access required.' });
  const msgs = loadMessages();
  const m = msgs.find(m => m.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'Message not found.' });
  m.read = true;
  saveMessages(msgs);
  res.json({ success: true });
});

// ── DELETE /api/admin/messages/:id ───────────────────────────────────────
app.delete('/api/admin/messages/:id', (req, res) => {
  if (!req.session || !req.session.authenticated)
    return res.status(403).json({ error: 'Admin access required.' });
  let msgs = loadMessages();
  const idx = msgs.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Message not found.' });
  msgs.splice(idx, 1);
  saveMessages(msgs);
  res.json({ success: true });
});

// ── GET /api/songs ─────────────────────────────────────────────────────────
app.get('/api/songs', requireAuth, (req, res) => {
  res.json({ songs: songsStore, total: songsStore.length });
});

// ── GET /api/songs/:id ─────────────────────────────────────────────────────
app.get('/api/songs/:id', requireAuth, (req, res) => {
  const song = songsStore.find(s => s.id === req.params.id);
  if (!song) return res.status(404).json({ error: 'Song not found' });
  res.json(song);
});

// ── POST /api/songs ────────────────────────────────────────────────────────
app.post('/api/songs', requireAuth, (req, res) => {
  const id   = nextId();
  const data = sanitizeSong(req.body);
  if (!data.title) return res.status(400).json({ error: 'Title is required' });

  const song = { id, ...data };
  songsStore.push(song);
  // Keep list sorted by title
  songsStore.sort((a, b) => a.title.localeCompare(b.title));
  res.status(201).json({ success: true, song });
});

// ── PUT /api/songs/:id ─────────────────────────────────────────────────────
app.put('/api/songs/:id', requireAuth, (req, res) => {
  const idx = songsStore.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Song not found' });

  const data = sanitizeSong(req.body);
  songsStore[idx] = { id: req.params.id, ...data };
  res.json({ success: true, song: songsStore[idx] });
});

// ── DELETE /api/songs/:id ──────────────────────────────────────────────────
app.delete('/api/songs/:id', requireAuth, (req, res) => {
  const idx = songsStore.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Song not found' });
  const removed = songsStore.splice(idx, 1)[0];
  res.json({ success: true, removed });
});

// ── POST /api/upload ───────────────────────────────────────────────────────
app.post('/api/upload', requireAuth, upload.array('files', 20), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }
  const uploaded = req.files.map(f => {
    const ext      = path.extname(f.filename).toLowerCase();
    const fileType = ext === '.pdf' ? 'pdf' : 'image';
    const relPath  = `Notes/All Songs/${f.filename}`;
    return { filename: f.filename, path: relPath, fileType, size: f.size };
  });
  res.json({ success: true, files: uploaded });
});

// ── DELETE /api/upload/:filename ───────────────────────────────────────────
app.delete('/api/upload/:filename', requireAuth, (req, res) => {
  const filename = req.params.filename;
  // All uploaded files live in Notes/All Songs/
  const filePath = path.join(ALL_SONGS, filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// ── GET /api/contributors — public, no auth needed ─────────────────────────
app.get('/api/contributors', (req, res) => {
  res.json(contribStore);
});

// ── PUT /api/contributors — admin only ─────────────────────────────────────
app.put('/api/contributors', (req, res) => {
  if (!req.session || !req.session.authenticated)
    return res.status(403).json({ error: 'Admin access required' });
  try {
    const updated = req.body;
    if (!Array.isArray(updated)) return res.status(400).json({ error: 'Expected an array' });
    contribStore = updated;
    writeJsonSafe(CONTRIB_FILE, contribStore);
    res.json({ success: true, count: contribStore.length });
  } catch (e) {
    res.status(500).json({ error: 'Could not save contributors: ' + e.message });
  }
});

// ── POST /api/publish ──────────────────────────────────────────────────────
app.post('/api/publish', requireAuth, (req, res) => {
  try {
    // 1. Back up current songs-data.json
    if (fs.existsSync(DATA_FILE)) {
      fs.copyFileSync(DATA_FILE, BACKUP_FILE);
    }

    // 2. Write updated songs-data.json (using safe helper that avoids OneDrive null-padding)
    writeJsonSafe(DATA_FILE, { songs: songsStore });

    // 3. Update the inline `var SONGS = [...]` in index.html
    //    index.html embeds the song data directly — this keeps the public
    //    page in sync without requiring a separate fetch at runtime.
    const INDEX_FILE = path.join(__dirname, 'index.html');
    if (fs.existsSync(INDEX_FILE)) {
      // Strip null bytes from index.html before reading (OneDrive padding fix)
      const rawBuf = fs.readFileSync(INDEX_FILE);
      let rawEnd = rawBuf.length - 1;
      while (rawEnd >= 0 && rawBuf[rawEnd] === 0) rawEnd--;
      let html = rawBuf.slice(0, rawEnd + 1).toString('utf8');
      const inlineData = JSON.stringify(songsStore);

      // Find the exact start and end positions of `var SONGS = [...];`
      const varStart = html.indexOf('var SONGS');
      if (varStart === -1) throw new Error('Could not find "var SONGS" in index.html');

      const arrStart = html.indexOf('[', varStart);
      if (arrStart === -1) throw new Error('Could not find opening [ of SONGS array');

      // Walk forward to find the matching closing ] that ends the array
      let depth = 0, arrEnd = -1;
      for (let i = arrStart; i < html.length; i++) {
        if (html[i] === '[') depth++;
        else if (html[i] === ']') { depth--; if (depth === 0) { arrEnd = i; break; } }
      }
      if (arrEnd === -1) throw new Error('Could not find closing ] of SONGS array');

      // Replace from `var SONGS` up to and including the `];`
      const semiPos  = html.indexOf(';', arrEnd);
      const replaceEnd = semiPos !== -1 ? semiPos + 1 : arrEnd + 1;
      html = html.substring(0, varStart) +
             'var SONGS = ' + inlineData + ';' +
             html.substring(replaceEnd);

      fs.writeFileSync(INDEX_FILE, html, 'utf8');
      console.log(`✅ index.html updated — embedded ${songsStore.length} songs`);
    }

    res.json({
      success: true,
      message: `Published successfully. ${songsStore.length} songs saved to songs-data.json and index.html`,
      count: songsStore.length
    });
  } catch (e) {
    res.status(500).json({ error: 'Publish failed: ' + e.message });
  }
});

// ── POST /api/restore-backup ───────────────────────────────────────────────
app.post('/api/restore-backup', requireAuth, (req, res) => {
  if (!fs.existsSync(BACKUP_FILE)) {
    return res.status(404).json({ error: 'No backup file found' });
  }
  fs.copyFileSync(BACKUP_FILE, DATA_FILE);
  loadSongs();
  res.json({ success: true, message: 'Backup restored. Reload the page to see changes.' });
});

// ── GET /api/stats ─────────────────────────────────────────────────────────
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

// ── Start server ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎹 Tamil Christian Keyboard Notes — Admin Server`);
  console.log(`   Public site : http://localhost:${PORT}/`);
  console.log(`   Admin panel : http://localhost:${PORT}/admin.html`);
  console.log(`   Port        : ${PORT}\n`);
});
