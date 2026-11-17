/**
 * dsh-foreground-guard 离线冒烟测试：用假 ctx / 假审批服务驱动 pre-execute 门控，不依赖宿主。
 * 运行：node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { apply, extractWaitSeconds } from '../lib/index.js'

const agentA = { id: 'agent-a' }
const agentB = { id: 'agent-b' }

function makeCtx(options = {}) {
  const listeners = []
  const sections = []
  const requests = []
  const ctx = {
    effect(fn) { return fn() },
    on(event, handler) { listeners.push({ event, handler }) },
    get(name) {
      if (name === 'sessions') {
        return options.session === undefined ? undefined : { get: () => options.session }
      }
      if (name === 'userQuestions') {
        if (options.questions === undefined) return undefined
        return {
          ask: async (request) => {
            requests.push({ via: 'questions', ...request })
            return options.questions(request, requests.length)
          },
        }
      }
      if (name !== 'approval' || options.approval === undefined) return undefined
      return {
        request: async (request) => {
          requests.push({ via: 'approval', ...request })
          return options.approval(request, requests.length)
        },
        overrideOf: () => options.policy,
      }
    },
    systemPrompt: { section(section) { sections.push(section); return () => {} } },
    tools: { schemas: options.schemas ?? (() => []) },
  }
  return { ctx, listeners, sections, requests }
}

function boot(config, options) {
  const harness = makeCtx(options)
  apply(harness.ctx, config)
  const entry = harness.listeners.find(item => item.event === 'tools/pre-execute')
  assert.ok(entry, '应注册 tools/pre-execute 监听')
  const run = exec => entry.handler(exec, async () => ({ kind: 'allow' }))
  return { ...harness, run }
}

function call(name, args, agent = agentA) {
  return { name, arguments: args, agent, callId: `call-${Math.random()}` }
}

function resetTurn(harness, agent) {
  const entry = harness.listeners.find(item => item.event === 'agent/pre-step')
  assert.ok(entry, '应注册 agent/pre-step 监听')
  entry.handler({ agent, messages: [{ role: 'user', source: { kind: 'user' } }] }, () => 'next')
}

const allow = value => value !== undefined && value.kind === 'allow'
const reason = value => value !== undefined && value.kind === 'deny' ? value.reason : undefined

let failed = 0
async function check(label, fn) {
  try {
    await fn()
    console.log(`PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${label}\n      ${error.message}`)
  }
}

/* ── 1. 解析器 ─────────────────────────────────────────────── */

await check('解析 Start-Sleep -Seconds 45', () => {
  assert.deepEqual(extractWaitSeconds('Start-Sleep -Seconds 45'), [45])
})
await check('解析 -s / -m / -ms 简写', () => {
  assert.deepEqual(extractWaitSeconds('Start-Sleep -s 30; Start-Sleep -m 250'), [30, 0.25])
  assert.deepEqual(extractWaitSeconds('Start-Sleep -Milliseconds 500'), [0.5])
})
await check('解析位置参数与 bash 单位', () => {
  assert.deepEqual(extractWaitSeconds('Start-Sleep 12'), [12])
  assert.deepEqual(extractWaitSeconds('sleep 2m'), [120])
  assert.deepEqual(extractWaitSeconds('sleep 1h'), [3600])
})
await check('解析 timeout /t 与 python time.sleep', () => {
  assert.deepEqual(extractWaitSeconds('timeout /t 90'), [90])
  assert.deepEqual(extractWaitSeconds('python -c "import time; time.sleep(300)"'), [300])
})
await check('不含 sleep 的命令返回空', () => {
  assert.deepEqual(extractWaitSeconds('Get-ChildItem'), [])
  assert.deepEqual(extractWaitSeconds(''), [])
})

/* ── 2. 默认（不弹授权）直接拒绝 ───────────────────────────── */

await check('100s 单次 sleep 被拒', async () => {
  const h = boot()
  const decision = await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 100', description: 'x' }))
  assert.match(reason(decision), /超过单次上限 60s/)
  assert.equal(h.requests.length, 0, '没有审批通道时不应请求授权')
})

await check('dsh-ops 的 ops_bash 同样受门控', async () => {
  const h = boot()
  const decision = await h.run(call('ops_bash', { command: 'sleep 100', description: 'x' }))
  assert.match(reason(decision), /超过单次上限 60s/)
})

await check('动态探测：注册表里的 ops_pwsh 即使不在静态列表也被纳入', async () => {
  const h = boot({}, { schemas: () => [{ name: 'ops_pwsh' }] })
  const decision = await h.run(call('ops_pwsh', { command: 'Start-Sleep -Seconds 100', description: 'x' }))
  assert.match(reason(decision), /超过单次上限 60s/)
})

await check('40s 单次 sleep 放行', async () => {
  const h = boot()
  assert.ok(allow(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 40', description: 'x' }))))
})

await check('回合预算：25s + 40s 的拒绝文案与要求一致', async () => {
  const h = boot({ promptOnViolation: false })
  assert.ok(allow(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 25', description: 'x' }))))
  const text = reason(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 40', description: 'x' })))
  assert.equal(
    text,
    'foreground-guard 拒绝：本回合前台等待已用 25s，再加这次 40s 会超过单回合预算 60s。'
    + '不要轮询，后台任务完成会自动唤醒你；需要等条件成立请用 sentinel_watch。',
  )
})

await check('预算按 agent 隔离', async () => {
  const h = boot({ promptOnViolation: false })
  assert.ok(allow(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 45', description: 'x' }, agentA))))
  assert.ok(allow(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 45', description: 'x' }, agentB))))
})

await check('新用户消息重置预算', async () => {
  const h = boot({ promptOnViolation: false })
  assert.ok(allow(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 45', description: 'x' }))))
  assert.equal(typeof reason(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 45', description: 'x' }))), 'string')
  resetTurn(h, agentA)
  assert.ok(allow(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 45', description: 'x' }))))
})

/* ── 3. 授权通道 ───────────────────────────────────────────── */

await check('批准一次 → 本次放行，且本回合后续不再拦、不再问', async () => {
  const h = boot({}, { approval: () => 'allowed-once' })
  assert.ok(allow(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 100', description: 'x' }))))
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].toolName, 'pwsh')
  assert.match(h.requests[0].displayReason.zh, /前台等待授权/)
  assert.match(h.requests[0].reason, /foreground-guard: pwsh/)
  assert.ok(!h.requests[0].reason.includes('NaN'), '授权原因不应出现 NaN')
  assert.ok(!h.requests[0].displayReason.zh.includes('NaN'), '授权文案不应出现 NaN')
  assert.ok(allow(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 300', description: 'x' }))))
  assert.equal(h.requests.length, 1, '批准后不应再弹授权')
})

await check('前台超时的授权文案带真实秒数（无 NaN）', async () => {
  const h = boot({}, { approval: () => 'allowed-once' })
  assert.ok(allow(await h.run(call('pwsh', { command: 'pnpm build', description: 'x', timeoutMs: 300000 }))))
  assert.equal(h.requests.length, 1)
  assert.match(h.requests[0].displayReason.zh, /300s/)
  assert.match(h.requests[0].reason, /300s/)
  assert.ok(!h.requests[0].reason.includes('NaN'))
  assert.ok(!h.requests[0].displayReason.zh.includes('NaN'))
})

await check('拒绝 → 本次拒绝，本回合后续直接拒绝且不再问', async () => {
  const h = boot({}, { approval: () => 'rejected' })
  const first = await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 100', description: 'x' }))
  assert.match(reason(first), /用户已拒绝这次前台等待授权/)
  assert.match(reason(first), /超过单次上限 60s/, '拒绝文案仍带上违规细节')
  const second = await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 100', description: 'x' }))
  assert.match(reason(second), /本回合不会再弹授权/)
  assert.equal(h.requests.length, 1, '拒绝后不应重复打扰')
})

await check('拒绝后：合规小等待仍放行，再次违规按对应规则拒绝', async () => {
  const h = boot({}, { approval: () => 'rejected' })
  const first = await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 100', description: 'x' }))
  assert.match(reason(first), /超过单次上限 60s/)
  assert.ok(allow(await h.run(call('pwsh', { command: 'Start-Sleep -Milliseconds 300', description: 'x' }))))
  const second = reason(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 100', description: 'x' })))
  assert.match(second, /本回合不会再弹授权/)
  assert.match(second, /超过单次上限 60s/, '拒绝后再次违规仍要给出对应规则的细节')
  assert.ok(!second.includes('再加这次 0s'), '不应退化成空白预算文案')
  assert.equal(h.requests.length, 1)
})

await check('会话策略 never：不弹框，按规则直接拒绝且不误判为用户拒绝', async () => {
  const h = boot({}, { approval: () => 'allowed-once', policy: 'never', session: { id: 's' } })
  const first = reason(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 100', description: 'x' })))
  assert.match(first, /超过单次上限 60s/)
  assert.ok(!first.includes('用户已拒绝'), '不能把策略禁止询问说成用户拒绝')
  assert.equal(h.requests.length, 0, 'never 策略下不应请求授权')
  const second = reason(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 100', description: 'x' })))
  assert.match(second, /超过单次上限 60s/)
  assert.ok(!second.includes('本回合不会再弹授权'))
  assert.equal(h.requests.length, 0)
})

await check('会话策略 ask：照常请求授权', async () => {
  const h = boot({}, { approval: () => 'allowed-once', policy: 'ask', session: { id: 's' } })
  assert.ok(allow(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 100', description: 'x' }))))
  assert.equal(h.requests.length, 1)
})

await check('策略 never：改走问答卡片，允许后本回合豁免', async () => {
  const approve = { answers: [{ id: 'foreground-guard', selected: ['允许本回合（后续不再询问）'] }] }
  const h = boot({}, { policy: 'never', session: { id: 's' }, questions: () => approve })
  assert.ok(allow(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 100', description: 'x' }))))
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].via, 'questions')
  assert.equal(h.requests[0].questions[0].intent.kind, 'approval')
  assert.ok(allow(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 100', description: 'x' }))))
  assert.equal(h.requests.length, 1, '批准后本回合不再问')
})

await check('策略 never：问答卡片拒绝后本回合直接拒绝', async () => {
  const reject = { answers: [{ id: 'foreground-guard', selected: ['拒绝'] }] }
  const h = boot({}, { policy: 'never', session: { id: 's' }, questions: () => reject })
  const first = reason(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 100', description: 'x' })))
  assert.match(first, /用户已拒绝这次前台等待授权/)
  const second = reason(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 100', description: 'x' })))
  assert.match(second, /本回合不会再弹授权/)
  assert.equal(h.requests.length, 1)
})

await check('策略 never 且没有问答通道：直接拒绝', async () => {
  const h = boot({}, { policy: 'never', session: { id: 's' } })
  const text = reason(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 100', description: 'x' })))
  assert.match(text, /超过单次上限 60s/)
  assert.ok(!text.includes('用户已拒绝'))
  assert.equal(h.requests.length, 0)
})

await check('问答通道抛错（如子代理 DELEGATED_CALLER）：直接拒绝', async () => {
  const h = boot({}, {
    policy: 'never',
    session: { id: 's' },
    questions: () => { throw new Error('DELEGATED_CALLER') },
  })
  const text = reason(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 100', description: 'x' })))
  assert.match(text, /超过单次上限 60s/)
  assert.ok(!text.includes('用户已拒绝'))
})

await check('策略 ask 但审批通道缺失：回落到问答卡片', async () => {
  const approve = { answers: [{ id: 'foreground-guard', selected: ['允许本回合（后续不再询问）'] }] }
  const h = boot({}, { policy: 'ask', session: { id: 's' }, questions: () => approve })
  assert.ok(allow(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 100', description: 'x' }))))
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].via, 'questions')
})

await check('小于阈值的等待不计入回合总时长（默认 5s）', async () => {
  const h = boot({ promptOnViolation: false })
  for (let i = 0; i < 10; i += 1) {
    assert.ok(allow(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 1', description: 'x' }))))
  }
  // 10 次 1s 若计入就是 10s；这里仍能再放行 50s，说明它们没记账
  assert.ok(allow(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 50', description: 'x' }))))
  const text = reason(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 20', description: 'x' })))
  assert.match(text, /本回合前台等待已用 50s，再加这次 20s/)
})

await check('ignoreBelowSeconds: 0 关闭豁免', async () => {
  const h = boot({ promptOnViolation: false, ignoreBelowSeconds: 0, turnBudgetSeconds: 2 })
  assert.ok(allow(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 1', description: 'x' }))))
  assert.ok(allow(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 1', description: 'x' }))))
  assert.match(reason(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 1', description: 'x' }))), /单回合预算 2s/)
})

await check('豁免不放宽单次上限', async () => {
  const h = boot({ promptOnViolation: false, ignoreBelowSeconds: 100 })
  const text = reason(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 70', description: 'x' })))
  assert.match(text, /超过单次上限 60s/)
})

await check('ignoreBelowSeconds 非法值在加载时抛错', () => {
  assert.throws(() => boot({ ignoreBelowSeconds: -1 }), /必须是非负数/)
})

await check('授权服务抛错 → 退回直接拒绝', async () => {
  const h = boot({}, { approval: () => { throw new Error('boom') } })
  const decision = await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 100', description: 'x' }))
  assert.match(reason(decision), /超过单次上限/)
})

await check('promptOnViolation: false 不请求授权', async () => {
  const h = boot({ promptOnViolation: false }, { approval: () => 'allowed-once' })
  const decision = await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 100', description: 'x' }))
  assert.match(reason(decision), /超过单次上限/)
  assert.equal(h.requests.length, 0)
})

await check('新用户消息重置授权状态', async () => {
  const h = boot({}, { approval: () => 'allowed-once' })
  assert.ok(allow(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 100', description: 'x' }))))
  resetTurn(h, agentA)
  assert.ok(allow(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 100', description: 'x' }))))
  assert.equal(h.requests.length, 2, '新回合应重新询问')
})

/* ── 4. 放行项与其它上限 ───────────────────────────────────── */

await check('run_in_background 的 sleep 放行且不弹框', async () => {
  const h = boot({}, { approval: () => 'rejected' })
  assert.ok(allow(await h.run(call('pwsh', { command: 'Start-Sleep -Seconds 300', description: 'x', run_in_background: true }))))
  assert.equal(h.requests.length, 0)
})

await check('毫秒级 sleep 放行', async () => {
  const h = boot()
  for (let i = 0; i < 5; i += 1) {
    assert.ok(allow(await h.run(call('pwsh', { command: 'Start-Sleep -Milliseconds 500', description: 'x' }))))
  }
})

await check('程序化调用（无 agent）不被拦', async () => {
  const h = boot()
  assert.ok(allow(await h.run({ name: 'pwsh', arguments: { command: 'Start-Sleep -Seconds 300', description: 'x' } })))
})

await check('下游策略已拒绝时不覆盖', async () => {
  const h = boot()
  const entry = h.listeners.find(item => item.event === 'tools/pre-execute')
  const decision = await entry.handler(
    call('pwsh', { command: 'Start-Sleep -Seconds 300', description: 'x' }),
    async () => ({ kind: 'deny', reason: 'sandbox said no' }),
  )
  assert.equal(decision.reason, 'sandbox said no')
})

await check('前台 timeoutMs 300s 被拒 / 60s 放行', async () => {
  const h = boot({ promptOnViolation: false })
  assert.match(reason(await h.run(call('pwsh', { command: 'pnpm build', description: 'x', timeoutMs: 300000 }))), /前台上限 60s/)
  assert.ok(allow(await h.run(call('pwsh', { command: 'pnpm build', description: 'x', timeoutMs: 60000 }))))
})

await check('job_output 等待计入预算', async () => {
  const h = boot({ promptOnViolation: false })
  assert.ok(allow(await h.run(call('job_output', { job_id: 'j', wait: true, timeout_ms: 45000 }))))
  assert.match(reason(await h.run(call('job_output', { job_id: 'j', wait: true, timeout_ms: 20000 }))), /单回合预算/)
  assert.ok(allow(await h.run(call('job_output', { job_id: 'j' }))))
})

await check('wait_agent 默认不计入，countWaitAgent 打开后计入', async () => {
  const off = boot({ promptOnViolation: false })
  assert.ok(allow(await off.run(call('wait_agent', { timeout_ms: 300000 }))))
  const on = boot({ promptOnViolation: false, countWaitAgent: true })
  assert.match(reason(await on.run(call('wait_agent', { timeout_ms: 300000 }))), /单次上限/)
})

/* ── 5. 配置与提示 ─────────────────────────────────────────── */

await check('非法配置在加载时抛错', () => {
  assert.throws(() => boot({ maxSleepSeconds: -1 }), /必须是正数/)
  assert.throws(() => boot({ shellTools: 'pwsh' }), /字符串数组/)
})

await check('注入一段系统提示段落', () => {
  const h = boot()
  assert.equal(h.sections.length, 1)
  assert.equal(h.sections[0].name, 'foreground-guard')
  assert.match(h.sections[0].text, /run_in_background=true/)
})

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
