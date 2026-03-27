# 🎹 Tamil Christian Keyboard Notes

A full-stack web app for browsing, searching, and managing **Tamil Christian song keyboard notes** — built for musicians, worship leaders, and song enthusiasts.

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4.x-blue)](https://expressjs.com)
[![Railway](https://img.shields.io/badge/Deploy-Railway-blueviolet)](https://railway.app)

---

## ✨ Features

- 🔍 **Search & Browse** — Find songs by name instantly from 800+ Tamil Christian songs
- 🎵 **Keyboard Notes Viewer** — View PDF keyboard notes directly in the browser
- 👤 **User Contributions** — Registered users can upload and contribute notes
- 🛡️ **Admin Panel** — Manage songs, approve contributions, and organize the library
- 📁 **PDF Archive** — Organized local archive of all song note PDFs
- 🚀 **Railway Ready** — Configured for one-click deployment on Railway

---

## 📋 Prerequisites

- [Node.js](https://nodejs.org) v18 or higher
- npm v8 or higher

---

## 🚀 Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/ebinezer-k/tamil-christian-keyboard-notes.git
cd tamil-christian-keyboard-notes
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create environment file

Create a `.env` file in the root directory:

```env
ADMIN_PASSWORD=your_secure_admin_password
SESSION_SECRET=your_random_session_secret
PORT=3000
```

### 4. Start the server

```bash
# Development (auto-reload)
npm run dev

# Production
npm start
```

Open your browser at **http://localhost:3000**

---

## 📁 Project Structure

```
tamil-christian-keyboard-notes/
├── server.js          # Express server & API routes
├── index.html         # Main song browser (frontend)
├── admin.html         # Admin panel
├── auth.html          # Login / registration page
├── songs-data.json    # Song catalogue (800+ songs)
├── contributors.json  # Contributor records
├── Notes/             # Keyboard note PDFs (organized by category)
│   ├── All Songs/
│   └── Christmas/
├── railway.json       # Railway deployment config
└── package.json
```

---

## 🌐 Deployment (Railway)

This project includes a `railway.json` for seamless Railway deployment.

1. Push your code to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Add environment variables: `ADMIN_PASSWORD`, `SESSION_SECRET`
4. Railway auto-deploys on every push to `main`

---

## 🤝 Contributing

Contributions of new song notes are welcome!

1. Fork the repository
2. Add your notes to `Notes/All Songs/`
3. Update `songs-data.json` with the song entry
4. Submit a pull request

---

## 📖 About

This project was created to digitize and share Tamil Christian keyboard notes for worship musicians. The notes are collected and created by the community to make Tamil Christian music more accessible.

---

## 📄 License

MIT License — feel free to use and adapt for your worship community.
