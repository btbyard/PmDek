# PMDek

AI-powered Kanban project management — fast, Firebase-backed, and designed for solo builders and small teams.

**Stack:** Node.js · Vanilla JS · Tailwind CSS · Firebase (Auth, Firestore, Storage, Hosting, Functions) · Gemini AI

---

## Features

- **AI deck generation** — describe a project in plain English; Gemini creates a full board with tasks and subtasks
- **AI card generation** — describe a single task and the AI fills in the details
- **Drag-and-drop Kanban** — reorder cards and columns with smooth HTML5 drag-and-drop
- **Card colors** — color-code cards with a quick swatch picker per column
- **Deck colors** — color-band each project deck and filter the home screen by color
- **Due dates** — set due dates on both decks and individual cards
- **File attachments** — attach files to cards via Firebase Storage
- **Task & subtask tracking** — checkable tasks with subtasks and progress indicators
- **Completion timeline** — log and review every task completion per project
- **Multi-auth** — sign in with Google, GitHub, or email/password
- **AI rate limit** — free tier capped at 2 AI requests per day (see [MONETIZATION.md](MONETIZATION.md))


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
│   ├── board.js       # Board document + column DOM + card-stats query
│   ├── boards-home.js # Deck home — tile grid, modals, color filter
│   ├── cards.js       # Card CRUD + real-time sync + modals + color picker
│   ├── ai-chat.js     # Persistent AI chat sidebar
│   ├── drag.js        # HTML5 drag-and-drop
│   └── ai.js          # Gemini callable wrappers + AI modals
├── styles/
│   └── main.css       # Tailwind directives + custom components
├── functions/
│   ├── index.js       # Cloud Functions (generateCard, generateBoard, generateBoardWithTasks)
│   └── package.json
├── index.html
├── firebase.json
├── firestore.rules
├── firestore.indexes.json
├── storage.rules
├── tailwind.config.js
├── vite.config.js
├── MONETIZATION.md
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

## Roadmap / feature scope

- [x] Google + GitHub + email sign-in
- [x] Multi-deck home screen with playing-card tile UI
- [x] Deck colors, due dates, task/subtask counts on tiles
- [x] Kanban columns — add, rename, delete, drag-reorder
- [x] Cards — create, edit, delete, drag-and-drop
- [x] Card colors, due dates, file attachments, subtasks
- [x] Task completion logging + Project Timeline modal
- [x] AI deck generation (Gemini via Cloud Function)
- [x] AI card generation + persistent chat sidebar
- [x] AI rate limiting (2 requests/day on free tier)
- [x] Firebase Storage for file attachments
- [ ] Pro tier — unlimited AI + team collaboration (see [MONETIZATION.md](MONETIZATION.md))
- [ ] Deck sharing + real-time multi-user editing
- [ ] Advanced reports and analytics

## Contributing

Issues and PRs welcome. Please open an issue before submitting large changes.

## License

MIT
