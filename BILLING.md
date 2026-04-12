# PMDeck Billing and Packaging Notes

## Personal Plans

### Free
- Price: $0/month
- Deck limit: 10
- AI requests: 2/day
- Project types available:
  - Standard
  - Weekly
  - Recurring
- Organization support: No

### Mid
- Price: configurable (currently modeled as $9/month in app constants)
- Deck limit: 25
- AI requests: 15/day
- Project types available: all
- Organization support: No

### Pro
- Price: $19/month
- Deck limit: 75
- AI requests: 40/day
- Project types available: all
- Organization support: Yes

## Business Plans

### Business 1-50
- Price: $19/month
- Seats: 1-50 users
- Deck limit: 300
- AI requests: 250/day
- Project types available: all
- Organization support: Yes

### Business 51-500
- Price: $49/month
- Seats: 51-500 users
- Deck limit: 2000
- AI requests: 1000/day
- Project types available: all
- Organization support: Yes

## Stripe Integration
- Cloud Function: createStripeCheckoutSession
- Secrets required:
  - STRIPE_SECRET_KEY
  - STRIPE_PRICE_MID
  - STRIPE_PRICE_PRO
  - STRIPE_PRICE_BUSINESS_SMALL
  - STRIPE_PRICE_BUSINESS_GROWTH
- Billing modal includes Personal and Business tabs and launches Stripe checkout.

## Feature Gating
- Deck creation blocked when plan deck limit is reached.
- AI usage tracked daily in /users/{uid}/usage/ai-YYYY-MM-DD.
- Free-tier project type list is intentionally limited.
- Organization creation requires a plan with canUseOrg = true (Pro or Business).

## Deck Experience Extensions
- Top bar includes:
  - Kanban view
  - List View
  - Calendar View (with a simple Gantt-style progress bar per dated task)
- AI Dashboard button opens an "AI-looking" panel with:
  - total tasks
  - completed tasks
  - overdue risks
  - prioritized recommendations list

## New Project Types Added
- Data Analyst
- Data Engineering

## Follow-Up Work
- Add Stripe webhook to auto-update users.billingPlan after successful checkout.
- Add seat-count validation for Business plans.
- Move AI and deck-limit enforcement fully server-side for anti-tamper guarantees.
