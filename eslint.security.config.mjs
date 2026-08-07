// eslint.security.config.mjs — minimal SAST baseline (issue-25/M3): eslint-plugin-security's
// recommended rules are all warn-level, so warnings are scan findings and only errors block.
import security from 'eslint-plugin-security'

export default [security.configs.recommended]
