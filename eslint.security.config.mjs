// eslint.security.config.mjs — SAST baseline for the rules layer.
// eslint-plugin-security's recommended rules are warn-level, so warnings are scan
// findings and only errors block. The rules-layer check enforces positive framing:
// behavioral prose states the expected action; limiter words are reserved for
// structural enforcement layers (plugins, permissions, lint rules).
import security from 'eslint-plugin-security'

// ── prohibition-lexicon over the rules layer ──────────────────────────────────
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

// ── no-meta-marker: purge regression guard ───────────────────────────────────
// Scans comments in plugin sources and tests, plus describe/it/test first-arg
// labels, for process-workflow meta markers (AC###, R###, NFR###, P###, EC##,
// BUG-##, issue-##, Finding #, F#, FM#, G#, RSK-##, T##-##, and milestone
// prefixes in labels). Fixture data lives in string literals (dispatch prompts,
// fixture KD paths, registry rows) — functional test input — so only comments
// and label strings are scanned, never code.
const META_MARKERS = [
  /\bAC\d+\b/,
  /\bR\d{3}\b/,
  /\bNFR\d+\b/,
  /\bP\d{3}\b/,
  /\bEC-?\d+\b/,
  /\bBUG-\d+\b/,
  /\bissue-\d+\b/i,
  /\bFinding \d+\b/i,
  /\bF\d{2,3}\b/,
  /\bFM\d+\b/,
  /\bG\d\b/,
  /\bRSK-\d+\b/i,
  /\bT\d{2}-\d+\b/,
]
// Milestone-prefixed describe/it/test labels ("M1: ...", "M3 (F4): ...").
const LABEL_MILESTONE_PREFIX = /\bM[1-5]:/

// Functional naming contracts, not workflow meta markers: the knowledge-gate
// generates and parses issue-file IDs of the form "ISSUE-001" (3-digit), so
// the uppercase ID form is legitimate fixture/contract data everywhere.
const MARKER_ALLOWLIST = [/\bISSUE-\d{3}\b/]

const noMetaMarker = {
  meta: {
    type: 'problem',
    docs: { description: 'Reject process-workflow meta markers in comments and test labels' },
    messages: {
      marker: 'Meta marker "{{marker}}" in {{where}} — reference fixture data by value, not by workflow code.',
    },
  },
  create(context) {
    function firstMarker(text) {
      if (MARKER_ALLOWLIST.some((pattern) => pattern.test(text))) return null
      for (const pattern of META_MARKERS) {
        const match = pattern.exec(text)
        if (match) return match[0]
      }
      return null
    }
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const lines = comment.value.split('\n')
          lines.forEach((line, i) => {
            const hit = firstMarker(line)
            if (hit) {
              context.report({
                loc: { line: comment.loc.start.line + i, column: 0 },
                messageId: 'marker',
                data: { marker: hit, where: 'a comment' },
              })
            }
          })
        }
        context.sourceCode.lines.forEach((line, i) => {
          if (!/^\s*(describe|it|test)\s*\(\s*['"]/.test(line)) return
          const start = line.indexOf("'") >= 0 ? line.indexOf("'") : line.indexOf('"')
          const quote = line[start]
          const label = line.slice(start + 1, line.lastIndexOf(quote))
          const hit = firstMarker(label)
          const prefix = LABEL_MILESTONE_PREFIX.exec(label)
          if (hit) {
            context.report({
              loc: { line: i + 1, column: 0 },
              messageId: 'marker',
              data: { marker: hit, where: 'a test label' },
            })
          } else if (prefix) {
            context.report({
              loc: { line: i + 1, column: 0 },
              messageId: 'marker',
              data: { marker: prefix[0], where: 'a test label' },
            })
          }
        })
      },
    }
  },
}

const sourceMetaMarkerConfig = {
  files: ['plugins/**/*.js', 'tests/**/*.js'],
  plugins: { 'meta-marker': { rules: { 'no-meta-marker': noMetaMarker } } },
  rules: { 'meta-marker/no-meta-marker': 'error' },
}

export default [security.configs.recommended, rulesLayerConfig, sourceMetaMarkerConfig]
