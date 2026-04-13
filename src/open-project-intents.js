/**
 * Open Project intent catalog for AI Dealer.
 *
 * This file centralizes common project-management questions so behavior is
 * transparent and easy to tune without digging through ai-chat logic.
 */

import config from './open-project-config.json' with { type: 'json' };

const DEFAULT_STANDARD_QUESTIONS = [
  {
    id: 'risk_assessment',
    label: 'Project Risk Assessment',
    examples: [
      'What are the risks in this project?',
      'Give me a project risk assessment.',
      'What are the top project risks right now?',
    ],
    responseStyle: 'Risk level + risk categories + top tasks + next actions',
  },
  {
    id: 'priority_ranking',
    label: 'Priority And Urgency Ranking',
    examples: [
      'Rank tasks by urgency and risk.',
      'What should we do first?',
      'Prioritize the due-soon tasks.',
    ],
    responseStyle: 'Ordered list with rationale per task',
  },
  {
    id: 'assignee_assignment',
    label: 'Assignee And Ownership',
    examples: [
      'Who is assigned to these tasks?',
      'Show tasks by assignee.',
      'Who owns the due-soon tasks?',
    ],
    responseStyle: 'Per-task owner view + assignee workload snapshot',
  },
  {
    id: 'longest_effort',
    label: 'Longest / Highest Effort Task',
    examples: [
      'What task will take the most time?',
      'Which task is the hardest?',
      'What is the highest-effort task?',
    ],
    responseStyle: 'Estimated top effort task + effort signals + top candidates',
  },
  {
    id: 'project_summary',
    label: 'Project Summary',
    examples: [
      'Give me a project summary.',
      'What is the current project status?',
      'Summarize this project.',
    ],
    responseStyle: 'Snapshot metrics + near-term focus + recommended actions',
  },
  {
    id: 'blockers',
    label: 'Blockers And Mitigation',
    examples: [
      'What is blocked?',
      'How do we unblock this project?',
      'Give me mitigation steps.',
    ],
    responseStyle: 'Blocked list + mitigation checklist',
  },
  {
    id: 'sprint_window',
    label: 'Sprint / 14-Day Plan',
    examples: [
      'What should we do in the next 14 days?',
      'Give me a two-week plan.',
      'Sprint planning view please.',
    ],
    responseStyle: '14-day due work + undated planning reminders',
  },
  {
    id: 'overdue_recovery',
    label: 'Overdue Recovery',
    examples: [
      'How do we recover overdue tasks?',
      'Recovery plan for overdue items.',
      'Help clear overdue tasks.',
    ],
    responseStyle: 'Recovery sequence + concrete next steps',
  },
  {
    id: 'recommendation_explain',
    label: 'Explain Recommendation',
    examples: [
      'Explain this recommendation.',
      'Why did you suggest this?',
      'Give more detail on that recommendation.',
    ],
    responseStyle: 'Reasoning + practical action plan',
  },
  {
    id: 'milestone_plan',
    label: 'Milestone Or Task Plan',
    examples: [
      'Help me plan this milestone.',
      'Plan this task for me.',
      'Create a milestone execution plan.',
    ],
    responseStyle: 'Risk checks + 3-step execution plan for named task',
  },
];

const DEFAULT_INTENT_RULES = [
  { intent: 'risk_assessment', keywords: ['what are the risks', 'project risk', 'risk assessment', 'risks in this project'] },
  { intent: 'assignee_assignment', keywords: ['who is assigned', 'who owns', 'assigned to', 'assignee', 'owner', 'owners', 'workload by user', 'tasks by assignee'] },
  { intent: 'longest_effort', keywords: ['what task will take the most time', 'take the most time', 'most time', 'longest task', 'most effort', 'hardest task'] },
  { intent: 'project_summary', keywords: ['project summary', 'summarize', 'summary', 'status overview', 'health summary', 'project status'] },
  { intent: 'milestone_plan', keywords: ['help me plan this milestone', 'plan this milestone', 'plan this task', 'milestone'] },
  { intent: 'recommendation_explain', keywords: ['explain this recommendation', 'explain this', 'why did you suggest'] },
  { intent: 'overdue_recovery', keywords: ['overdue', 'recover', 'recovery'] },
  { intent: 'priority_ranking', keywords: ['prioritize', 'priority', 'rank', 'urgency', 'due date'] },
  { intent: 'blockers', keywords: ['block', 'blocked', 'mitigation', 'unblock', 'dependency'] },
  { intent: 'sprint_window', keywords: ['sprint', '14 day', '14-day', 'two week'] },
];

const DEFAULT_FIELD_KEYWORDS = {
  schedule: ['due', 'deadline', 'timeline', 'date', 'when', 'delivery', 'timeframe', 'window'],
  blockers: ['blocked', 'blocker', 'unblock', 'dependency', 'hold', 'waiting', 'risk'],
  assignees: ['assignee', 'assigned', 'owner', 'who owns', 'who is assigned', 'workload'],
  effort: ['effort', 'hard', 'hardest', 'complex', 'complexity', 'most time', 'longest', 'estimate'],
  progress: ['progress', 'complete', 'completion', 'status', 'health', 'summary', 'overview'],
  scope: ['scope', 'subtask', 'subtasks', 'breakdown', 'size', 'deliverable'],
};

const _safeQuestions = Array.isArray(config?.standardQuestions) && config.standardQuestions.length
  ? config.standardQuestions
  : DEFAULT_STANDARD_QUESTIONS;
const _safeIntentRules = Array.isArray(config?.intentRules) && config.intentRules.length
  ? config.intentRules
  : DEFAULT_INTENT_RULES;
const _safeFieldKeywords = config?.fieldKeywords && typeof config.fieldKeywords === 'object'
  ? config.fieldKeywords
  : DEFAULT_FIELD_KEYWORDS;

export const OPEN_PROJECT_STANDARD_QUESTIONS = _safeQuestions;

export function detectOpenProjectIntent(normalizedQuestion) {
  const q = String(normalizedQuestion || '').trim();
  if (!q) return 'project_summary';

  const ranked = _scoreIntentRules(q);
  if (ranked.length && ranked[0].score > 0) return ranked[0].intent;

  return 'project_summary';
}

function _scoreIntentRules(normalizedQuestion) {
  const q = String(normalizedQuestion || '').trim();
  if (!q) return [];

  const scored = [];
  for (const rule of _safeIntentRules) {
    const intent = String(rule?.intent || '').trim();
    const keywords = Array.isArray(rule?.keywords) ? rule.keywords : [];
    if (!intent || !keywords.length) continue;

    let score = 0;
    const matches = [];
    for (const keywordDef of keywords) {
      if (typeof keywordDef === 'string') {
        const needle = keywordDef.trim().toLowerCase();
        if (needle && q.includes(needle)) {
          score += 1;
          matches.push({ phrase: needle, weight: 1 });
        }
        continue;
      }

      const phrase = String(keywordDef?.phrase || '').trim().toLowerCase();
      const weight = Number(keywordDef?.weight || 1);
      if (phrase && q.includes(phrase)) {
        score += Number.isFinite(weight) ? weight : 1;
        matches.push({ phrase, weight: Number.isFinite(weight) ? weight : 1 });
      }
    }

    const minScore = Number(rule?.minScore || 1);
    if (score < (Number.isFinite(minScore) ? minScore : 1)) continue;

    const priority = Number(rule?.priority || 0);
    scored.push({
      intent,
      score,
      priority: Number.isFinite(priority) ? priority : 0,
      matches,
    });
  }

  return scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.priority - a.priority;
  });
}

export function getOpenProjectQuestionSuggestions(max = 3) {
  const all = OPEN_PROJECT_STANDARD_QUESTIONS.flatMap((i) => i.examples.slice(0, 1));
  return all.slice(0, Math.max(1, Number(max) || 3));
}

export function detectRequestedAnalysisFields(normalizedQuestion) {
  const q = String(normalizedQuestion || '').trim();
  if (!q) return [];

  const fields = Object.entries(_safeFieldKeywords)
    .filter(([, keywords]) => Array.isArray(keywords) && keywords.some((keyword) => {
      const needle = String(keyword || '').trim().toLowerCase();
      return needle && q.includes(needle);
    }))
    .map(([field]) => field);

  return fields;
}

export function debugOpenProjectDetection(question) {
  const normalized = String(question || '').toLowerCase().trim();
  const fields = detectRequestedAnalysisFields(normalized);
  const ranked = _scoreIntentRules(normalized);
  return {
    question,
    normalized,
    intent: ranked[0]?.intent || 'project_summary',
    requestedFields: fields,
    ranked,
  };
}
