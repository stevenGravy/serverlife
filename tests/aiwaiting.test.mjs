import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeQuestion } from '../src/renderer/js/aiwaiting.js';

test('questions the assistants ask are recognised', () => {
  for (const t of [
    'Bash command\n  rm -rf build\nDo you want to proceed?\n❯ 1. Yes\n  2. No',
    'Quick safety check: Is this a project you trust?\n❯ 1. Yes, I trust this folder\n  2. No, exit\nEnter to confirm · Esc to cancel',
    'Allow command `kubectl get pods`?',
    'Overwrite file? (y/n)',
    'Would you like to run the following command?',
    '› 1. Yes, proceed\n  2. No, and tell Codex what to do differently',
    "  2. Yes, and don't ask again for this command",
  ]) assert.ok(looksLikeQuestion(t), t);
});

test('working, output and an idle prompt are not questions', () => {
  for (const t of [
    '',
    '✻ Thinking… (12s · esc to interrupt)',
    '> \n  ? for shortcuts',
    'total 48\ndrwxr-xr-x  5 me  staff  160 Oct  9 12:00 .',
    'The tests pass. 1. First, I updated the config. 2. Then I ran it.',
  ]) assert.equal(looksLikeQuestion(t), false, t);
});
