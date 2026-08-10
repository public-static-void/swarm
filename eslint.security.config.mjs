// eslint.security.config.mjs — SAST baseline (issue-25/M3 + M6 prohibition-lexicon).
// eslint-plugin-security's recommended rules are warn-level, so warnings are scan
// findings and only errors block. The M6 rule-layer check enforces positive framing:
// behavioral prose states the expected action; limiter words are reserved for
// structural enforcement layers (plugins, permissions, lint rules).
import security from 'eslint-plugin-security'

// ── M6: prohibition-lexicon over the rules layer ──────────────────────────────
// Scans AGENTS.md, agents/, commands/, and skills instruction sections for limiter
// words that contradict "Point the Target". Limiters in structural layers
// (permission-deny rules, plugin guard text) stay outside this scan's scope.
const LEXICON = [
  /\bdo not\b/i,
  /\bdon't\b/i,
  /\bavoid\b/i,
  /\bnever\b/i,
  /\balways\b/i,
  /\bmust not\b/i,
  /\bmustn't\b/i,
  /\bnot permitted\b/i,
  /\bnot allowed\b/i,
]
// "only" as a standalone word — compound suffixes (SWARM-only, HTTPS-only,
// --ff-only) are workflow-meta tokens, not limiter usage.
const ONLY = /(?<![\w-])only\b/i

// Workflow-meta boilerplate lines that legitimately describe generation scoping.
const LINE_ALLOWLIST = [/^\s*<!-- GENERATION: .*-->$/]

function findFirstLimiter(line) {
  let best = null
  for (const pattern of [...LEXICON, ONLY]) {
    const match = pattern.exec(line)
    if (match && (!best || match.index < best.index)) {
      best = { word: match[0].trim(), index: match.index }
    }
  }
  return best
}

const prohibitionLexicon = {
  meta: {
    type: 'problem',
    docs: { description: 'Reject limiter words in behavioral rules prose' },
    messages: {
      limiter:
        'Limiter word "{{word}}" in behavioral prose — state the expected action instead (limiters belong to structural enforcement layers).',
    },
  },
  create(context) {
    const lines = context.sourceCode.lines
    return {
      Program() {
        // Skip leading YAML frontmatter (--- ... ---).
        let start = 0
        if (lines.length > 0 && lines[0].trim() === '---') {
          for (let i = 1; i < lines.length; i++) {
            if (lines[i].trim() === '---') {
              start = i + 1
              break
            }
          }
        }
        for (let lineIndex = start; lineIndex < lines.length; lineIndex++) {
          const line = lines[lineIndex]
          if (LINE_ALLOWLIST.some((pattern) => pattern.test(line))) continue
          const hit = findFirstLimiter(line)
          if (hit) {
            context.report({
              loc: { line: lineIndex + 1, column: hit.index },
              messageId: 'limiter',
              data: { word: hit.word },
            })
          }
        }
      },
    }
  },
}

// Minimal text parser: ESLint needs a parse result; the rule reads source lines
// directly, so an empty Program with source-tracking metadata suffices.
const textParser = {
  parseForESLint(text) {
    const lines = text.split('\n')
    return {
      ast: {
        type: 'Program',
        loc: { start: { line: 1, column: 0 }, end: { line: lines.length, column: lines[lines.length - 1].length } },
        range: [0, text.length],
        body: [],
        comments: [],
        tokens: [],
      },
      services: { isPlainText: true },
      scopeManager: null,
      visitorKeys: { Program: [] },
    }
  },
}

const rulesLayerConfig = {
  files: ['AGENTS.md', 'agents/**/*.md', 'commands/**/*.md', 'skills/**/*.md'],
  languageOptions: { parser: textParser },
  plugins: { 'rules-layer': { rules: { 'prohibition-lexicon': prohibitionLexicon } } },
  rules: { 'rules-layer/prohibition-lexicon': 'error' },
}

export default [security.configs.recommended, rulesLayerConfig]
