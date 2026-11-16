/**
 * dsh-wait-guard — 前台等待治理。
 *
 * 在 `tools/pre-execute` 上做门控：默认拒绝让前台阻塞过久的调用；配置
 * `promptOnViolation: true` 时改为**弹出宿主的审批框**请用户手动授权，
 * 批准一次即本回合豁免（模型不再被拦、也不再弹框），拒绝则本回合后续
 * 违规直接拒绝、不再打扰。
 *
 * 拦截四类：
 *   1. 单条命令里任何静态可解析的 sleep 超过 `maxSleepSeconds`；
 *   2. 本回合累计前台等待（sleep 之和 + job_output 等待）超过 `turnBudgetSeconds`；
 *   3. 前台命令声明 `timeoutMs` 超过 `maxForegroundTimeoutSeconds`；
 *   4. （可选）`wait_agent` 的 timeout_ms 超过单次上限。
 *
 * 放行：`run_in_background` 调用、毫秒级 sleep、程序化调用（没有 agent 的
 * `ctx.tools.execute()`）。
 *
 * 本插件刻意零依赖：不 import 任何包，避免 link 安装时缺 node_modules 解析。
 */

export const name = 'wait-guard'

import fs from 'node:fs'

/** 依赖 tools（门控挂载点）与 systemPrompt（策略段落）。 */
export const inject = ['tools', 'systemPrompt']

const DEFAULT_CONFIG = {
  /** 单条命令内任一 sleep 的秒数上限。 */
  maxSleepSeconds: 60,
  /** 每个用户回合允许的前台阻塞等待总秒数（sleep 之和 + job 等待）。 */
  turnBudgetSeconds: 60,
  /**
   * 小于这个秒数的单次等待不计入回合总时长（单次上限仍然生效）。
   * 用于放行一轮里高频的小等待（`Start-Sleep -Seconds 1` × 60 次这类），
   * 0 表示关闭该豁免。
   */
  ignoreBelowSeconds: 5,
  /** 前台命令允许声明的 timeoutMs 上限（秒）。 */
  maxForegroundTimeoutSeconds: 60,
  /** 违规时弹审批框请用户授权；false 则直接拒绝（旧行为）。 */
  promptOnViolation: true,
  /** 把 `job_output(wait: true)` 的等待计入回合预算。 */
  countJobWait: true,
  /** 把 `wait_agent` 的等待计入回合预算（默认否：子代理等待是正当阻塞）。 */
  countWaitAgent: false,
  /** 把 `remote_exec` 的 timeoutSeconds 计入回合预算。 */
  countRemoteExec: true,
  /** 需要解析 sleep 的 shell 工具名。 */
  shellTools: ['pwsh', 'bash'],
  /** 需要解析 sleep 的持久终端工具名。 */
  terminalTools: ['terminal_send'],
  /** 是否注入一段系统提示，把已强制的策略提前告诉模型。 */
  promptNotice: true,
}

const PROMPT_SECTION = [
  '## Foreground wait policy (enforced by the wait-guard plugin)',
  '- Any sleep inside a command must stay at or below 60s, and the total foreground wait of one turn (sleep + job_output waits) must stay at or below 60s.',
  '- For work that takes longer, run it with run_in_background=true (or remote_run) and stop waiting: the job completion notice wakes you automatically. Do not use sleep or job_output polling to wait.',
  '- For a condition that is not a job (a file appearing, a port opening, a command succeeding), use sentinel_watch instead of polling.',
  '- A foreground command may not declare a timeout above 60s; long commands belong in the background.',
  '- Exceeding these limits is refused, or forwarded to the user for explicit authorization when they are present.',
].join('\n')

/* ────────────────────────── 静态等待解析 ────────────────────────── */

const NUMBER = String.raw`[0-9]+(?:\.[0-9]+)?`

/** 语句切分：`;`、换行、`|`、`&&`、`||` 都是语句边界。 */
function splitStatements(text) {
  return text.split(/[;\n]|\|\||&&|\|/)
}

/** 把「数值 + 单位后缀」换算成秒。 */
function toSeconds(value, unit) {
  const n = Number(value)
  if (!Number.isFinite(n)) return undefined
  switch ((unit ?? '').toLowerCase()) {
    case 'ms': return n / 1000
    case 'm': return n * 60
    case 'h': return n * 3600
    case 'd': return n * 86400
    default: return n
  }
}

/**
 * 从一段命令文本里抽出所有可静态判定的等待秒数。
 * 覆盖：Start-Sleep / sleep 的 -Seconds/-s、-Milliseconds/-ms/-m、位置参数，
 * cmd 的 `timeout /t N`，以及 Python 的 `time.sleep(N)`。
 * 无法解析的写法（`-Seconds $n`、变量拼接）不会出现在结果里——这是已知边界。
 * @param {string} text 命令或终端输入
 * @returns {number[]} 每处等待的秒数
 */
export function extractWaitSeconds(text) {
  const found = []
  if (typeof text !== 'string' || text.length === 0) return found

  for (const match of text.matchAll(new RegExp(String.raw`time\.sleep\(\s*(${NUMBER})\s*\)`, 'gi'))) {
    found.push(Number(match[1]))
  }

  for (const statement of splitStatements(text)) {
    const piece = statement.trim()
    if (piece.length === 0) continue

    const cmdTimeout = piece.match(/\btimeout\s+\/t\s+([0-9]+)/i)
    if (cmdTimeout) {
      found.push(Number(cmdTimeout[1]))
      continue
    }
    if (!/\b(?:start-sleep|sleep)\b/i.test(piece)) continue

    const withMs = piece.match(
      new RegExp(String.raw`\b(?:start-sleep|sleep)\b[^\n]*?-(?:milliseconds|ms|m)\b\s*[:=]?\s*\(?\s*(${NUMBER})`, 'i'),
    )
    if (withMs) {
      found.push(Number(withMs[1]) / 1000)
      continue
    }

    const withSeconds = piece.match(
      new RegExp(String.raw`\b(?:start-sleep|sleep)\b[^\n]*?-(?:seconds|s)\b\s*[:=]?\s*\(?\s*(${NUMBER})`, 'i'),
    )
    if (withSeconds) {
      found.push(Number(withSeconds[1]))
      continue
    }

    const positional = piece.match(
      new RegExp(String.raw`\b(?:start-sleep|sleep)\b\s+\(?\s*(${NUMBER})\s*(ms|s|m|h|d)?\s*\)?(?=\s*(?:$|[)\]}]))`, 'i'),
    )
    if (positional) {
      const seconds = toSeconds(positional[1], positional[2])
      if (seconds !== undefined) found.push(seconds)
    }
  }

  return found
}

/* ────────────────────────── 门控 ────────────────────────── */

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function seconds(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function round(value) {
  return Math.round(value * 10) / 10
}

/** 校验配置；非法值在插件加载时直接抛错（fail loud，绝不静默降级）。 */
function resolveConfig(config) {
  const merged = { ...DEFAULT_CONFIG }
  if (isObject(config)) {
    for (const [key, value] of Object.entries(config)) {
      if (value !== undefined && value !== null) merged[key] = value
    }
  }
  for (const key of ['maxSleepSeconds', 'turnBudgetSeconds', 'maxForegroundTimeoutSeconds']) {
    const value = merged[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`wait-guard: \`${key}\` 必须是正数，收到 ${JSON.stringify(value)}`)
    }
  }
  for (const key of ['shellTools', 'terminalTools']) {
    if (!Array.isArray(merged[key]) || merged[key].some(item => typeof item !== 'string')) {
      throw new Error(`wait-guard: \`${key}\` 必须是字符串数组`)
    }
  }
  {
    const value = merged.ignoreBelowSeconds
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`wait-guard: \`ignoreBelowSeconds\` 必须是非负数，收到 ${JSON.stringify(value)}`)
    }
  }
  return merged
}

/** 授权被用户拒绝后的提示：本回合不再打扰，也不许换个小等待继续磨。 */
function rejectedText(call, spent, config) {
  return 'wait-guard 拒绝：用户已拒绝这次前台等待授权，本回合不会再弹授权。'
    + violationText(call, spent, config).replace(/^wait-guard 拒绝：/, '')
}

/** 违规说明（无授权通道或用户关掉授权时直接给模型看的话）。 */
function violationText(call, spent, config) {
  if (call.overSingle) {
    return `wait-guard 拒绝：这次 ${call.tool} 调用的等待为 ${round(call.maxSingle)}s，`
      + `超过单次上限 ${config.maxSleepSeconds}s。不要在前台等待：长耗时工作请用 run_in_background`
      + '（或 remote_run）提交后台，任务完成会自动唤醒你，不需要 sleep 或 job_output 轮询；'
      + '要等某个条件成立（文件出现、端口打开、命令成功）请用 sentinel_watch。'
  }
  if (call.overTimeout) {
    return `wait-guard 拒绝：前台命令申请了 ${round(call.foregroundTimeoutMs / 1000)}s 超时，`
      + `超过前台上限 ${config.maxForegroundTimeoutSeconds}s。请改用 run_in_background=true 提交后台`
      + '（无超时限制），完成后会自动通知你。'
  }
  return `wait-guard 拒绝：本回合前台等待已用 ${round(spent)}s，再加这次 ${round(call.seconds)}s `
    + `会超过单回合预算 ${config.turnBudgetSeconds}s。不要轮询，后台任务完成会自动唤醒你；`
    + '需要等条件成立请用 sentinel_watch。'
}

/**
 * 安装门控与提示段落。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文，注册物随它释放
 * @param {object} rawConfig 行配置（来自 cordis.patch.yml 的 `config`）
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  /** agent → 本回合状态：{ spent: 已用秒数, verdict: undefined|'granted'|'denied' }。 */
  const turns = new WeakMap()

  /** 诊断日志：配置 `debugFile` 时把每次 pre-execute 的关键节点追加到文件。 */
  const debugFile = typeof config.debugFile === 'string' && config.debugFile.length > 0 ? config.debugFile : undefined
  function trace(message) {
    if (debugFile === undefined) return
    try {
      fs.appendFileSync(debugFile, `${new Date().toISOString()} ${message}\n`, 'utf8')
    } catch {}
  }

  function stateOf(agent) {
    let state = turns.get(agent)
    if (state === undefined) {
      state = { spent: 0, verdict: undefined }
      turns.set(agent, state)
    }
    return state
  }

  const deny = (reason, code = 'WAIT_GUARD') => ({ kind: 'deny', reason, info: { name: 'WaitGuardDenied', code } })

  /** 计算一次调用声明的等待；返回 undefined 表示与等待无关。 */
  function analyse(exec) {
    const args = exec.arguments
    if (!isObject(args)) return undefined
    const tool = exec.name

    if (config.countJobWait && tool === 'job_output' && args.wait === true) {
      const ms = seconds(args.timeout_ms, seconds(args.timeoutMs, 30_000))
      return { tool, seconds: ms / 1000, maxSingle: ms / 1000 }
    }
    if (tool === 'wait_agent' && typeof args.timeout_ms === 'number') {
      if (config.countWaitAgent !== true) return undefined
      return { tool, seconds: args.timeout_ms / 1000, maxSingle: args.timeout_ms / 1000 }
    }
    if (config.countRemoteExec && tool === 'remote_exec' && typeof args.timeoutSeconds === 'number') {
      return { tool, seconds: args.timeoutSeconds, maxSingle: args.timeoutSeconds }
    }
    if (config.shellTools.includes(tool) || config.terminalTools.includes(tool)) {
      if (args.run_in_background === true) return undefined
      const text = config.shellTools.includes(tool) ? args.command : args.text
      const foregroundTimeoutMs = config.shellTools.includes(tool) && typeof args.timeoutMs === 'number'
        ? args.timeoutMs
        : undefined
      const waits = extractWaitSeconds(text)
      const total = waits.reduce((sum, value) => sum + value, 0)
      const maxSingle = waits.reduce((best, value) => Math.max(best, value), 0)
      if (waits.length === 0 && foregroundTimeoutMs === undefined) return undefined
      return { tool, seconds: total, maxSingle, foregroundTimeoutMs }
    }
    return undefined
  }

  /** 判断是否越过任一上限；同时算出「本次是否免于计入回合总时长」。 */
  function judge(call, spent) {
    call.overSingle = call.maxSingle > config.maxSleepSeconds
    call.overTimeout = call.foregroundTimeoutMs !== undefined
      && call.foregroundTimeoutMs > config.maxForegroundTimeoutSeconds * 1000
    // 高频小等待豁免：单次小于阈值的等待不计入回合总时长（单次上限仍先生效）。
    call.exempt = !call.overSingle && config.ignoreBelowSeconds > 0
      && call.maxSingle < config.ignoreBelowSeconds
    const overBudget = !call.overSingle && !call.overTimeout && !call.exempt && call.seconds > 0
      && spent + call.seconds > config.turnBudgetSeconds
    call.overBudget = overBudget
    return call.overSingle || call.overTimeout || overBudget
  }

  /** 记入回合总时长（豁免的等待不记账）。 */
  function charge(call, state) {
    if (!call.exempt) state.spent += call.seconds
  }

  /** 走 userQuestions 通道要授权：不受会话审批策略（ask/never）影响。 */
  async function askViaQuestions(exec, call, spent) {
    const questions = ctx.get('userQuestions')
    trace(`userQuestions=${questions === undefined ? 'undefined' : typeof questions.ask}`)
    if (questions === undefined || typeof questions.ask !== 'function') return undefined
    const build = (kind) => {
      if (kind === 'single') {
        return `这次 ${call.tool} 调用的等待为 ${round(call.maxSingle)}s，超过单次上限 ${config.maxSleepSeconds}s。允许本回合在前台等待吗？`
      }
      if (kind === 'timeout') {
        return `前台命令申请了 ${round(call.foregroundTimeoutMs / 1000)}s 超时，超过前台上限 ${config.maxForegroundTimeoutSeconds}s。允许本回合在前台等待吗？`
      }
      return `本回合前台等待已用 ${round(spent)}s，再加这次 ${round(call.seconds)}s 会超过单回合预算 ${config.turnBudgetSeconds}s。允许本回合继续前台等待吗？`
    }
    const kind = call.overSingle ? 'single' : call.overTimeout ? 'timeout' : 'budget'
    const APPROVE = '允许本回合（后续不再询问）'
    const REJECT = '拒绝'
    try {
      const answer = await questions.ask({
        agent: exec.agent,
        signal: exec.signal,
        questions: [{
          id: 'wait-guard',
          header: '前台等待授权',
          question: build(kind),
          detail: `wait-guard: ${call.tool} 前台等待超限。批准后本回合后续等待全部放行；拒绝后本回合违规一律直接拒绝。`
          + ' Approving exempts the rest of this turn from the wait policy.',
          options: [
            { label: APPROVE, description: '本次放行，且本回合后续等待全部豁免' },
            { label: REJECT, description: '本次报错，本回合后续违规直接拒绝' },
          ],
          intent: { kind: 'approval', approve: APPROVE, reject: REJECT },
        }],
      })
      const item = answer?.answers?.find(entry => entry.id === 'wait-guard')
      trace(`questions-answer=${JSON.stringify(answer)?.slice(0, 300)}`)
      if (item === undefined) return undefined
      return Array.isArray(item.selected) && item.selected.includes(APPROVE) ? 'granted' : 'denied'
    } catch (error) {
      trace(`questions-ask failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
      // 子代理（DELEGATED_CALLER）、无应答器、被取消等：都退回直接拒绝。
      return undefined
    }
  }

  /** 向用户要授权；返回 'granted' | 'denied' | undefined（通道不可用）。 */
  async function askUser(exec, call, spent) {
    const approval = ctx.get('approval')
    if (approval === undefined || typeof approval.request !== 'function') return undefined
    const zh = call.overSingle
      ? `前台等待授权：这次 ${call.tool} 调用会阻塞 ${round(call.maxSingle)}s，超过单次上限 ${config.maxSleepSeconds}s。允许吗？批准后本回合不再拦截。`
      : call.overTimeout
        ? `前台等待授权：前台命令申请了 ${round(call.foregroundTimeoutMs / 1000)}s 超时，超过前台上限 ${config.maxForegroundTimeoutSeconds}s。允许吗？批准后本回合不再拦截。`
        : `前台等待授权：本回合前台等待已用 ${round(spent)}s，再加这次 ${round(call.seconds)}s 会超过单回合预算 ${config.turnBudgetSeconds}s。允许吗？批准后本回合不再拦截。`
    const en = call.overSingle
      ? `Foreground wait request: this ${call.tool} call would block ${round(call.maxSingle)}s, over the ${config.maxSleepSeconds}s per-call limit.`
      : call.overTimeout
        ? `Foreground wait request: this foreground command asks for a ${round(call.foregroundTimeoutMs / 1000)}s timeout, over the ${config.maxForegroundTimeoutSeconds}s foreground limit.`
        : `Foreground wait request: this turn already waited ${round(spent)}s, and ${round(call.seconds)}s more would exceed the ${config.turnBudgetSeconds}s per-turn budget.`
    const reason = call.overSingle
      ? `wait-guard: ${call.tool} 前台等待 ${round(call.maxSingle)}s / 上限 ${config.maxSleepSeconds}s`
      : call.overTimeout
        ? `wait-guard: ${call.tool} 前台超时 ${round(call.foregroundTimeoutMs / 1000)}s / 上限 ${config.maxForegroundTimeoutSeconds}s`
        : `wait-guard: ${call.tool} 本回合累计 ${round(spent + call.seconds)}s / 预算 ${config.turnBudgetSeconds}s`
    try {
      const outcome = await approval.request({
        agent: exec.agent,
        toolName: exec.name,
        callId: exec.callId,
        reason,
        displayReason: { en: `${en} Allow this call? Approving exempts the rest of this turn.`, zh },
        signal: exec.signal,
      })
      return outcome === 'allowed-once' ? 'granted' : 'denied'
    } catch (error) {
      trace(`approval failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
      return undefined
    }
  }

  /** 读会话的审批策略覆盖：'ask' | 'never' | undefined（无覆盖，沿用部署默认）。 */
  function policyOf(agent) {
    try {
      const approval = ctx.get('approval')
      if (approval === undefined || typeof approval.overrideOf !== 'function') return undefined
      const sessions = ctx.get('sessions')
      const session = sessions?.get?.(agent.id)
      if (session === undefined) return undefined
      return approval.overrideOf(session)
    } catch {
      return undefined
    }
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    let downstream
    try {
      // 先让下游策略（沙箱升级审批等）表态；它不是 allow 就完全交给它。
      downstream = await next()
      trace(`enter tool=${exec.name} agent=${exec.agent === undefined ? 'none' : exec.agent.id} downstream=${downstream.kind}`)
      if (downstream.kind !== 'allow') return downstream
      // 程序化调用没有 agent：不是模型的等待，也不是可路由给用户的问题。
      if (exec.agent === undefined) return downstream

      const state = stateOf(exec.agent)
      if (state.verdict === 'granted') return downstream

      const call = analyse(exec)
      trace(`analyse=${call === undefined ? 'undefined' : JSON.stringify(call)} spent=${state.spent} verdict=${state.verdict}`)
      if (call === undefined) return downstream

      if (state.verdict === 'denied') {
        // 本回合已拒绝授权：仍然只拦违规的等待，合规的小等待照常放行。
        const stillViolated = judge(call, state.spent)
        if (!stillViolated) {
          charge(call, state)
          return downstream
        }
        return deny(rejectedText(call, state.spent, config), 'WAIT_GUARD_REJECTED')
      }

      const violated = judge(call, state.spent)
      trace(`violated=${violated} overSingle=${call.overSingle} overTimeout=${call.overTimeout} overBudget=${call.overBudget} exempt=${call.exempt}`)
      if (!violated) {
        charge(call, state)
        return downstream
      }

      if (config.promptOnViolation) {
        const policy = policyOf(exec.agent)
        trace(`policy=${policy === undefined ? 'undefined' : policy}`)
        // 策略 never 时审批通道只会返回确定性的 rejected，改走问答卡片（userQuestions），
        // 该通道不受审批策略影响；两条路都问不到人时才退回直接拒绝。
        let verdict = policy === 'never'
          ? await askViaQuestions(exec, call, state.spent)
          : await askUser(exec, call, state.spent)
        if (verdict === undefined && policy !== 'never') {
          verdict = await askViaQuestions(exec, call, state.spent)
        }
        trace(`verdict=${verdict}`)
        if (verdict === 'granted') {
          state.verdict = 'granted'
          return downstream
        }
        if (verdict === 'denied') {
          state.verdict = 'denied'
          return deny(rejectedText(call, state.spent, config), 'WAIT_GUARD_REJECTED')
        }
        // 授权通道不可用：退回直接拒绝。
      }
      return deny(violationText(call, state.spent, config))
    } catch (error) {
      trace(`THREW ${error instanceof Error ? error.message : String(error)}`)
      return downstream ?? { kind: 'allow' }
    }
  })

  if (config.promptNotice) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'wait-guard',
      order: 950,
      text: PROMPT_SECTION,
    }))
  }

  // 新用户消息 = 新回合：预算与授权状态清零。
  ctx.on('agent/pre-step', ({ agent, messages }, next) => {
    if (Array.isArray(messages) && messages.some(message => message?.source?.kind === 'user')) {
      turns.delete(agent)
    }
    return next()
  })
}
