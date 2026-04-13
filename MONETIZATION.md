# PMDecks — Monetization Plan

## Free Tier (current)

All users get access to core PMDecks functionality at no cost:

- Unlimited project decks
- Unlimited cards, tasks, and subtasks
- Drag-and-drop Kanban boards
- Card colors, due dates, and file attachments
- **2 AI requests per day** (deck generation or card generation via Gemini)

The 2-request daily AI limit prevents abuse of Gemini API costs while still letting users experience the AI features.

### Enforcing the AI limit (planned implementation)

- Store `aiRequestCount` and `aiRequestDate` on the Firestore user document (or a subcollection)
- Cloud Function middleware checks count before invoking Gemini
- Reset count at midnight UTC each day
- Return a `QUOTA_EXCEEDED` error code that the client handles gracefully (shows upgrade prompt)

---

## Pro Tier (future — paid)

**Target price: ~$8–12/month**

### Features

| Feature | Free | Pro |
|---|---|---|
| AI requests per day | 2 | Unlimited |
| Project decks | Unlimited | Unlimited |
| **Team collaboration** | ❌ | ✅ |
| **Deck sharing** | ❌ | ✅ |
| **Real-time multi-user** | ❌ | ✅ |
| Priority support | ❌ | ✅ |
| Advanced timeline/reports | ❌ | ✅ |

### Team Collaboration (flagship Pro feature)

Users will be able to invite collaborators to a specific deck by email or user ID.

**Planned Firestore data model:**

```
boards/{boardId}
  ownerId:      string          // user who created the deck
  members:      string[]        // array of user UIDs with access
  memberEmails: string[]        // for invite lookup before signup
  role:         map<uid, 'admin'|'editor'|'viewer'>
```

**Planned features:**
- Invite by email (sends Firebase invite link)
- Role-based access: admin (full), editor (cards only), viewer (read-only)
- Real-time presence indicators (who's viewing the deck)
- Activity feed per deck (who added/moved/completed what)
- Deck owner can revoke access at any time

**Security rules update needed:**
```
match /boards/{boardId} {
  allow read: if request.auth.uid == resource.data.ownerId
              || request.auth.uid in resource.data.members;
  allow write: if request.auth.uid == resource.data.ownerId
               || get(/boards/$(boardId)).data.role[request.auth.uid] == 'admin'
               || get(/boards/$(boardId)).data.role[request.auth.uid] == 'editor';
}
```

---

## Payment Infrastructure (planned)

- **Stripe** for subscription billing (Stripe Checkout + Customer Portal)
- Firebase Cloud Function webhook to handle `customer.subscription.created/deleted` events
- Write `plan: 'pro'` to the user's Firestore document on successful payment
- Client checks `plan` field before calling AI functions or enabling Pro features

---

## Revenue Projections (rough)

| Users | Conversion | MRR |
|---|---|---|
| 1,000 free | 3% → 30 Pro | ~$300 |
| 5,000 free | 3% → 150 Pro | ~$1,500 |
| 20,000 free | 3% → 600 Pro | ~$6,000 |

---

## Notes

- AI cost at scale is the main variable expense (Gemini API pricing per token)
- Firebase scales cheaply until ~50k DAU — no infrastructure changes needed early on
- The freemium model (generous free tier + collaboration as the paid hook) is proven in tools like Notion, Linear, and Trello
