# PMDek

Lightweight, web-based Kanban project management with light AI assistance.

**Stack:** Node.js · Vanilla JS · Tailwind CSS · Firebase (Auth, Firestore, Hosting, Functions) · Gemini

---

## Quick start

### Prerequisites

- Node.js 20+
- Firebase CLI: `npm install -g firebase-tools`
- A Firebase project with these services enabled:
  - Authentication (Google + GitHub providers)
  - Firestore
  - Hosting
  - Cloud Functions

### 1. Clone and install

```bash
git clone https://github.com/your-handle/pmdek.git
cd pmdek
npm install
cd functions && npm install && cd ..
```

### 2. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in your Firebase project config. Find the values in:

> Firebase Console → Project Settings → Your Apps → Web app → SDK setup and configuration

```env
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

### 3. Link to your Firebase project

```bash
firebase login
firebase use --add        # select your project, alias it 'default'
```

Or edit `.firebaserc` directly:

```json
{ "projects": { "default": "your-project-id" } }
```

### 4. Enable GitHub sign-in in Firebase

1. Firebase Console → Authentication → Sign-in method → GitHub → Enable
2. Copy the **OAuth redirect URI** shown there
3. Go to GitHub → Settings → Developer settings → OAuth Apps → New OAuth App
4. Set the Authorization callback URL to the URI from step 2
5. Copy the Client ID and Client Secret back into Firebase

### 5. Set the Gemini API key

**For local development (emulator):**

Create `functions/.env.local`:

```
GEMINI_API_KEY=your-gemini-api-key
```

> Get a key at [aistudio.google.com](https://aistudio.google.com)

**For production:**

Store the key in Google Secret Manager (recommended — never in source control):

```bash
echo -n "your-gemini-api-key" | gcloud secrets create GEMINI_API_KEY --data-file=-
```

Grant the Cloud Functions service account the `Secret Manager Secret Accessor` role.

### 6. Run locally

```bash
# Start Vite dev server (hot reload)
npm run dev

# In a separate terminal — start Firebase emulators
firebase emulators:start
```

Vite runs on `http://localhost:5173`. Emulator UI at `http://localhost:4000`.

### 7. Deploy

```bash
npm run deploy
# Builds Vite → dist/, then deploys Hosting + Functions + Firestore rules
```

---

## Project structure

```
pmdek/
├── src/
│   ├── main.js        # Entry — wires auth → board lifecycle
│   ├── firebase.js    # Firebase app init + service exports
│   ├── auth.js        # Sign-in / sign-out / auth state
│   ├── board.js       # Board document + column DOM
│   ├── cards.js       # Card CRUD + real-time sync + modals
│   ├── drag.js        # HTML5 drag-and-drop
│   └── ai.js          # Gemini callable wrappers + AI modal
├── styles/
│   └── main.css       # Tailwind directives + custom components
├── functions/
│   ├── index.js       # Cloud Functions (AI only)
│   └── package.json
├── index.html
├── firebase.json
├── firestore.rules
├── firestore.indexes.json
├── tailwind.config.js
├── vite.config.js
└── .env.example
```

---

## Architecture decisions

| Decision | Reason |
|---|---|
| Vite (not CRA/Next) | Dev server + bundler only. No framework overhead. |
| Flat `cards` collection | Single query per board instead of N queries per column. |
| Float midpoint ordering | One Firestore write on drag-drop. No index recomputation. |
| Columns in board document | Fixed list; never queried independently in v1. |
| Cloud Functions for AI | Gemini key never reaches the browser. |
| Event delegation for cards | Cards re-render on every Firestore snapshot; delegation avoids listener leaks. |

---

## v0.1 scope

- [x] Google + GitHub sign-in
- [x] Auto-created board on first login
- [x] Three columns: Todo, In Progress, Done
- [x] Card create / edit / delete
- [x] Drag-and-drop between and within columns
- [x] AI card generation (Gemini via Cloud Function)
- [x] Firebase Hosting deploy

## Contributing

Issues and PRs welcome. Please open an issue before submitting large changes.

## License

MIT
