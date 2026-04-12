# Admin System Setup Guide

## Overview

PMDek now has a comprehensive admin system with:
- **Global admins** (`isAdmin` flag on user documents)
- **Organization admins** (`admins` array on organization documents)
- **Admin Dashboard** for managing users, orgs, and viewing platform stats

---

## 1. Global Admin Setup

### Option A: From Browser Console (Recommended for First Setup)

1. **Sign in** with your account at the PMDek app
2. **Open the browser console** (F12 → Console tab)
3. **Run this command**:
   ```javascript
   window.setupAdmin('bradster8@yahoo.com')
   ```
4. You'll see a confirmation message when complete
5. **Refresh the page** to see the Admin Panel button appear in Account menu

### Option B: Using Firebase Console (Alternative)

1. Go to [Firebase Console](https://console.firebase.google.com/project/pmdek-c2c21)
2. Navigate to **Firestore Database** → **Collections** → **users**
3. Find your user document (matching your email)
4. Click **Edit** and add a field:
   - **Field name**: `isAdmin`
   - **Type**: `boolean`
   - **Value**: `true`
5. Click **Save**, then refresh the PMDek app

---

## 2. Admin Panel Features

Once you're an admin, you'll see an **⚡ Admin Panel** option in the Account dropdown menu (top-right).

### Admin Panel Shows:

#### **Stats Overview** (4 cards)
- **Total Users** — registered user count
- **Organizations** — total orgs created
- **Boards** — all boards across platform
- **Cards** — all tasks/cards across platform

#### **Users Table**
- User name, email, admin status, billing plan
- **Make Admin** / **Remove Admin** buttons to toggle admin status
- Quick access to promote users to admins

#### **Organizations Table**
- Org name, member count, admin count, org ID
- View which organizations have how many admins

---

## 3. User Field Structure

### User Document (`/users/{uid}`)
```javascript
{
  displayName: string,
  email: string,
  photoURL: string,
  billingPlan: 'free' | 'mid' | 'pro' | 'business-small' | 'business-growth',
  billingStatus: string,
  organizationId: string | null,
  ownedOrgId: string | null,
  username: string,
  isAdmin: boolean (NEW),    // ← Add this field
  createdAt: timestamp,
}
```

### Organization Document (`/organizations/{orgId}`)
```javascript
{
  name: string,
  ownerId: string,
  members: array<uid>,
  admins: array<uid> (NEW),  // ← Add this field
  createdAt: timestamp,
}
```

---

## 4. Organization Admins

### How Org Admins Work

- Organization creators are **automatically admins** of their org
- Org admins can invite/remove members (already implemented)
- Future feature: Org admins manage org-level settings

### Setting Org Admins Programmatically

From the browser console (if you're a global admin):
```javascript
// Add a user as org admin
await setOrgMemberAdminStatus('orgId', 'userId', true)

// Remove org admin
await setOrgMemberAdminStatus('orgId', 'userId', false)
```

Or manually in Firebase Console:
1. Navigate to `/organizations/{orgId}`
2. Edit the `admins` array
3. Add/remove user UIDs as needed

---

## 5. Cloud Function: setUserAsAdmin

A new Cloud Function handles admin promotions with proper auth checks:

```javascript
// Function: setUserAsAdmin
// Access: Admin-only (verifies caller is admin)
// Endpoint: https://.../.../setUserAsAdmin

// Usage from app:
const result = await window.setupAdmin('user@example.com')
// Returns: { uid, email, isAdmin: true }
```

---

## 6. Access Control

### Who Can Access Admin Panel?
- Users with `isAdmin: true` in their Firestore user document
- Only admins can toggle other users' admin status
- Admin Panel button only appears for admins

### Who Can Call setUserAsAdmin Cloud Function?
- Only authenticated users who are already admins (enforced server-side)
- First admin must be set via Firebase Console or browser console

---

## 7. Initial Admin Setup Checklist

- [ ] Deploy Cloud Functions: `firebase deploy --only functions`
- [ ] Deploy Firestore rules: `firebase deploy --only firestore:rules`
- [ ] Sign in with your account (bradster8@yahoo.com)
- [ ] Run: `window.setupAdmin('bradster8@yahoo.com')` in console
- [ ] Refresh the page
- [ ] Click Account → Admin Panel to verify it worked
- [ ] Optionally promote other team members as needed

---

## 8. Firestore Security Rules

Ensure your Firestore rules protect admin operations:

```firestore
// Users collection
match /users/{uid} {
  allow read: if request.auth.uid == uid || request.auth.uid == admin;
  allow update: if request.auth.uid == uid || isAdmin(request.auth.uid);
}

// Admin check helper
function isAdmin(uid) {
  return get(/databases/$(database)/documents/users/$(uid)).data.isAdmin == true
}
```

---

## 9. Troubleshooting

### Admin Panel doesn't appear
- Verify `isAdmin: true` is set in your Firestore user doc
- Refresh the page (F5)
- Check browser console for errors

### setupAdmin command fails
- Make sure you're signed in
- Verify Cloud Functions are deployed
- Check browser console for error details

### Can't find user
- Ensure the email is exact (case-sensitive in query)
- User must have signed in at least once to exist in Firestore

---

## 10. Next Steps (Optional)

- [ ] Add org-level settings management for org admins
- [ ] Add admin activity audit log
- [ ] Create admin reports/analytics dashboard
- [ ] Add bulk user import for team workspaces
- [ ] Implement role-based access control (RBAC) for more granular permissions
