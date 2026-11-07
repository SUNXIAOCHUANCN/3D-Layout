import test from 'node:test'
import assert from 'node:assert/strict'
import { stripTypeScriptTypes } from 'node:module'
import { modelClientSource } from '../model-source.mjs'

for (const module of ['agent', 'llm-agent']) {
  const source = modelClientSource(module)
  const { llmChat } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'))
  const options = onEvent => ({ settings: { model: 'test', protocol: 'openai-chat', baseURL: 'http://mock.invalid', apiKey: 'test' },
    system: 'edit', turns: [{ role: 'user', text: 'move chair' }], tools: [], signal: new AbortController().signal, onEvent })
  test(`${module}: stream activity identifies reasoning and tool output without exposing reasoning text`, async () => {
    const original = globalThis.fetch, events = []
    globalThis.fetch = async () => new Response([
      { choices: [{ delta: { reasoning_content: 'private-reasoning' } }] },
      { choices: [{ delta: { content: '开始调整' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'asset_adjust_transform', arguments: '{}' } }] } }] },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
    try {
      const result = await llmChat(options(event => events.push(event)))
      assert.deepEqual(events.filter(event => event.type === 'activity').map(event => event.stage), ['connected', 'reasoning', 'tool'])
      assert.equal(result.text, '开始调整')
      assert.equal(result.toolCalls.length, 1)
      assert.ok(!JSON.stringify([events, result]).includes('private-reasoning'))
    } finally { globalThis.fetch = original }
  })
  test(`${module}: an SSE error is reported rather than treated as empty success`, async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () => new Response('data: {"error":{"message":"service unavailable"}}\n\n')
    try { await assert.rejects(llmChat(options(() => {})), error => error.code === 'MODEL_SERVICE_ERROR' && error.message.includes('service unavailable')) }
    finally { globalThis.fetch = original }
  })
}
