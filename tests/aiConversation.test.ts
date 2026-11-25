import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ClientAiError,
  resetAiDebounceForTests,
  resolveFirstAidQuery,
} from '../lib/aiClient.ts';
import {
  buildConversationPrompt,
  buildConversationSystemInstruction,
} from '../server/aiProvider.ts';
import type {StructuredFirstAidAiResponse} from '../src/types/emergency.ts';

const queryCases = [
  ['Mere pet mein dard ho raha hai', 'hi'],
  ['My head has been aching since morning', 'en'],
  ['Mujhe bukhar aur thand lag rahi hai', 'hi'],
  ['I have been vomiting since lunch', 'en'],
  ['Garam chai se haath jal gaya', 'hi'],
  ['I cut my finger while cooking', 'en'],
  ['Saans lene mein bahut dikkat ho rahi hai', 'hi'],
  ['There is pressure in my chest and I feel faint', 'en'],
  ['Kutte ne halka sa kaat liya', 'hi'],
  ['A snake bit my ankle in the garden', 'en'],
  ['Bacche ne galti se cleaning liquid pi liya', 'hi'],
  ['A car hit my scooter and someone is injured', 'en'],
  ['Ghar ke paas paani bhar raha hai, kya karun?', 'hi'],
  ['There is smoke coming from the kitchen', 'en'],
  ['Mujhe bahut ghabrahat ho rahi hai', 'hi'],
  ['I feel overwhelmed and need someone to talk to', 'en'],
  ['How do I safely turn off the gas?', 'en'],
  ['Bijli chali gayi hai aur raat ho gayi, safe kaise rahun?', 'hi'],
  ['What is the emergency number in India?', 'en'],
  ['Kal ke liye first-aid kit mein kya rakhun?', 'hi'],
  ['My child has a rash after eating peanuts', 'en'],
  ['Mere dost ko chakkar aa rahe hain', 'hi'],
  ['How can I help someone during a seizure?', 'en'],
  ['Road par ek aadmi behosh pada hai', 'hi'],
  ['There is a strong earthquake happening now', 'en'],
  ['Cyclone warning aayi hai, ghar mein kya prepare karun?', 'hi'],
  ['My nose is bleeding after I bumped it', 'en'],
  ['Mere pair mein moch aa gayi hai', 'hi'],
  ['I accidentally touched a live wire', 'en'],
  ['Can you explain how to wash hands properly?', 'en'],
] as const;

function makeAiResponse(
  acknowledgment: string
): StructuredFirstAidAiResponse {
  return {
    urgency: 'general',
    adviseCall112: false,
    acknowledgment,
    immediateSteps: [],
    doNot: [],
    whenToSeekHelp: '',
    followUpQuestion: '',
    requiresBreathingSafetyCheck: false,
    matchedProtocolId: null,
    confidenceLevel: 'low',
    imageObservationNote: '',
    sources: [],
    provider: 'gemini',
    model: 'test-model',
    disclaimer: 'General safety information.',
  };
}

test('all 30 varied queries go to AI and return its query-specific response without guide suggestions', async () => {
  const originalFetch = globalThis.fetch;
  const sentMessages: string[] = [];

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {message: string};
    sentMessages.push(body.message);
    return new Response(
      JSON.stringify(makeAiResponse(`AI response: ${body.message}`)),
      {status: 200, headers: {'Content-Type': 'application/json'}}
    );
  }) as typeof fetch;

  try {
    for (const [message, language] of queryCases) {
      resetAiDebounceForTests();
      const result = await resolveFirstAidQuery({
        message,
        language,
        history: [],
      });

      assert.equal(result.source, 'gemini', message);
      assert.equal(result.response.acknowledgment, `AI response: ${message}`);
      assert.equal(result.response.matchedProtocolId, null);
      assert.deepEqual(result.response.sources, []);
    }

    assert.deepEqual(
      sentMessages,
      queryCases.map(([message]) => message)
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('follow-up requests preserve recent conversation context and are sent to AI', async () => {
  const originalFetch = globalThis.fetch;
  const receivedBodies: Array<Record<string, unknown>> = [];

  globalThis.fetch = (async (_input, init) => {
    receivedBodies.push(
      JSON.parse(String(init?.body)) as Record<string, unknown>
    );
    return new Response(
      JSON.stringify(makeAiResponse('AI used the abdominal-pain follow-up context')),
      {status: 200, headers: {'Content-Type': 'application/json'}}
    );
  }) as typeof fetch;

  try {
    resetAiDebounceForTests();

    const result = await resolveFirstAidQuery({
      message: 'Aur dard kahan hai?',
      language: 'hi',
      history: [
        {role: 'user', text: 'Mere pet mein dard ho raha hai'},
        {
          role: 'assistant',
          text: 'Pet ke kis hisse mein dard hai aur kab se?',
        },
      ],
    });

    assert.deepEqual(receivedBodies[0]?.history, [
      {role: 'user', text: 'Mere pet mein dard ho raha hai'},
      {
        role: 'assistant',
        text: 'Pet ke kis hisse mein dard hai aur kab se?',
      },
    ]);
    assert.equal(
      result.response.acknowledgment,
      'AI used the abdominal-pain follow-up context'
    );
    assert.equal(result.source, 'gemini');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI service errors are surfaced and do not produce a cached or classified guide', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: 'Live AI assistance is temporarily unavailable.',
        code: 'provider_error',
      }),
      {status: 503, headers: {'Content-Type': 'application/json'}}
    )) as typeof fetch;

  try {
    resetAiDebounceForTests();
    await assert.rejects(
      resolveFirstAidQuery({
        message: 'My stomach hurts',
        language: 'en',
        history: [],
      }),
      (error: unknown) =>
        error instanceof ClientAiError &&
        error.message.includes('Live AI assistance is temporarily unavailable')
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('backend prompt receives each query and instructs contextual multilingual safety responses', () => {
  for (const [message] of queryCases) {
    const prompt = buildConversationPrompt(message, [], ['unknown']);
    assert.ok(prompt.includes(`Latest user message: ${message}`));
  }

  const prompt = buildConversationPrompt(
    'Left side, since last night',
    [
      {role: 'user', text: 'Mere pet mein dard ho raha hai'},
      {role: 'assistant', text: 'Pet ke kis hisse mein dard hai aur kab se?'},
    ],
    ['unknown']
  );
  assert.ok(prompt.includes('User: Mere pet mein dard ho raha hai'));
  assert.ok(prompt.includes('Assistant: Pet ke kis hisse mein dard hai aur kab se?'));
  assert.ok(prompt.includes('Latest user message: Left side, since last night'));

  const instructions = buildConversationSystemInstruction('hi');
  assert.match(instructions, /Hindi, Hinglish, English, and regional languages/);
  assert.match(instructions, /India emergency number 112/);
  assert.match(instructions, /do not diagnose with certainty or prescribe medicines/);
  assert.match(instructions, /ask one focused clarification question/);
  assert.match(instructions, /Never select a guide merely because/);
});
