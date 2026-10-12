/**
 * dsh-weixin — 微信消息通道插件。
 *
 * 把微信变成 DSH 的入口：手机微信发消息 → weixin-agent-sdk（iLink 通道）→
 * 本插件把消息驱动进 DSH agent，并把最终回复发回微信。
 *
 * 会话连续性：每个微信对话（conversationId）复用一个 DSH agent，多次消息
 * 走同一个 session。conversationId→sessionId 落盘到
 * `<DSH_HOME>/dsh-weixin/conversations.json`，重启后 resume 原 session。
 *
 * 工作区归属（filepush7）：新会话 cwd 必须落在已有工作区（跳过 Program Files
 * 安装目录），create/resume 后 attachSession，侧边栏才能看到。已有 weixin-*
 * 会话的 cwd 不能改；cwd 还没有工作区时 registry.create(cwd)+attach 打捞。
 * 模型选择用可变 getter/setter，尊重 session 上的 model/selection 事件；
 * 监听用 prepend，盖住旧插件冻在 agent 上的 installModelSelection。
 * salvage 时给已经 live 的 weixin agent 补装，不必等下一句微信消息。
 *
 * 默认 preset（filepush8）：微信 create/resume 不走 GUI composeAgent，agentPreset
 * 一直是 null，pwsh/read/bash 等编码工具不会进会话。setup 里 mount 默认
 * preset（cordis）；已经 live 的 weixin agent 用 recompose 补挂并发 tools/change。
 * 已开过轮次的会话不能走 select()（会 agent-preset/locked）。
 *
 * 启动预热（filepush9）：插件 disable→enable 会 dispose 旧 live agent，salvage
 * 只给当时仍 live 的补挂，绑定会话要等到下一句微信才 resume。apply 后按
 * conversations.json 主动 resume 绑定 session，setup 里立刻 mount。
 * mount/recompose 显式传入 resolve() 得到的 preset id，不依赖缺省参数。
 *
 * 工具面实打（filepush10）：mount/recompose 成功后立刻用 tools.schemas(agent)
 * 打出该 agent 可见工具名。这是 assemble 同一条 visibility 路径，用来证明
 * isolate 里的 pwsh/read 是否已经进 weixin agent，不必等下一句微信。
 *
 * 微信选项桥（filepush11）：ask_user_question 走 scoped waterfall
 * `user-questions/request`，GUI 卡在瀑布里等点选；weixin-agent-sdk 又只在
 * `chat()` 返回后才把回复推到手机。于是微信永远看不到 A/B/C。本插件在
 * 插件 ctx 上 prepend 该瀑布：识别本插件跟踪的 weixin agent 后，把题面
 * 交给 chat() 立刻回微信，并等下一句微信解析成答案再结束瀑布。
 * 非本通道的会话仍 next() 给 GUI。
 *
 * 单实例选举（2026-10-06 加入）：
 *   同一个 profile 可能被多个 DSH 宿主同时加载（例如 GUI 宿主 43120 + 无头
 *   宿主 3081）。iLink 是「单消费者」通道——账号的 get_updates_buf 游标由
 *   谁先轮询谁推进，两个宿主同时 start() 会互相抢消息、回复丢失或串话。
 *   因此这里用 `<DSH_HOME>/dsh-weixin/ilink-owner.lock` 做互斥选举：
 *   只有拿到锁的宿主才真正轮询，其余宿主退化为待命，锁主退出后自动接管。
 *
 * 媒体双向（2026-10-06 加入，方案A）：
 *   weixin-agent-sdk 0.3.0 自身已完成双向媒体的下载/解密/上传：
 *     · 入站：ChatRequest.media（已解密落盘）——旧插件直接丢弃；
 *     · 出站：ChatResponse.media.url（本机绝对路径）——旧插件从不返回。
 *   本插件补齐两端：入站把媒体归档到 `<DSH_HOME>/weixin-inbox/<日期>/`
 *   并把路径注入 agent 文本（DSH 侧读图，见 filepush14）；出站识别回复里的
 *   显式标记 `[[send-file:<绝对路径>]]`（可出现在本轮任一步，标记行本身
 *   不发用户），取出文件走 SDK 发送。约定文本每轮随用户消息注入。
 *
 * 归档自愈（filepush13）：用户在 GUI 侧栏点了「归档对话」之后，这个会话就再也
 *   回不来了——durable archive set 会让框架的 ArchivedSessionGate 在
 *   agent/pre-step 直接 reject，agent-loop 把它记成 turn/end reason=blocked，
 *   **连 step/start 都不写**。微信端只看到「模型调用失败：本轮被中断（blocked）」，
 *   完全不知道是归档造成的，也没有恢复入口。现在 resume/chat 之前会主动
 *   `workspaceRegistry.unarchiveSession()`（幂等、不查存在性、只删一个 id），
 *   手动归档也能自愈；salvage 阶段则刻意不动归档状态，避免把用户历史归档的
 *   十几个旧会话全部拉回侧边栏。
 *
 * 路由兜底收紧（filepush13）：agent-default-model 指向 gemini-gateway/grok-4.6。
 *   该网关本身是通的（直连 /v1/chat/completions 拿到 200），但在宿主日志里从未
 *   成功跑过一次 chat request（那些回合都在 pre-step 被归档门拦下了）。
 *   兜底改成优先用「被真实流量验证过」的 trae/deepseek-v4.1-flash。
 *
 * 模型选择修复（filepush15）：用户报「选择任何模型（grok4.6 / gemini3.8）都报
 *   pi-ai provider "trae" has no configured model "deepseek-v4.1-flash"
 *   UNKNOWN_MODEL」。根因就是上面那句「兜底改成 trae/deepseek-v4.1-flash」：
 *   UNPROVEN_PROVIDERS 把 gemini-gateway 判成「未验证」，于是用户选的每个模型都被
 *   静默改写成 trae/deepseek-v4.1-flash；而 trae 的目录是运行时拉的，在拿不到
 *   Trae 凭据的宿主上（3083 = SYSTEM 身份）只剩 4 个静态兜底 id，没有这个模型。
 *   两处修复：① UNPROVEN_PROVIDERS 清空（「未验证」前提已被双重证伪）；
 *   ② TRAE_SAFE_ROUTE 改用静态表里确实存在的 DeepSeek-V4-Flash-Official，
 *   让兜底本身不会再变成 UNKNOWN_MODEL。
 *
 * 发图提速（filepush14）：微信发一张图，实测整轮耗时 9 分 6 秒（turn17，38 步）。
 *   两处叠加的浪费：
 *     ① 注入文本指向 modlens_read_image，该路径要过一次外部视觉网关
 *        （siliconflow Qwen3-VL），网关没被要求强制 schema，模型自由发挥的 JSON
 *        匹配不上视觉契约，26 秒后判失败（错误原文见 modlens dist/main.js:1514）；
 *        而原生 read_image 本地直读、图片直接进上下文，实测 0 秒。
 *     ② 注入文本只说了「读它」，没有任何「只回答图片本身」的约束。用户只发图
 *        不带字时，agent 无从判断意图，于是去翻 qx-worklib/手办贴屏规范.md、
 *        relay.log、sessions 目录、写脚本解自己的会话日志……一路漫游 38 步。
 *   现在：优先 read_image，modlens 只在路由不支持图片输入时兜底；并明确禁止
 *   为回答这张图去检索其它文件/日志/目录或猜测用户意图。
 *
 * 微信提问铁律（filepush16，2026-10-08 老总令）：需要用户选择时，必须在回复正文里
 * 列「A/B/C」文字选项让用户回字母；微信通道禁用交互提问工具 ask_user_question
 * （卡片在微信/电脑端都看不到，回合失败或宿主重启后题面两头丢失，会话卡在
 * 「等待你的操作」）。本条作为 [系统约定] 每轮随用户消息注入（同 SEND_FILE_HINT
 * 机制），执行层最上层保证；同时固化进 ~/.dsh/AGENTS.md 交互铁律第 6 条
 * （跨会话最上层兜底）与 Mnemon 记忆。
 */
import { createRequire } from 'node:module'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Schema from '@deepseek-ai/schemastery'
import { isLoggedIn, start } from 'weixin-agent-sdk'

export const name = 'dsh-weixin-plus'

export const inject = ['agentDefaultModel', 'agents', 'workspaceRegistry', 'sessionPersistence', 'agentPresets']

export const Config = Schema.object({
  /** agent 的工作目录。缺省取已有工作区（跳过 Program Files 安装目录），新会话才能进侧边栏。 */
  cwd: Schema.string(),
  /** 覆盖默认 provider 路由。 */
  provider: Schema.string(),
  /** 覆盖默认模型。 */
  model: Schema.string(),
  /** 入站媒体归档目录；缺省 `<DSH_HOME>/weixin-inbox`。 */
  inboxDir: Schema.string(),
})

function letterFor(index) {
  if (index < 26) return String.fromCharCode(65 + index)
  return `O${index + 1}`
}

function formatWeixinQuestions(questions) {
  const lines = ['【需要你选择】请直接回复选项字母（如 A 或 A,C），也可直接打自定义文字。']
  for (const question of questions ?? []) {
    const heading = question.header ? `${question.header}：` : ''
    lines.push('')
    lines.push(`${heading}${question.question}`)
    const options = question.options ?? []
    if (options.length === 0) {
      lines.push('（无固定选项，请直接打字回答）')
      continue
    }
    options.forEach((option, index) => {
      const extra = option.description ? ` — ${option.description}` : ''
      lines.push(`${letterFor(index)}. ${option.label}${extra}`)
    })
    if (question.multiSelect) lines.push('（可多选，字母用逗号或空格分开）')
  }
  return lines.join('\n')
}

function parseLetterTokens(raw) {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return []
  const compact = trimmed.replace(/[.)）]/g, ' ')
  if (/^[A-Za-z](?:\s*[,，、\s]\s*[A-Za-z])*$/.test(compact)) {
    return [...new Set(compact.toUpperCase().match(/[A-Z]/g) ?? [])]
  }
  const tagged = trimmed.match(/^\s*(?:选项?|选)\s*([A-Za-z])\s*$/i)
    ?? trimmed.match(/^\s*([A-Za-z])\s*(?:选项?|选)\s*$/i)
  if (tagged) return [tagged[1].toUpperCase()]
  return []
}

function parseWeixinAnswers(text, questions) {
  const raw = String(text ?? '').trim()
  if (!raw) return undefined
  const letters = parseLetterTokens(raw)
  const answers = []
  for (const question of questions ?? []) {
    const options = question.options ?? []
    const selected = []
    if (options.length && letters.length) {
      for (const token of letters) {
        const index = token.charCodeAt(0) - 65
        if (index >= 0 && index < options.length) selected.push(options[index].label)
      }
    }
    if (question.multiSelect !== true && selected.length > 1) selected.splice(1)
    const item = { id: question.id, selected }
    if (selected.length === 0) item.custom = raw
    answers.push(item)
  }
  return { answers }
}

/**
 * 收集本轮所有 assistant 文本段（多步 turn 会有多条）。
 * 出站标记可能落在中间某步（例如先说「文件在此」再继续总结），
 * 所以标记要在全量文本里找；发给用户的正文仍取最后一条。
 */
function collectAssistantTexts(events, firstSeq, alreadyInTurn = false) {
  const texts = []
  let started = alreadyInTurn
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const text = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (text) texts.push(text)
    }
  }
  return texts
}

/**
 * 找出本轮失败的 turn 结束原因。
 * 模型请求失败时整轮没有 assistant 文本，若不看这里，微信只会收到「（无回复）」，
 * 用户完全不知道发生了什么（2026-10-07 的 Trae 4001 就是这样静默了一整晚）。
 */
function collectTurnFailures(events, firstSeq) {
  const failures = []
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type !== 'turn/end') continue
    const reason = event.data?.reason
    if (reason?.kind === 'error') {
      failures.push(reason.error?.message ?? reason.error?.code ?? '模型请求失败')
    } else if (reason?.kind === 'blocked') {
      failures.push('本轮被中断（blocked）')
    }
  }
  return failures
}

/* ── 媒体双向 ─────────────────────────────────────────────────────────── */

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const DEFAULT_INBOX_ROOT = join(DSH_HOME, 'weixin-inbox')

/** 出站文件标记：回复里独占一行写 `[[send-file:绝对路径]]`。 */
const SEND_FILE_RE = /\[\[send-file:\s*([^\]\r\n]+?)\s*\]\]/gi

/**
 * 每轮注入的简短约定，让 agent 知道怎么把本机文件推给手机。
 * 它作为独立文本块跟在用户消息后面，不改用户原话。
 */
const SEND_FILE_HINT =
  '[系统约定] 若需把本机文件（图片/视频/普通文件）发给用户，请在回复末尾单独一行写：' +
  '[[send-file:文件的绝对路径]]。该行不会展示给用户，只用于触发文件推送；微信通道单条回复只支持推送 1 个媒体文件，若有多个文件，请优先推送最核心的 1 个；纯文本回复无需该标记。'

/**
 * 微信提问铁律（filepush16）：需要用户选择时，正文列「A/B/C」文字选项让用户回字母；
 * 一律禁止交互提问工具 ask_user_question（卡片微信/电脑端都看不到，回合失败或宿主
 * 重启接管后题面丢失，会话卡死）。每轮随用户消息注入，执行层最上层保证。
 */
const TEXT_OPTION_HINT =
  '[系统约定] 微信通道一律只用文字选项提问：需要用户做选择时，必须在回复正文里' +
  '直接列出「A/B/C」文字选项让用户回字母；严禁调用交互提问工具 ask_user_question' +
  '（选项卡片在微信和电脑端都看不到，回合失败或宿主重启后题目丢失，会话卡在' +
  '「等待你的操作」）。'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.heif', '.tif', '.tiff'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.wmv'])

function mediaKind(path) {
  const ext = extname(path).toLowerCase()
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  return 'file'
}

function dayStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 按魔数猜扩展名：SDK 落盘的入站媒体常是无扩展名的 .bin。 */
function sniffExtension(head) {
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return '.png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return '.jpg'
  if (head.length >= 6 && head.subarray(0, 6).toString('latin1').startsWith('GIF8')) return '.gif'
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp'
  if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d) return '.bmp'
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') return '.mp4'
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b) return '.zip'
  if (head.length >= 5 && head.subarray(0, 5).toString('latin1') === '%PDF-') return '.pdf'
  return '.bin'
}

/**
 * 把 SDK 已解密落盘的入站媒体（默认落在进程 cwd 下的 tmp\weixin-agent\media）
 * 归档到 inbox，方便会话里长期引用、也避免 tmp 被清理后失效。
 * SDK 对图片等类型不传 content-type，落盘文件名常以 .bin 结尾——这里按魔数
 * 补正扩展名，否则下游（modlens 读图 / DSH 图片渲染）认不出格式。
 */
function archiveInboundMedia(media, inboxRoot) {
  const root = inboxRoot ?? DEFAULT_INBOX_ROOT
  const dir = join(root, dayStamp())
  mkdirSync(dir, { recursive: true })
  const original = basename(media.filePath ?? '') || 'media.bin'
  let ext = extname(original)
  if (!ext || ext.toLowerCase() === '.bin') {
    try {
      const fd = openSync(media.filePath, 'r')
      try {
        const head = Buffer.alloc(16)
        const read = readSync(fd, head, 0, 16, 0)
        const sniffed = sniffExtension(head.subarray(0, read))
        if (sniffed !== '.bin') ext = sniffed
      } finally {
        closeSync(fd)
      }
    } catch {
      /* 嗅探失败就保留原扩展名 */
    }
  }
  const stem = extname(original) ? original.slice(0, -extname(original).length) : original
  const target = join(dir, `${Date.now()}-${stem}${ext}`)
  copyFileSync(media.filePath, target)
  return target
}

/** 生成注入给 agent 的入站媒体说明文本。 */
function mediaNotice(media, savedPath, archived) {
  const kindLabel = { image: '图片', video: '视频', audio: '语音', file: '文件' }[media.type] ?? '文件'
  const name = media.fileName ? `（原名：${media.fileName}）` : ''
  const where = archived ? savedPath : `${media.filePath}（归档失败，直接引用原路径）`
  const lines = [`[用户发来${kindLabel}${name}] 已保存到：${where}`]
  if (media.type === 'image') {
    // 快路径优先（filepush14）：read_image 本地直读、图片直接进上下文，实测 0 秒；
    // modlens 要过一次外部视觉网关，实测十几秒且网关未强制 schema 时会直接判失败。
    // 同时明确禁止「为了回答这张图去翻别的文件/日志/目录」——那会让一轮变成几十步漫游。
    lines.push(
      '可以用 read_image 直接打开它看图（最快路径），然后只回答图片本身的内容。' +
        '只有当 read_image 不可用（当前路由不支持图片输入）时，才改用 modlens_read_image 兜底。' +
        '不要为了回答这张图去检索其它文件、日志、目录或历史记录，也不要猜测用户想拿这张图做什么。',
    )
  } else if (media.type === 'audio') {
    lines.push('当前链路不对语音做转写，只能确认收到。')
  } else if (media.type === 'video') {
    lines.push('DSH 侧无视频解析工具，只能确认收到并引用路径。')
  } else {
    lines.push('如需查看内容，可用可用的文件读取工具打开该路径。')
  }
  return lines.join('')
}

/** 从回复文本里抽出 `[[send-file:...]]` 标记，返回剥离标记后的文本与待发文件。 */
/** 检测文件是否存在且未被外部进程以排他写锁独占 */
function isFileAccessible(filePath) {
  try {
    const st = statSync(filePath)
    if (!st.isFile()) return { ok: false, reason: 'not_a_file' }
    const fd = openSync(filePath, 'r')
    closeSync(fd)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: (err && err.code) || 'locked' }
  }
}

/** 从回复文本里抽出 `[[send-file:...]]` 标记，返回剥离标记后的文本、待发文件、缺失文件与被占用文件。 */
function extractOutboundFiles(raw) {
  const candidates = []
  const text = String(raw ?? '').replace(SEND_FILE_RE, (_m, p) => {
    candidates.push(String(p).trim())
    return ''
  })
  const existing = []
  const missing = []
  const locked = []
  for (const p of candidates) {
    const check = isFileAccessible(p)
    if (check.ok) {
      existing.push(p)
    } else if (check.reason === 'locked' || check.reason === 'EBUSY' || check.reason === 'EPERM') {
      locked.push(p)
    } else {
      missing.push(p)
    }
  }
  return {
    text: text.replace(/\n{3,}/g, '\n\n').trim(),
    files: existing,
    missing,
    locked,
  }
}

/* ── 单实例选举 ───────────────────────────────────────────────────────── */

const LOCK_DIR = join(DSH_HOME, 'dsh-weixin')
const LOCK_PATH = join(LOCK_DIR, 'ilink-owner.lock')
const MAP_PATH = join(LOCK_DIR, 'conversations.json')
/** 安装目录不当工作区首选：无头宿主 cwd 落在这里，侧边栏也没有对应工作区。 */
const INSTALL_DIR_RE = /(?:^|[\\/])Program Files[\\/]DSH Desktop(?:$|[\\/])/i
const FALLBACK_CWD = homedir()

function isInstallDir(p) {
  return INSTALL_DIR_RE.test(String(p ?? ''))
}

function loadConversationMap() {
  try {
    const raw = JSON.parse(readFileSync(MAP_PATH, 'utf8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  } catch {
    /* 缺失或损坏：当成空表 */
  }
  return {}
}

function saveConversationMap(map) {
  mkdirSync(LOCK_DIR, { recursive: true })
  const tmp = `${MAP_PATH}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`)
  renameSync(tmp, MAP_PATH)
}

function bindConversation(conversationId, sessionId) {
  const map = loadConversationMap()
  if (map[conversationId] === sessionId) return
  map[conversationId] = sessionId
  saveConversationMap(map)
}

function unbindConversation(conversationId) {
  const map = loadConversationMap()
  if (!(conversationId in map)) return
  delete map[conversationId]
  saveConversationMap(map)
}
/** 心跳间隔与失联判定：15s 心跳，5 分钟无心跳视为陈旧。 */
const HEARTBEAT_MS = 15000
const STALE_MS = 5 * 60 * 1000

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * 宿主优先级：0 = 交互式图形宿主（DSH Desktop），1 = 无头 CLI 宿主。
 * 无头宿主由 restart_dsh.py 以 `--port 3081 --no-open` 拉起，cwd 落在
 * Program Files 下，不适合承载微信会话；交互式宿主发现被它占锁时直接抢占，
 * 无头宿主随后在心跳里察觉失去所有权并退出轮询（避免双方重复消费消息）。
 */
function isHeadlessCliHost() {
  return process.argv.some((arg) => /desktop-cli\.js$/i.test(String(arg)))
}
const MY_PRIO = isHeadlessCliHost() ? 1 : 0

function readLock() {
  try {
    const raw = JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
    return { pid: Number(raw?.pid), at: Number(raw?.at), prio: Number(raw?.prio ?? 1) }
  } catch {
    return undefined
  }
}

function lockIsStale(entry) {
  if (!entry) return true
  if (!pidAlive(entry.pid)) return true
  const at = Number(entry.at)
  return !Number.isFinite(at) || Date.now() - at > STALE_MS
}

function dropLock() {
  try {
    unlinkSync(LOCK_PATH)
  } catch {
    /* 已不存在 */
  }
}

/** 独占创建锁文件；成功返回 true。 */
function acquireLock() {
  try {
    mkdirSync(LOCK_DIR, { recursive: true })
  } catch {
    return false
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const held = readLock()
    let preempting = false
    if (held && held.pid !== process.pid && !lockIsStale(held)) {
      // 交互式宿主（prio 0）可抢占无头宿主（prio 1）；同级仍然让位，避免互相踢。
      if (MY_PRIO < held.prio) preempting = true
      else return false
    }
    if (held && (lockIsStale(held) || preempting)) dropLock()
    try {
      const fd = openSync(LOCK_PATH, 'wx')
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), prio: MY_PRIO, cwd: process.cwd() }))
      closeSync(fd)
      return true
    } catch (error) {
      if (error?.code !== 'EEXIST') return false
      // 竞争失败：重新判定持有者是否还活着，活着就让位。
      if (!lockIsStale(readLock())) return false
      dropLock()
    }
  }
  return false
}

/** 心跳续约：只有自己仍持有锁时才写。 */
function heartbeatLock() {
  const held = readLock()
  if (held?.pid !== process.pid) return
  try {
    writeFileSync(
      LOCK_PATH,
      JSON.stringify({ pid: process.pid, at: Date.now(), prio: MY_PRIO, cwd: process.cwd() }),
    )
  } catch {
    /* 续约失败不致命：pid 存活判定仍能兜住 */
  }
}

function releaseLock() {
  if (readLock()?.pid === process.pid) dropLock()
}

/* ── 插件本体 ─────────────────────────────────────────────────────────── */

function sameRoute(left, right) {
  return left.provider === right.provider && left.model === right.model
}

function routeLabel(route, other) {
  return route.provider === other.provider ? route.model : `${route.provider}/${route.model}`
}

/**
 * trae 的 SOLO 聊天只服务白名单内的 config_name；名单外的模型一律回
 * `Trae code 4001 · config_name rejected`，整轮零 assistant 文本，
 * 微信侧只会看到「（无回复）」。
 *
 * 危险之处：一旦这种模型被写进会话的 `model/selection`，
 * installMutableSelection 会把该会话的每一轮请求都强制成它 ⇒ 该会话永久哑掉。
 * 所以在取用钉选路由之前先过一层过滤。
 *
 * 实测（2026-10-07 dsh-2026-10-07.log 逐条配对）：
 *   deepseek-v4.1-flash          411 次 → 4 次 4001（约 1%，多为瞬时）
 *   DeepSeek-V4-Flash-Official    32 次 → 0 次 4001
 *   glm-5.3-flash                 11 次 → 11 次 4001（100%）
 *   qwen3.8-flash                  2 次 →  2 次 4001（100%）
 */
const TRAE_KNOWN_UNSERVED = new Set(['glm-5.3-flash', 'qwen3.8-flash'])

/**
 * 「本通道从未真正验证过」的 provider —— 当前是**空集**。
 *
 * 这里原本钉着 gemini-gateway，理由是它在全部宿主日志（2026-09-15 … 2026-10-07）
 * 里零次成功 chat request。那个理由已经被**双重证伪**：
 *   ① 零成功与网关无关 —— 那些回合都在 agent/pre-step 就被归档门 reject 了，
 *      请求根本没发出去（filepush13 修的就是这道门）；
 *   ② 2026-10-07 再次用 .credentials.yaml 里的 key 直连 /v1/chat/completions，
 *      grok-4.6 与 gemini-3.8-flash-high 都拿到 HTTP 200 + 正常回复。
 *
 * 更要命的是这条规则会**静默改写用户选的模型**：用户点 grok-4.6 / gemini-3.8，
 * 被改写成 trae/deepseek-v4.1-flash；而 trae 的模型目录是运行时拉的，在拿不到
 * Trae 凭据的宿主上（例如 NT AUTHORITY\SYSTEM 身份的 3083，homedir() 落在
 * C:\Windows\system32\config\systemprofile）只剩 4 个静态兜底 id，其中没有
 * deepseek-v4.1-flash ⇒ PiAiAdapter 直接抛 UNKNOWN_MODEL，用户看到的就是
 * 「选任何模型都报错」。根因是这条改写规则，不是模型本身。
 *
 * 保留这个集合作为「已确认坏掉的 provider」的紧急开关，但默认必须为空：没有
 * 实测证据就不要往里加，否则用户的选择会被静默改写、还会连带出 UNKNOWN_MODEL。
 */
const UNPROVEN_PROVIDERS = new Set()

/**
 * trae 上实测可用的兜底路由。
 *
 * 必须选**同时出现在 FALLBACK_TRAE_MODELS 静态目录里**的 id。兜底路由的意义是
 * 「在什么都拿不到的时候还能跑」，而 trae 的运行时目录恰恰会在拿不到凭据的宿主上
 * 回落到那份 4 个 id 的静态表（DeepSeek-V4-Flash-Official / DeepSeek-V4-Pro-Official /
 * glm-5.2 / kimi-k2.6）。旧值 deepseek-v4.1-flash 不在其中，于是兜底本身变成
 * UNKNOWN_MODEL —— 比不兜底还糟。
 *
 * DeepSeek-V4-Flash-Official：静态表成员（任何宿主上都存在），且实测 32 次请求
 * 0 次 4001，是最安全的兜底。
 */
const TRAE_SAFE_ROUTE = { provider: 'trae', model: 'DeepSeek-V4-Flash-Official' }

function isUnserved(route) {
  return Boolean(route?.provider === 'trae' && TRAE_KNOWN_UNSERVED.has(route.model))
}

/** 路由整体不可用：trae 明确不服务，或 provider 本身从未验证通过。 */
function isUnusable(route) {
  return Boolean(!route?.provider || !route?.model || isUnserved(route) || UNPROVEN_PROVIDERS.has(route.provider))
}

/** 兜底路由：默认模型可用就用它；默认模型本身不可用时改用 trae 安全路由。 */
function safeFallback(def) {
  return isUnusable(def) ? { ...TRAE_SAFE_ROUTE } : def
}

/** 钉选路由不可用时退回 fallback；fallback 也不可用时用 trae 安全路由。 */
function sanitizeSelection(route, fallback) {
  if (!route?.provider || !route?.model) return fallback
  if (!isUnusable(route)) return route
  if (fallback?.provider && fallback?.model && !isUnusable(fallback)) return fallback
  return { ...TRAE_SAFE_ROUTE }
}

function modelSwitchNotice(previous, selected) {
  const from = routeLabel(previous, selected)
  const to = routeLabel(selected, previous)
  return createUserMessage({
    content: [{
      type: 'text',
      text: `[model changed: assistant turns above this point were generated by ${from}; the session continues with ${to}]`,
    }],
    source: {
      kind: 'model-selection',
      form: 'notice',
      summary: boundContextSummary(`${from} → ${to}`),
    },
  })
}

export function apply(ctx, config) {
  ctx.logger.warn('[dsh-weixin] BUILD filepush17 loaded (workspace attach + prepend mutable selection + default preset + warm resume + tools.schemas probe + weixin question waterfall + 归档自愈解归档 + 失败回合真错误回传 + 发图走 read_image 快路径并禁止漫游 + 不静默改写用户选的模型 + 兜底路由只挑静态表里存在的 id + 微信文字选项提问铁律每轮注入 + 长任务进度监听 + 空白会话防产生门禁 + 多文件推送与防锁增强)')
  // conversationId -> { agent, dispose, ownedByHost }
  const conversations = new Map()
  const inflight = new Map()
  const mutableInstalled = new WeakSet()
  const presetInstalled = new WeakSet()
  // agent -> pending ask_user_question (微信通道抢答瀑布)
  const pendingQuestions = new WeakMap()

  function conversationIdOf(agent) {
    for (const [conversationId, entry] of conversations) {
      if (entry.agent === agent) return conversationId
    }
    return undefined
  }

  function selectedModel() {
    const def = ctx.get('agentDefaultModel').currentSelection()
    return {
      provider: config.provider ?? def.provider,
      model: config.model ?? def.model,
    }
  }

  function resolveNewCwd() {
    const registry = ctx.get('workspaceRegistry')
    const workspaces = typeof registry?.list === 'function' ? registry.list() : []
    const configured = config.cwd
    if (configured && !isInstallDir(configured)) {
      try {
        if (statSync(configured).isDirectory()) return configured
      } catch {
        /* 配置路径不可用，继续往下找 */
      }
    }
    const mobilWs = workspaces.find((ws) => ws?.path && (/[\\/]mobil$/i.test(ws.path) || ws.title === 'mobil'))
    if (mobilWs?.path) return mobilWs.path
    const preferred = workspaces.find((ws) => ws?.path && !isInstallDir(ws.path))
    if (preferred?.path) return preferred.path
    try {
      if (statSync(FALLBACK_CWD).isDirectory()) return FALLBACK_CWD
    } catch {
      /* 默认工作区目录不存在 */
    }
    if (workspaces[0]?.path) return workspaces[0].path
    if (configured) return configured
    const cwd = process.cwd()
    return isInstallDir(cwd) ? FALLBACK_CWD : cwd
  }

  async function attachToWorkspace(sessionId, cwd) {
    const registry = ctx.get('workspaceRegistry')
    if (!registry || !cwd) return
    const knownIds = new Set(
      (typeof registry.list === 'function' ? registry.list() : []).map((ws) => ws.id),
    )
    let workspace
    try {
      workspace = await registry.resolveByPath(cwd)
    } catch (error) {
      ctx.logger.warn(
        `[dsh-weixin] resolveByPath 失败 cwd=${cwd}：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!workspace && typeof registry.create === 'function') {
      try {
        workspace = await registry.create(cwd)
        // create 会把新工作区 prepend 成当前项；打捞用的工作区必须追加，避免抢走 GUI 当前工作区。
        if (workspace && !knownIds.has(workspace.id) && typeof registry.insertBefore === 'function') {
          await registry.insertBefore(workspace.id)
        }
      } catch (error) {
        ctx.logger.warn(
          `[dsh-weixin] 无法为 cwd 创建工作区 ${cwd}：${error instanceof Error ? error.message : String(error)}`,
        )
        return
      }
    }
    if (!workspace) return
    try {
      await workspace.attachSession(sessionId)
    } catch (error) {
      ctx.logger.warn(
        `[dsh-weixin] attachSession ${sessionId} → ${workspace.path} 失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * 会话被归档后，durable archive set 会挡住它的每一轮：框架的 ArchivedSessionGate
   * 在 agent/pre-step 直接 reject，agent-loop 把它记成 turn/end reason=blocked，
   * **连 step/start 都不会写**。表现就是微信端「（无回复）」/「本轮被中断（blocked）」，
   * 而用户根本不知道发生了什么（GUI 上手动点了归档就再也回不来）。
   *
   * 这里在 resume/chat 之前主动把绑定会话从归档集里摘掉：unarchiveSession 幂等、
   * 不做存在性检查、只删一个 id，是最安全的恢复动作。
   */
  async function ensureNotArchived(sessionId, source) {
    const registry = ctx.get('workspaceRegistry')
    if (!registry || typeof registry.unarchiveSession !== 'function') return false
    let archived = false
    try {
      const ids = registry.archivedSessionIds
      archived = Array.isArray(ids) && ids.includes(String(sessionId))
    } catch {
      /* 读不到归档集时仍然尝试解归档（幂等，没有副作用） */
      archived = true
    }
    if (!archived) return false
    try {
      await registry.unarchiveSession(String(sessionId))
      ctx.logger.warn(`[dsh-weixin] 会话 ${sessionId} 曾被归档，已自动解归档（来源：${source}）`)
      return true
    } catch (error) {
      ctx.logger.warn(
        `[dsh-weixin] 解归档 ${sessionId} 失败（来源：${source}）：${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    }
  }

  async function salvageWeixinSessions() {
    const persistence = ctx.get('sessionPersistence')
    const agents = ctx.get('agents')
    if (typeof persistence?.list !== 'function') return
    const snaps = await persistence.list()
    for (const snap of snaps) {
      const id = snap?.header?.id
      const cwd = snap?.header?.cwd
      if (!id || !String(id).startsWith('weixin-') || !cwd) continue
      // 注意：这里**不**解归档。历史上被用户主动归档的旧 weixin 会话有十几个，
      // 全部拉回侧边栏属于越权。只对「当前绑定 / 正在聊天」的会话自愈，见
      // tryResume 与 weixinAgent.chat。
      await attachToWorkspace(id, cwd)
      const live = typeof agents?.get === 'function' ? agents.get(SessionId(String(id))) : undefined
      if (live) {
        installMutableSelection(live.ctx, live)
        await installDefaultPreset(live.ctx, live, true)
      }
    }
  }

  /**
   * 钉选路由不可用时换成能通的兜底路由，并留一条可追溯的日志。
   *
   * 两类不可用：① trae 明确不服务的模型（4001，100% 失败）；② 被显式列入
   * UNPROVEN_PROVIDERS 的 provider（当前为空集，见该常量处的取证）。两者都会让
   * 微信会话永久哑掉，因为 installMutableSelection 会把该路由强制到每一轮请求上。
   *
   * 注意「改写用户选择」本身也有代价：改写后的路由必须在这个宿主上**真实存在**，
   * 否则就从「模型不通」升级成 UNKNOWN_MODEL（见 TRAE_SAFE_ROUTE 的注释）。
   */
  function guardSelection(route, source) {
    const safe = sanitizeSelection(route, safeFallback(selectedModel()))
    const unproven = Boolean(route?.provider && UNPROVEN_PROVIDERS.has(route.provider))
    if (isUnserved(route) || unproven) {
      const why = isUnserved(route)
        ? '已被 trae 拒绝(4001)'
        : '在本通道从未成功跑过一次请求'
      ctx.logger.warn(
        `[dsh-weixin] 会话钉选的路由 ${route.provider}/${route.model} ${why}，` +
          `改用 ${safe.provider}/${safe.model}（来源：${source}）`,
      )
    }
    return safe
  }

  function selectionFromSession(agent) {
    const events = agent.session.snapshotEvents()
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event.type !== 'model/selection') continue
      const data = event.data
      if (!data?.provider || !data?.model) continue
      return guardSelection({
        provider: data.provider,
        model: data.model,
        ...(data.reasoningEffort === undefined ? {} : { reasoningEffort: data.reasoningEffort }),
      }, `model/selection seq=${event.seq}`)
    }
    const logged = agent.session.requestHeader()?.config
    if (logged?.provider && logged?.model) {
      return guardSelection({
        provider: logged.provider,
        model: logged.model,
        ...(logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort }),
      }, 'request/header')
    }
    return selectedModel()
  }

  function installMutableSelection(agentCtx, agent, initial) {
    if (!agentCtx || !agent) return undefined
    if (mutableInstalled.has(agent)) return undefined
    mutableInstalled.add(agent)
    let picked = initial ?? selectionFromSession(agent)
    const selection = {
      get current() {
        return picked
      },
      set current(next) {
        picked = next
      },
      assembled: undefined,
    }
    // prepend：盖住旧插件冻在 agent 上的 installModelSelection（waterfall 回程后写会覆盖后注册的监听）。
    const prepend = { prepend: true }
    agentCtx.on('session/event', (_session, event) => {
      if (event?.type !== 'model/selection') return
      const data = event.data
      if (!data?.provider || !data?.model) return
      picked = guardSelection({
        provider: data.provider,
        model: data.model,
        ...(data.reasoningEffort === undefined ? {} : { reasoningEffort: data.reasoningEffort }),
      }, `model/selection seq=${event.seq}`)
    })
    agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const selected = selection.current
      const assembled = await next()
      selection.assembled = selected
      if (selected === undefined) return assembled
      return {
        ...assembled,
        variables: {
          ...assembled.variables,
          provider: selected.provider,
          model: selected.model,
        },
      }
    }, prepend)
    agentCtx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      const selected = selection.assembled
      if (selected === undefined) return resolved
      const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
      return {
        ...withoutInheritedEffort,
        provider: selected.provider,
        model: selected.model,
        ...selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort },
      }
    }, prepend)
    agentCtx.on('agent/pre-step', async ({ agent: stepAgent, messages, signal, step }, next) => {
      // ⚠ 必须**在 next() 之前**解归档。ArchivedSessionGate 也是 agent/pre-step 的
      // 监听者，它在被调用时同步读 registry.archivedSessionIds 并直接 reject；
      // 本监听用 prepend 注册（插件最后挂载 ⇒ 排在队首），所以先 await 掉解归档，
      // 等 next() 走到那道门时归档集里已经没有这个 id 了，轮次才能正常开跑。
      // 放在 resume/chat 里不够：别的宿主会用陈旧的整份 state 覆盖回写，
      // 实测 08:05 解归档后 08:09 又被写回归档（190→189→193）。
      await ensureNotArchived(String(stepAgent.id), 'pre-step')
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      if (decision.messages.length === 0 && (step === 1 || messages.length > 0)) return decision
      const selected = selection.assembled
      const previous = stepAgent.session.requestHeader()?.config
      if (selected === undefined || previous === undefined || sameRoute(selected, previous)) return decision
      return { ...decision, messages: [...decision.messages, modelSwitchNotice(previous, selected)] }
    }, prepend)
    return selection
  }

  async function resolvePresetId() {
    const presets = ctx.get('agentPresets')
    if (typeof presets?.resolve !== 'function') return undefined
    try {
      const resolved = await presets.resolve()
      return resolved?.id
    } catch (error) {
      ctx.logger.warn(
        `[dsh-weixin] 解析默认 preset 失败：${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }

  /**
   * assemble 用的同一条 visibility 路径：tools.schemas(agent)。
   * 只打工具名，不打 schema 正文。
   */
  function logVisibleTools(agentCtx, agent) {
    try {
      const tools = agentCtx.get('tools')
      if (!tools || typeof tools.schemas !== 'function') {
        ctx.logger.warn(`[dsh-weixin] tools.schemas 不可用 session=${agent.id}`)
        return
      }
      const names = tools.schemas(agent).map((schema) => schema.name)
      const coding = ['pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'bash']
      const present = coding.filter((name) => names.includes(name))
      ctx.logger.warn(
        `[dsh-weixin] 可见工具 session=${agent.id} count=${names.length} coding=[${present.join(',') || '-'}] names=${names.join(',')}`,
      )
    } catch (error) {
      ctx.logger.warn(
        `[dsh-weixin] 列举可见工具失败 ${agent.id}：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * 把默认 Agent Preset（cordis）挂到微信自建/打捞的 agent 上。
   * create/resume 的 setup 走 mount（agent 尚未发布）；已经 live 的走 recompose，
   * 才会 emit tools/change。select() 对已开过轮次的会话会 locked，这里不用。
   */
  async function installDefaultPreset(agentCtx, agent, live) {
    const presets = ctx.get('agentPresets')
    if (!presets || !agentCtx || !agent) return
    if (presetInstalled.has(agent)) return
    const already = typeof presets.composedPreset === 'function' ? presets.composedPreset(agentCtx) : undefined
    if (already) {
      presetInstalled.add(agent)
      ctx.logger.warn(`[dsh-weixin] preset 已在位 ${agent.id} → ${already}`)
      logVisibleTools(agentCtx, agent)
      return
    }
    const presetId = await resolvePresetId()
    try {
      let mounted
      if (live && typeof presets.recompose === 'function') {
        mounted = await presets.recompose(agentCtx, presetId)
      } else if (typeof presets.mount === 'function') {
        mounted = await presets.mount(agentCtx, presetId)
      } else {
        return
      }
      presetInstalled.add(agent)
      const id = mounted?.id ?? presetId ?? presets.composedPreset?.(agentCtx)
      ctx.logger.warn(`[dsh-weixin] 已挂载 preset=${id ?? '?'} session=${agent.id} live=${Boolean(live)}`)
      logVisibleTools(agentCtx, agent)
    } catch (error) {
      ctx.logger.warn(
        `[dsh-weixin] 挂载默认 preset 失败 ${agent.id}：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async function findAdoptableSession(boundIds) {
    const persistence = ctx.get('sessionPersistence')
    if (typeof persistence?.list !== 'function') return undefined
    const snaps = await persistence.list()
    const candidates = []
    for (const snap of snaps) {
      const id = snap?.header?.id
      if (!id || !String(id).startsWith('weixin-')) continue
      if (boundIds.has(String(id))) continue
      candidates.push(snap)
    }
    candidates.sort((a, b) => Number(b.header?.createdAt ?? 0) - Number(a.header?.createdAt ?? 0))
    return candidates[0]?.header?.id
  }

  async function rememberAgent(conversationId, agent, dispose, ownedByHost) {
    const cwd = agent.session.header.cwd
    await attachToWorkspace(agent.id, cwd)
    bindConversation(conversationId, String(agent.id))
    const entry = { agent, dispose, ownedByHost: Boolean(ownedByHost) }
    conversations.set(conversationId, entry)
    return entry
  }

  async function resumeOrCreate(conversationId) {
    const agents = ctx.get('agents')
    const map = loadConversationMap()
    const boundId = map[conversationId]
    const boundIds = new Set(Object.values(map).map(String))

    async function tryResume(sessionId) {
      await ensureNotArchived(String(sessionId), 'resume')
      const live = agents.get(SessionId(String(sessionId)))
      if (live) {
        installMutableSelection(live.ctx, live)
        await installDefaultPreset(live.ctx, live, true)
        return rememberAgent(conversationId, live, async () => {}, true)
      }
      try {
        const handle = await agents.resume({
          resumeSessionId: SessionId(String(sessionId)),
          agentOptions: selectedModel(),
          setup: async (agentCtx, agent) => {
            installMutableSelection(agentCtx, agent)
            await installDefaultPreset(agentCtx, agent, false)
          },
        })
        await handle.agent.whenIdle()
        return rememberAgent(conversationId, handle.agent, handle.dispose, false)
      } catch (error) {
        ctx.logger.warn(
          `[dsh-weixin] resume ${sessionId} 失败：${error instanceof Error ? error.message : String(error)}`,
        )
        return undefined
      }
    }

    if (boundId) {
      const resumed = await tryResume(boundId)
      if (resumed) return resumed
      unbindConversation(conversationId)
    } else {
      const adoptable = await findAdoptableSession(boundIds)
      if (adoptable) {
        const resumed = await tryResume(adoptable)
        if (resumed) return resumed
      }
    }

    const selection = guardSelection(selectedModel(), 'agent-default-model')
    const meta = { cwd: resolveNewCwd() }
    const presetId = await resolvePresetId()
    if (presetId) meta.agentPreset = presetId
    const handle = await agents.create({
      sessionId: SessionId(`weixin-${randomUUID()}`),
      meta,
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (agentCtx, agent) => {
        installMutableSelection(agentCtx, agent)
        await installDefaultPreset(agentCtx, agent, false)
      },
    })
    await handle.agent.whenIdle()
    return rememberAgent(conversationId, handle.agent, handle.dispose, false)
  }

  async function ensureAgent(conversationId) {
    const existing = conversations.get(conversationId)
    if (existing) return existing
    const pending = inflight.get(conversationId)
    if (pending) return pending
    const task = resumeOrCreate(conversationId).finally(() => {
      inflight.delete(conversationId)
    })
    inflight.set(conversationId, task)
    return task
  }

  async function warmResumeBoundSessions() {
    const map = loadConversationMap()
    const ids = Object.entries(map)
    if (ids.length === 0) return
    for (const [conversationId, sessionId] of ids) {
      if (!conversationId || !sessionId) continue
      try {
        const entry = await ensureAgent(String(conversationId))
        ctx.logger.warn(
          `[dsh-weixin] 预热绑定会话 ${conversationId} → ${entry?.agent?.id ?? sessionId}`,
        )
      } catch (error) {
        ctx.logger.warn(
          `[dsh-weixin] 预热绑定会话失败 ${conversationId} → ${sessionId}：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  void salvageWeixinSessions()
    .then(() => warmResumeBoundSessions())
    .catch((error) => {
      ctx.logger.warn(
        `[dsh-weixin] 打捞/预热 weixin 会话失败：${error instanceof Error ? error.message : String(error)}`,
      )
    })

  // prepend：抢在 GUI 的 user-questions/request 之前。只处理本插件跟踪的
  // weixin agent；其它会话（含本 GUI 会话）仍 next() 给卡片。
  ctx.on('user-questions/request', async function (request, next) {
    const agent = request?.agent
    if (!agent || conversationIdOf(agent) === undefined) return next()
    const questions = request.questions ?? []
    if (questions.length === 0) return next()
    const existing = pendingQuestions.get(agent)
    if (existing) {
      try { existing.reject(new Error('replaced by a newer weixin question')) } catch { /* ignore */ }
    }
    const pending = Promise.withResolvers()
    pendingQuestions.set(agent, {
      questions,
      resolve: pending.resolve,
      reject: pending.reject,
    })
    ctx.logger.warn(
      `[dsh-weixin] 拦截 ask_user_question session=${agent.id} questions=${questions.length}`,
    )
    const abort = () => {
      if (pendingQuestions.get(agent)?.resolve === pending.resolve) pendingQuestions.delete(agent)
      pending.reject(request.signal?.reason ?? new Error('ask_user_question aborted'))
    }
    if (request.signal?.aborted) {
      abort()
    } else {
      request.signal?.addEventListener?.('abort', abort, { once: true })
    }
    try {
      return await pending.promise
    } finally {
      request.signal?.removeEventListener?.('abort', abort)
      if (pendingQuestions.get(agent)?.resolve === pending.resolve) {
        pendingQuestions.delete(agent)
      }
    }
  }, { prepend: true, global: true })

  function summarizeProgress(events) {
    const toolCalls = []
    let steps = 0
    for (const ev of events) {
      if (ev.type === 'step/start') steps++
      if (ev.type === 'tool/call') {
        const toolName = ev.tool?.name || ev.name || 'tool'
        toolCalls.push(toolName)
      }
    }
    const lastTool = toolCalls.length ? toolCalls[toolCalls.length - 1] : ''
    return { steps, toolCalls, lastTool }
  }

  function waitQuestionOrIdle(agent, idle, firstSeq) {
    if (pendingQuestions.has(agent)) return Promise.resolve('question')
    return new Promise((resolve) => {
      let settled = false
      const startTime = Date.now()
      let lastReportSec = 0
      const finish = (outcome) => {
        if (settled) return
        settled = true
        clearInterval(timer)
        const totalSec = Math.round((Date.now() - startTime) / 1000)
        if (totalSec >= 5) {
          ctx.logger.info(`[dsh-weixin] [长任务完成] session=${agent.id} 总耗时 ${totalSec}s 结果=${outcome}`)
        }
        resolve(outcome)
      }
      const timer = setInterval(() => {
        if (pendingQuestions.has(agent)) {
          finish('question')
          return
        }
        const elapsedSec = Math.floor((Date.now() - startTime) / 1000)
        if (elapsedSec >= 10 && elapsedSec - lastReportSec >= 10) {
          lastReportSec = elapsedSec
          try {
            const evs = typeof firstSeq === 'number' ? agent.session.snapshotEvents(firstSeq) : []
            const prog = summarizeProgress(evs)
            ctx.logger.warn(
              `[dsh-weixin] [长任务进行中] session=${agent.id} 耗时 ${elapsedSec}s, 步数=${prog.steps}, 最新工具=${prog.lastTool || '思考中...'}`,
            )
          } catch {
            ctx.logger.warn(`[dsh-weixin] [长任务进行中] session=${agent.id} 耗时 ${elapsedSec}s`)
          }
        }
      }, 100)
      idle.then(() => finish('idle'), () => finish('idle'))
    })
  }

  function questionPrompt(agent) {
    const pending = pendingQuestions.get(agent)
    return pending
      ? formatWeixinQuestions(pending.questions)
      : '【需要你选择】请直接回复选项字母。'
  }

  function withQuestionPrompt(agent, firstSeq, alreadyInTurn = false) {
    const base = buildChatResponse(agent, firstSeq, alreadyInTurn)
    const prompt = questionPrompt(agent)
    const prior = base.text && base.text !== '（无回复）' ? base.text : ''
    const text = [prior, prompt].filter(Boolean).join('\n\n')
    return { ...base, text }
  }

  function buildChatResponse(agent, firstSeq, alreadyInTurn = false) {
    const texts = collectAssistantTexts(agent.session.snapshotEvents(), firstSeq, alreadyInTurn)
    const { text, files, missing, locked } = extractOutboundFiles(texts.join('\n\n'))
    const lastText = texts.length ? texts[texts.length - 1] : ''
    const plainLast = extractOutboundFiles(lastText)
    let reply = plainLast.text || text
    if (missing.length) {
      reply = `${reply}\n（以下文件不存在，未发送：${missing.join('、')}）`.trim()
    }
    if (locked && locked.length) {
      reply = `${reply}\n（以下文件被外部进程占用/独占写锁，未发送：${locked.join('、')}）`.trim()
    }
    const response = { text: reply || (files.length ? '' : '（无回复）') }
    if (!reply && !files.length) {
      const failures = collectTurnFailures(agent.session.snapshotEvents(), firstSeq)
      if (failures.length) {
        const first = failures[0]
        response.text = `模型调用失败：${first}`
        ctx.logger.warn(`[dsh-weixin] 本轮无 assistant 文本，回传错误原因：${first}`)
      }
    }
    if (files.length) {
      const chosen = files[0]
      response.media = {
        type: mediaKind(chosen),
        url: chosen,
        fileName: basename(chosen),
      }
      if (files.length > 1) {
        const others = files.slice(1).map((f) => basename(f)).join('、')
        response.text = (
          (response.text ? `${response.text}\n\n` : '') +
          `📎 [多文件提示] 本次已发送首个文件「${basename(chosen)}」；微信通道单次仅支持推送 1 个文件，其余 ${files.length - 1} 个文件（${others}）已就绪。如需获取请回复提示我。`
        ).trim()
      }
      ctx.logger.warn(
        `[dsh-weixin] 出站文件推送 → ${chosen}` +
          (files.length > 1 ? `（另有 ${files.length - 1} 个未发送，单条只发一个）` : ''),
      )
    }
    return response
  }

  const weixinAgent = {
    async chat(request) {
      try {
        const rawUserText = String(request.text ?? '')
        const userText = rawUserText.trim()
        const hasMedia = Boolean(request.media?.filePath)

        // 门禁：纯空请求/空心跳直接拦截（防止产生 0-turn 空白会话）
        if (!userText && !hasMedia) {
          const waiting = conversations.get(request.conversationId)
            ? pendingQuestions.get(conversations.get(request.conversationId).agent)
            : null
          if (waiting) {
            return { text: formatWeixinQuestions(waiting.questions) }
          }
          ctx.logger.info(`[dsh-weixin] 拦截到纯空请求 conversationId=${request.conversationId}，忽略并不产生空白会话`)
          return { text: '' }
        }

        const { agent } = await ensureAgent(request.conversationId)
        const firstSeq = agent.session.seq
        // 归档会在 agent/pre-step 直接 reject（turn/end=blocked，连 step/start 都没有），
        // 每轮开跑前先确认没被归档，用户手动点了归档也能自愈。
        await ensureNotArchived(String(agent.id), 'chat')
        // 钉选路由可能在本轮之前就被改过（比如宿主把 4001 路由换掉），
        // 请求前再校验一次，避免又发一轮注定 4001 的请求。
        const active = guardSelection(selectionFromSession(agent), 'chat 前置校验')
        const selection = installMutableSelection(agent.ctx, agent, active)
        if (selection) selection.current = active
        const waiting = pendingQuestions.get(agent)

        if (waiting) {
          if (!userText.trim()) {
            return { text: formatWeixinQuestions(waiting.questions) }
          }
          const parsed = parseWeixinAnswers(userText, waiting.questions)
          if (parsed) {
            waiting.resolve(parsed)
            if (pendingQuestions.get(agent) === waiting) pendingQuestions.delete(agent)
            ctx.logger.warn(
              `[dsh-weixin] 微信作答 ask_user_question session=${agent.id} text=${userText.slice(0, 80)}`,
            )
            const idle = agent.whenIdle()
            const outcome = await waitQuestionOrIdle(agent, idle, firstSeq)
            await idle.catch(() => {})
            if (outcome === 'question' || pendingQuestions.has(agent)) {
              ctx.logger.warn(`[dsh-weixin] 题面提前回微信 session=${agent.id}`)
              return withQuestionPrompt(agent, firstSeq, true)
            }
            return buildChatResponse(agent, firstSeq, true)
          }
        }

        // ── 入站：媒体归档 + 注入说明，文本原样跟随 ──
        const blocks = []
        if (request.media?.filePath) {
          let saved = request.media.filePath
          let archived = false
          try {
            saved = archiveInboundMedia(request.media, config.inboxDir)
            archived = true
          } catch (error) {
            ctx.logger.warn(
              `[dsh-weixin] 入站媒体归档失败：${error instanceof Error ? error.message : String(error)}`,
            )
          }
          blocks.push({ type: 'text', text: mediaNotice(request.media, saved, archived) })
          ctx.logger.warn(
            `[dsh-weixin] 收到入站媒体 type=${request.media.type} → ${saved}`,
          )
        }
        blocks.push({
          type: 'text',
          text: userText
            ? `${userText}\n\n${SEND_FILE_HINT}\n\n${TEXT_OPTION_HINT}`
            : `${SEND_FILE_HINT}\n\n${TEXT_OPTION_HINT}`,
        })

        agent.followup(createUserMessage({
          content: blocks,
          source: { kind: 'user' },
        }))

        const idle = agent.whenIdle()
        const outcome = await waitQuestionOrIdle(agent, idle, firstSeq)
        await idle.catch(() => {})
        if (outcome === 'question' || pendingQuestions.has(agent)) {
          ctx.logger.warn(`[dsh-weixin] 题面提前回微信 session=${agent.id}`)
          return withQuestionPrompt(agent, firstSeq)
        }
        return buildChatResponse(agent, firstSeq)
      } catch (error) {
        return { text: `错误：${error instanceof Error ? error.message : String(error)}` }
      }
    },
    clearSession(conversationId) {
      const entry = conversations.get(conversationId)
      if (entry) {
        if (!entry.ownedByHost) void entry.dispose()
        conversations.delete(conversationId)
      }
      unbindConversation(conversationId)
    },
  }

  ctx.effect(() => {
    if (!isLoggedIn()) {
      ctx.logger.warn(
        '[dsh-weixin] 未检测到微信登录凭证。请先运行 `npx weixin-acp login` 扫码登录，然后重启 DSH。',
      )
      return
    }

    let stopped = false
    let controller
    let loggedYield = false

    function tryTakeOver() {
      if (stopped) return
      if (controller) {
        // 已被更高优先级宿主抢占：立即停止轮询，避免两边同时消费消息。
        if (readLock()?.pid !== process.pid) {
          ctx.logger.warn('[dsh-weixin] 微信通道所有权已移交其它宿主，本实例停止轮询。')
          const lost = controller
          controller = undefined
          lost.abort()
          return
        }
        heartbeatLock()
        return
      }
      if (!acquireLock()) {
        if (!loggedYield) {
          loggedYield = true
          const owner = readLock()
          ctx.logger.warn(
            `[dsh-weixin] 微信通道已由另一个 DSH 宿主接管(pid=${owner?.pid ?? '?'})，` +
              '本实例待命，不重复轮询（避免抢消息）。',
          )
        }
        return
      }
      loggedYield = false
      controller = new AbortController()
      ctx.logger.warn(`[dsh-weixin] 本宿主(pid=${process.pid})接管微信通道，开始轮询。`)
      start(weixinAgent, { abortSignal: controller.signal })
        .catch((error) => {
          ctx.logger.error('[dsh-weixin] 微信消息循环退出：', error)
        })
        .finally(() => {
          controller = undefined
          releaseLock()
        })
    }

    tryTakeOver()
    const timer = setInterval(tryTakeOver, HEARTBEAT_MS)
    timer.unref?.()


    // =========================================================================
    // Web 设置页与连接管理 (dsh-weixin-plus UI + RPC + HTTP)
    // =========================================================================
    {
      const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com'
      const BOT_TYPE = '3'
      const openclawDir = join(homedir(), '.openclaw', 'openclaw-weixin')
      const accountsDir = join(openclawDir, 'accounts')
      const indexFile = join(openclawDir, 'accounts.json')

      let QRCode
      try {
        const req = createRequire(import.meta.url)
        QRCode = req('qrcode')
      } catch {
        try {
          const req2 = createRequire(join(DSH_HOME, 'profiles', 'desktop', 'package.json'))
          QRCode = req2('qrcode')
        } catch (err) {
          ctx.logger?.warn?.('[dsh-weixin-plus] qrcode module not loaded:', err?.message)
        }
      }

      let activeLogin = null

      function normalizeAccountId(raw) {
        return String(raw || '').trim().toLowerCase().replace(/[@.]/g, '-')
      }

      function getSavedAccounts() {
        try {
          if (!existsSync(indexFile)) return []
          const content = readFileSync(indexFile, 'utf8')
          const ids = JSON.parse(content)
          if (!Array.isArray(ids)) return []
          return ids.map((id) => {
            const file = join(accountsDir, `${id}.json`)
            let data = {}
            if (existsSync(file)) {
              try {
                data = JSON.parse(readFileSync(file, 'utf8'))
              } catch {}
            }
            return {
              accountId: id,
              savedAt: data.savedAt,
              userId: data.userId,
              baseUrl: data.baseUrl,
              hasToken: Boolean(data.token),
            }
          })
        } catch {
          return []
        }
      }

      function randomWechatUin() {
        const uint32 = randomBytes(4).readUInt32BE(0)
        return Buffer.from(String(uint32), 'utf-8').toString('base64')
      }

      async function checkLiveToken(accountId) {
        try {
          const file = join(accountsDir, `${accountId}.json`)
          if (!existsSync(file)) return { connected: false, reason: 'no_account_file' }
          const data = JSON.parse(readFileSync(file, 'utf8'))
          if (!data.token) return { connected: false, reason: 'no_token' }

          const baseUrl = (data.baseUrl || FIXED_BASE_URL).replace(/\/+$/, '')
          const url = `${baseUrl}/ilink/bot/getupdates`

          const ac = new AbortController()
          const timer = setTimeout(() => ac.abort(), 2500)

          try {
            const res = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                AuthorizationType: 'ilink_bot_token',
                Authorization: `Bearer ${data.token}`,
                'X-WECHAT-UIN': randomWechatUin(),
              },
              body: JSON.stringify({
                get_updates_buf: '',
                base_info: { channel_version: '1.0.2' },
              }),
              signal: ac.signal,
            })
            clearTimeout(timer)
            if (!res.ok) return { connected: false, reason: `http_${res.status}` }
            const json = await res.json()
            const errcode = json.errcode ?? json.ret ?? 0
            if (errcode === -14) {
              return {
                connected: false,
                expired: true,
                errcode: -14,
                errmsg: json.errmsg || 'session timeout',
                reason: 'session_expired',
              }
            }
            if (errcode !== 0) {
              return {
                connected: false,
                expired: false,
                errcode,
                errmsg: json.errmsg || 'error',
                reason: `errcode_${errcode}`,
              }
            }
            return { connected: true, expired: false, errcode: 0 }
          } catch (err) {
            clearTimeout(timer)
            if (err && err.name === 'AbortError') {
              return { connected: true, expired: false, errcode: 0, note: 'long_poll_active' }
            }
            return { connected: false, reason: err?.message || 'fetch_error' }
          }
        } catch (err) {
          return { connected: false, reason: err?.message || 'unknown_error' }
        }
      }

      function saveAccountCredentials(accountId, creds) {
        mkdirSync(accountsDir, { recursive: true })
        const file = join(accountsDir, `${accountId}.json`)
        let existing = {}
        if (existsSync(file)) {
          try {
            existing = JSON.parse(readFileSync(file, 'utf8'))
          } catch {}
        }
        const next = {
          ...existing,
          token: creds.botToken,
          baseUrl: creds.baseUrl || FIXED_BASE_URL,
          userId: creds.userId || existing.userId,
          savedAt: new Date().toISOString(),
        }
        writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')

        let ids = []
        if (existsSync(indexFile)) {
          try {
            ids = JSON.parse(readFileSync(indexFile, 'utf8'))
            if (!Array.isArray(ids)) ids = []
          } catch {}
        }
        if (!ids.includes(accountId)) {
          ids.unshift(accountId)
          writeFileSync(indexFile, JSON.stringify(ids, null, 2), 'utf8')
        }
      }

      async function startScanLogin() {
        if (activeLogin && activeLogin.abortController) {
          try {
            activeLogin.abortController.abort()
          } catch {}
        }
        const abortController = new AbortController()
        const loginState = {
          qrcode: null,
          url: null,
          qrPngBase64: null,
          status: 'starting',
          abortController,
          error: null,
          accountId: null,
          createdAt: Date.now(),
        }
        activeLogin = loginState

        ;(async () => {
          try {
            const qrUrl = `${FIXED_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`
            const res = await fetch(qrUrl, { signal: abortController.signal })
            if (!res.ok) throw new Error(`获取二维码失败: HTTP ${res.status}`)
            const qrData = await res.json()
            if (!qrData.qrcode || !qrData.qrcode_img_content) {
              throw new Error('接口未返回有效二维码数据')
            }
            loginState.qrcode = qrData.qrcode
            loginState.url = qrData.qrcode_img_content
            loginState.status = 'waiting_scan'

            if (QRCode) {
              try {
                loginState.qrPngBase64 = await QRCode.toDataURL(qrData.qrcode_img_content, {
                  width: 280,
                  margin: 2,
                })
              } catch {}
            }

            const deadline = Date.now() + 5 * 60 * 1000
            while (Date.now() < deadline && !abortController.signal.aborted) {
              const statusUrl = `${FIXED_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(loginState.qrcode)}`
              const pollAc = new AbortController()
              const timer = setTimeout(() => pollAc.abort(), 35000)
              const onAbort = () => pollAc.abort()
              abortController.signal.addEventListener('abort', onAbort, { once: true })

              let statusRes
              try {
                statusRes = await fetch(statusUrl, {
                  headers: { 'iLink-App-ClientVersion': '1' },
                  signal: pollAc.signal,
                })
              } catch (err) {
                clearTimeout(timer)
                abortController.signal.removeEventListener('abort', onAbort)
                if (abortController.signal.aborted) return
                await new Promise((r) => setTimeout(r, 1500))
                continue
              }
              clearTimeout(timer)
              abortController.signal.removeEventListener('abort', onAbort)

              if (!statusRes.ok) {
                await new Promise((r) => setTimeout(r, 1500))
                continue
              }

              const statusData = await statusRes.json()
              const st = statusData.status
              if (st === 'wait') {
                loginState.status = 'waiting_scan'
              } else if (st === 'scaned') {
                loginState.status = 'scanned'
              } else if (st === 'expired') {
                loginState.status = 'expired'
                return
              } else if (st === 'confirmed') {
                if (!statusData.bot_token || !statusData.ilink_bot_id) {
                  loginState.status = 'failed'
                  loginState.error = '确认成功但缺少 bot_token'
                  return
                }
                const normalizedId = normalizeAccountId(statusData.ilink_bot_id)
                saveAccountCredentials(normalizedId, {
                  botToken: statusData.bot_token,
                  baseUrl: statusData.baseurl || FIXED_BASE_URL,
                  userId: statusData.ilink_user_id,
                })
                loginState.accountId = normalizedId
                loginState.status = 'success'
                setTimeout(() => {
                  try {
                    if (controller) {
                      const old = controller
                      controller = undefined
                      old.abort()
                    }
                    tryTakeOver()
                  } catch {}
                }, 200)
                return
              }
              await new Promise((r) => setTimeout(r, 1000))
            }

            if (!abortController.signal.aborted && loginState.status !== 'success') {
              loginState.status = 'expired'
            }
          } catch (err) {
            if (abortController.signal.aborted) {
              loginState.status = 'cancelled'
            } else {
              loginState.status = 'failed'
              loginState.error = err?.message || String(err)
            }
          }
        })()

        return loginState
      }

      function cancelScanLogin() {
        if (activeLogin) {
          if (activeLogin.abortController) {
            try {
              activeLogin.abortController.abort()
            } catch {}
          }
          activeLogin.status = 'cancelled'
          activeLogin = null
          return { cancelled: true }
        }
        return { cancelled: false }
      }

      function doLogout(targetAccountId) {
        try {
          const accounts = getSavedAccounts()
          const idToClear = targetAccountId || (accounts[0] && accounts[0].accountId)
          if (!idToClear) return { ok: true, message: '当前无已绑定账号' }

          const file = join(accountsDir, `${idToClear}.json`)
          if (existsSync(file)) unlinkSync(file)

          const syncBufFile = join(accountsDir, `${idToClear}.sync.json`)
          if (existsSync(syncBufFile)) unlinkSync(syncBufFile)

          if (existsSync(indexFile)) {
            try {
              const ids = JSON.parse(readFileSync(indexFile, 'utf8'))
              if (Array.isArray(ids)) {
                const nextIds = ids.filter((x) => x !== idToClear)
                writeFileSync(indexFile, JSON.stringify(nextIds, null, 2), 'utf8')
              }
            } catch {}
          }
          if (controller) {
            const old = controller
            controller = undefined
            old.abort()
          }
          return { ok: true, clearedAccountId: idToClear }
        } catch (err) {
          return { ok: false, error: err?.message || String(err) }
        }
      }

      async function handleAction(action, payload = {}) {
        if (action === 'status') {
          const accounts = getSavedAccounts()
          let liveStatus = { connected: false, reason: 'no_accounts' }
          if (accounts.length > 0) {
            liveStatus = await checkLiveToken(accounts[0].accountId)
          }
          const owner = readLock()
          let activeScan = null
          if (activeLogin) {
            activeScan = {
              status: activeLogin.status,
              qrcode: activeLogin.qrcode,
              url: activeLogin.url,
              qrPngBase64: activeLogin.qrPngBase64,
              error: activeLogin.error,
              accountId: activeLogin.accountId,
              createdAt: activeLogin.createdAt,
            }
          }
          return {
            ok: true,
            accounts,
            live: liveStatus,
            lockOwnerPid: owner?.pid ?? null,
            currentPid: process.pid,
            isPollingOwner: Boolean(controller),
            activeScan,
          }
        }

        if (action === 'start-scan') {
          if (
            activeLogin &&
            (activeLogin.status === 'waiting_scan' || activeLogin.status === 'scanned') &&
            !payload.force
          ) {
            // keep current
          } else {
            cancelScanLogin()
            await startScanLogin()
          }
          for (let i = 0; i < 25; i++) {
            if (activeLogin?.qrcode || activeLogin?.status === 'failed') break
            await new Promise((r) => setTimeout(r, 100))
          }
          return {
            ok: true,
            activeScan: activeLogin
              ? {
                  status: activeLogin.status,
                  qrcode: activeLogin.qrcode,
                  url: activeLogin.url,
                  qrPngBase64: activeLogin.qrPngBase64,
                  error: activeLogin.error,
                }
              : null,
          }
        }

        if (action === 'cancel-scan') {
          return { ok: true, ...cancelScanLogin() }
        }

        if (action === 'logout') {
          cancelScanLogin()
          return doLogout(payload.accountId)
        }

        return { ok: false, error: 'unknown_action' }
      }

      // 1. 注册 Cordis Connection RPC 通道（天然免 403，兼容斜杠/无斜杠前缀，标准 bad-request 错误信封）
      ctx.inject(['connection'], (innerCtx) => {
        const rpcHandler = async (actionOrEndpoint, payloadOrEmpty = {}) => {
          try {
            let act = actionOrEndpoint
            let payload = payloadOrEmpty || {}
            if (typeof act === 'string' && act.startsWith('/')) {
              act = act.replace(/^\/+/, '')
            }
            const res = await handleAction(act, payload)
            return { ok: true, value: res }
          } catch (err) {
            return {
              ok: false,
              error: {
                code: 'bad-request',
                message: err?.message || String(err),
                details: { issues: [{ message: err?.message || String(err) }] }
              }
            }
          }
        }
        innerCtx.connection.rpc.handle('/dsh-weixin-plus', rpcHandler)
        innerCtx.connection.rpc.handle('dsh-weixin-plus', rpcHandler)
      })

      // 2. 同时提供 HTTP 路由作为备用诊断接口
      ctx.inject(['webServer'], (innerCtx) => {
        return innerCtx.webServer.register({
          path: '/dsh-weixin-plus',
          authority: 'public',
          handler: async (req, res) => {
            const urlObj = new URL(req.url || '/', 'http://127.0.0.1')
            const sub = urlObj.pathname.replace(/^\/dsh-weixin-plus\/?/, '') || 'status'
            let body = {}
            if (req.method === 'POST') {
              try {
                const chunks = []
                for await (const chunk of req) chunks.push(chunk)
                if (chunks.length > 0) body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              } catch {}
            }
            const result = await handleAction(sub, body)
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(result))
          },
        })
      })
    }

    return () => {
      stopped = true
      clearInterval(timer)
      if (controller) controller.abort()
      controller = undefined
      releaseLock()
      for (const entry of conversations.values()) {
        if (!entry.ownedByHost) void entry.dispose()
      }
      conversations.clear()
    }
  })
}

