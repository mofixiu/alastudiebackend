import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getGeminiConfig } from '../src/ai_config.ts';

const confirmed = {
  GEMINI_API_KEY: 'local-test-key',
  GEMINI_CREDITS_CONFIRMED: 'true',
  GEMINI_SPEND_CAP_CONFIGURED: 'true',
  GEMINI_BUDGET_USD: '40',
  GEMINI_BUDGET_RESERVE_USD: '2',
  GEMINI_INPUT_USD_PER_MILLION: '0.1',
  GEMINI_OUTPUT_USD_PER_MILLION: '0.4',
  GEMINI_EMBEDDING_USD_PER_MILLION: '0.02',
};

test('Gemini remains disabled without a key, confirmed credit, or spend cap', () => {
  assert.equal(getGeminiConfig({ ...confirmed, GEMINI_API_KEY: '' }), null);
  assert.equal(getGeminiConfig({ ...confirmed, GEMINI_CREDITS_CONFIRMED: 'false' }), null);
  assert.equal(getGeminiConfig({ ...confirmed, GEMINI_SPEND_CAP_CONFIGURED: 'false' }), null);
});

test('Gemini fails closed when any cost rate or usable budget is missing', () => {
  assert.equal(getGeminiConfig({ ...confirmed, GEMINI_OUTPUT_USD_PER_MILLION: '' }), null);
  assert.equal(getGeminiConfig({ ...confirmed, GEMINI_BUDGET_RESERVE_USD: '40' }), null);
  assert.equal(getGeminiConfig({ ...confirmed, GEMINI_BUDGET_USD: 'not-a-number' }), null);
});

test('Gemini config becomes available only with all explicit safeguards', () => {
  const config = getGeminiConfig(confirmed);
  assert.ok(config);
  assert.equal(config.budget, 40);
  assert.equal(config.reserve, 2);
  assert.equal(config.model, 'gemini-2.5-flash');
});
