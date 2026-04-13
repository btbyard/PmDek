# AI Dealer Open Project Playbook

This file documents common project-management questions and how PMDeck AI Dealer answers them.

## How It Works Today

- Open Project mode is currently rule-based and data-driven from the live board snapshot.
- It does not call Gemini for Open Project answers right now.
- Gemini is used in creation flows (create deck, create tasks) where generation quality matters most.

Code locations:
- Intent catalog: src/open-project-intents.js
- User-editable config: src/open-project-config.json
- Open Project answer engine: src/ai-chat.js (function _doDashboardMode)

## Tune Without Code Changes

Edit src/open-project-config.json to tune behavior:

- standardQuestions: visible examples and response style notes
- intentRules: maps keyword phrases to intent IDs (order matters)
- fieldKeywords: maps analysis fields (schedule, blockers, assignees, etc.) to keywords

Tips:
- Keep phrases lowercase for consistency.
- Put the most specific intent rules first.
- If two intents can match the same phrase, the first one wins.

## Standard Questions

1. Project Risk Assessment
- Example: "What are the risks in this project?"
- Response shape: risk level, schedule/execution/planning/capacity risks, top tasks to watch, next actions.

2. Priority Ranking
- Example: "Rank tasks by urgency and risk."
- Response shape: ordered tasks with rationale per item.

3. Longest / Highest Effort Task
- Example: "What task will take the most time?"
- Response shape: top estimated effort task and top candidates.
- Current effort signals: open subtasks, total subtasks, description scope length.

4. Project Summary
- Example: "Give me a project summary."
- Response shape: totals, completion rate, due-soon, blocked, near-term focus, suggested actions.

5. Blockers / Mitigation
- Example: "How do we unblock this project?"
- Response shape: blocked list + mitigation checklist.

6. Sprint / 14-Day Plan
- Example: "Give me a two-week plan."
- Response shape: due in 14 days + undated work that should be scheduled.

7. Overdue Recovery
- Example: "How do we recover overdue tasks?"
- Response shape: recovery path with concrete next steps.

8. Explain Recommendation
- Example: "Explain this recommendation."
- Response shape: why it matters + practical steps.

9. Milestone / Task Plan
- Example: "Help me plan this milestone."
- Response shape: risk checks + 3-step plan for a named task.

## Why This Is Project-Specific

AI Dealer tailors responses using live project signals:
- task due dates (overdue and due soon)
- blocked/risk states inferred from columns
- completion state and completion rate
- undated tasks and planning gaps
- subtask structure for effort hints
- assignee concentration for capacity risk

## Optional Next Step (Gemini-Assisted Open Project)

If you want Open Project to use Gemini, keep this intent catalog and add a Gemini synthesis layer that receives:
- detected intent
- compact project context snapshot
- fixed output template per intent

That preserves structure while improving narrative quality.
