/** Regression guards for the History Panel refinements requested in feedback.md. */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STYLES } from '../src/client/styles.ts'

test('History Panel shrink-wraps short timelines and constrains long timelines', () => {
  assert.match(STYLES, /\.dsh-history-modal-card \{[\s\S]*?height: auto;[\s\S]*?max-height: 85vh;/)
  assert.match(STYLES, /\.dsh-history-panel \{[\s\S]*?flex: 0 1 auto;[\s\S]*?height: auto;[\s\S]*?padding-top: 38px;/)
  assert.match(STYLES, /\.dsh-history-modal-body \{[\s\S]*?flex: 0 1 auto;[\s\S]*?overflow-y: auto;/)
})

test('Context Curation uses the right-aligned default dock without retired eye/orange UI', () => {
  assert.match(STYLES, /\.dsh-history-action-dock\.is-curation \{[\s\S]*?justify-content: flex-end;/)
  assert.doesNotMatch(STYLES, /dsh-history-visibility-(?:rail|toggle)/)
  assert.doesNotMatch(STYLES, /dsh-history-button\.curation/)
  assert.doesNotMatch(STYLES, /dsh-history-experimental-warning/)
})

test('panel close control remains positioned relative to the dynamic panel', () => {
  assert.match(STYLES, /\.dsh-history-selection-close \{[\s\S]*?position: absolute;[\s\S]*?top: 4px;[\s\S]*?right: 10px;/)
})
