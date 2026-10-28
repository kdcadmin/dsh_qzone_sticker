import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply, inject, name } from '../index.js'
import {
  buildPublishBody,
  gtk,
  parseQzoneBody,
  redact,
  sessionFromCookies,
  summarizePosts,
  takePublishSlot,
  visibilityRight,
} from '../lib/session.js'
import { pluginOptions } from '../lib/qzone.js'

test('gtk stays in 31 bits and is stable', () => {
  assert.equal(gtk('abc'), gtk('abc'))
  assert.match(gtk('abc'), /^\d+$/)
  assert.ok(Number(gtk('abc')) > 0)
  assert.ok(Number(gtk('abc')) <= 0x7fffffff)
})

test('session accepts only the configured QQ and hides the cookie', () => {
  const session = sessionFromCookies([
    { name: 'p_uin', value: 'o2776757452', domain: '.qq.com' },
    { name: 'p_skey', value: 'secret-key', domain: '.qzone.qq.com' },
  ], '2776757452')
  assert.equal(session.ok, true)
  assert.equal(session.uin, '2776757452')
  assert.equal(session.message.includes('secret-key'), false)
  assert.equal(session.gtk, gtk('secret-key'))

  const other = sessionFromCookies([
    { name: 'uin', value: 'o10000', domain: '.qq.com' },
    { name: 'p_skey', value: 'secret-key', domain: '.qzone.qq.com' },
  ], '2776757452')
  assert.equal(other.ok, false)
  assert.equal(other.cookieHeader, undefined)
})

test('qzone body parser accepts jsonp and rejects the login page', () => {
  assert.deepEqual(parseQzoneBody('_Callback({"code":0,"tid":"abc"})'), { code: 0, tid: 'abc' })
  assert.throws(() => parseQzoneBody('<html>login</html>'), /登录/)
})

test('publish body stays on the configured space and does not sync weibo', () => {
  const body = new URLSearchParams(buildPublishBody({
    uin: '2776757452',
    content: '你好',
    visibility: 'friends',
  }))
  assert.equal(body.get('hostuin'), '2776757452')
  assert.equal(body.get('con'), '你好')
  assert.equal(body.get('ugc_right'), '4')
  assert.equal(body.get('issyncweibo'), '0')
  assert.equal(visibilityRight('private'), '64')
})

test('recent posts keep a short summary', () => {
  const posts = summarizePosts({
    msglist: [{ tid: '1', content: '<b>你好</b>', created_time: 1761628800 }],
  }, 5)
  assert.equal(posts[0].content, '你好')
  assert.equal(posts[0].tid, '1')
  assert.match(posts[0].createdAt, /^2025-10-28 /)
})

test('daily publish slot blocks the immediate second post', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qzone-'))
  const file = path.join(dir, 'log.json')
  try {
    const first = await takePublishSlot(file, { dailyLimit: 2, minIntervalMs: 60_000, now: 1_000_000 })
    const second = await takePublishSlot(file, { dailyLimit: 2, minIntervalMs: 60_000, now: 1_001_000 })
    assert.equal(first.ok, true)
    assert.equal(second.ok, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('redact removes session material', () => {
  const text = redact('fail p_skey=abc; skey=def; uin=o2776757452')
  assert.equal(text.includes('abc'), false)
  assert.equal(text.includes('def'), false)
  assert.equal(text.includes('2776757452'), false)
})

test('plugin registers three tools for the configured QQ', () => {
  assert.equal(name, 'qzone')
  assert.deepEqual(inject, ['tools', 'systemPrompt'])
  const registered = []
  let prompt = ''
  apply({
    tools: {
      register(tool) {
        registered.push(tool)
        return () => {}
      },
    },
    systemPrompt: {
      section(section) {
        prompt = section.text
        return () => {}
      },
    },
  }, { uin: '2776757452' })
  assert.deepEqual(registered.map((tool) => tool.name), ['qzone_status', 'qzone_recent', 'qzone_publish'])
  assert.match(prompt, /2776757452/)
  assert.equal(pluginOptions({}).uin, '2776757452')
})
