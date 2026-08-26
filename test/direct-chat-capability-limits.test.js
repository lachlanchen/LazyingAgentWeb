import assert from 'node:assert/strict';
import test from 'node:test';

import {
  directChatCapabilityCategories,
  directChatCapabilityNotice
} from '../src/direct-chat-capability-limits.js';

test('classifies unsupported Direct Chat actions while preserving supported mixed work', () => {
  const cases = [
    ['Run Python to calculate 2+2, but do not plot.', ['execution']],
    ['Explain a median, then run Python to calculate it.', ['execution']],
    ['Create a PDF report and explain the main result.', ['file']],
    ['Generate an image and write its caption.', ['file']],
    ['Search the web, then summarize the subject.', ['web']],
    ['Open https://example.com and summarize it.', ['web']],
    ['Deploy this answer and explain the deployment steps.', ['external']],
    ['Run Python, then export report.pdf, then browse the web, then publish it.', ['execution', 'file', 'web', 'external']]
  ];
  for (const [prompt, expected] of cases) {
    assert.deepEqual(directChatCapabilityCategories(prompt), expected, prompt);
    assert.match(directChatCapabilityNotice(prompt), /still complete every supported text/u, prompt);
  }
});

test('does not invent capability limits for explanations, negations, or chat delivery wording', () => {
  for (const prompt of [
    'Explain how to run Python without doing it.',
    'Explain why the phrase “publish this” is unsafe.',
    'Do not create a PDF; explain LaTeX.',
    'Use the word shell in a sentence.',
    'Find internet references in the supplied text.',
    'Send the summary to me.',
    'Describe the two supplied images.',
    'Write Python code for a median.',
    'Write a detailed report as Markdown text.'
  ]) {
    assert.deepEqual(directChatCapabilityCategories(prompt), [], prompt);
    assert.equal(directChatCapabilityNotice(prompt), '', prompt);
  }
});
