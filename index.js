/**
 * dsh-voice-stream —— 边说边出字的本地语音输入（宿主侧）。
 *
 * ── 它解决什么问题 ──────────────────────────────────────────────────────
 *
 * 官方 `dsh-experimental-voice-input` 是「整段录音 → 一次性识别」：
 * 必须说完、按停止、等结果。说一大段之后往回看很麻烦，而且说错了当场
 * 看不到。这个插件换成「累积重解码」：说话过程中每 `stepMs` 把
 * 「从这句开始到现在的全部音频」重新识别一遍，把结果推给浏览器覆盖草稿。
 *
 * ── 为什么是「重解码」而不是真流式 ───────────────────────────────────────
 *
 * SenseVoice 是离线模型，没有增量状态。但实测（i7-12700H，4 线程）：
 *
 *     音频长度   重解码耗时
 *      0.8s        40ms
 *      1.6s        64ms
 *      3.2s        97ms
 *      5.6s       165ms
 *
 * 耗时远低于音频时长，所以每 800ms 全量重解一次，用户感觉不到延迟，
 * 而文字会「逐渐长出来、逐渐变准」。这比接一个真正的流式模型简单得多：
 * 零额外模型、零显存、零 Python。
 *
 * ── 断句与定稿 ──────────────────────────────────────────────────────────
 *
 * 客户端用能量 VAD 检测静音；静音超过 `finalizeSilenceMs` 就发 `finalize`。
 * 宿主收到后：用整句音频跑一次完整识别（比过程中的增量结果更准），
 * 回 `final` 帧，然后清空缓冲区，下一句从头累积。
 *
 * 定稿这个动作**必须让用户看见**（客户端把麦克风图标变色/变形），
 * 否则用户不知道自己现在改字会不会被覆盖。
 *
 * ── 传输：WebSocket ────────────────────────────────────────────────────
 *
 * 音频是连续的流，HTTP POST 是一次性的，没法边发边收。所以用
 * `webServer.registerUpgrade()` 挂一条 WebSocket 路由。协议极简：
 *
 *   浏览器 → 宿主：二进制帧 = Float32 小端 PCM（16kHz 单声道）
 *                文本帧  = JSON 控制消息 {type:'start'|'finalize'|'stop'}
 *   宿主 → 浏览器：JSON {type:'partial'|'final'|'error', text}
 *
 * 为什么不用 `ctx.emit`：宿主和浏览器是两个进程，`ctx.emit` 只在宿主
 * 内部广播，客户端收不到。这一点 `dsh-tts-local` 的注释里已经踩过。
 *
 * ── 一个会话一个识别流 ──────────────────────────────────────────────────
 *
 * 每次 `start` 新建一个 `Session`（累积样本 + 上次结果），`stop` 丢弃。
 * 不做跨会话复用：识别流是易失状态，粘住反而会串音。
 *
 * @module dsh-voice-stream
 */

import z from '@deepseek-ai/schemastery'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** Cordis 插件名。 */
export const name = 'voice-stream'

/** 依赖：webServer 挂 WebSocket 路由。 */
export const inject = ['webServer']

/** 插件配置。 */
export const Config = z.object({
  /** 总开关。 */
  enabled: z.boolean().default(true),
  /**
   * SenseVoice 模型目录（含 model.int8.onnx 与 tokens.txt）。
   *
   * 留空时会自动在几个常见位置查找（见 resolveModelDir）：
   *   1. 环境变量 DSH_VOICE_STREAM_MODEL
   *   2. 当前实例的 $DSH_HOME/speech-to-text/sensevoice/models/sensevoice-onnx
   *   3. 用户主目录下的 ~/.dsh/speech-to-text/...（跨实例复用）
   *
   * 为什么需要自动查找：DSH 支持多实例，每个实例有独立的 DSH_HOME。
   * 用户在实例 A 下过模型、又想在实例 B 用，如果不自动找就要重复下
   * 228MB。留空 + 自动查找能省掉这个麻烦。
   */
  modelDir: z.string().default(''),
  /** 识别语言：auto / zh / en / yue / ja / ko。 */
  language: z.string().default('zh'),
  /** CPU 线程数。 */
  threads: z.natural().default(4),
  /** 每隔多少毫秒重解码一次。越小越流畅、CPU 越高。 */
  stepMs: z.natural().default(800),
  /** 客户端静音多少毫秒后定稿。 */
  finalizeSilenceMs: z.natural().default(1200),
  /**
   * 闲置多少毫秒没说话就自动收工。
   *
   * 用户点开麦克风后忘了关、或说完就走开时，自动停止录音并复位按钮，
   * 避免麦克风一直亮着、识别空转。默认 10 秒 —— 相当于连续 8 秒多
   * 完全没有说话（定稿静音已占 1.2 秒）。
   */
  idleMs: z.natural().default(10000),
  /** 单次识别最长音频秒数，超过就强制定稿，防止缓冲区无限长。 */
  maxSegmentSeconds: z.natural().default(30),
  /**
   * 定稿后排空在途音频的毫秒数。
   *
   * 客户端每 200ms 发一帧，定稿瞬间可能还有 1-2 帧在路上。这些音频
   * 属于上一句，若直接计入新 session，新句子开头会粘上旧尾巴。
   * 取 300ms 足够覆盖一个发送周期。
   */
  flushMs: z.natural().default(300),
  /**
   * 单帧字节上限。
   *
   * 客户端每 200ms 发一帧 16kHz Float32 ≈ 12.8KB。留到 1MB 足够宽松，
   * 同时能挡住恶意客户端用超长帧把宿主内存打爆。
   */
  maxFrameBytes: z.natural().default(1048576),
  /** 空闲多少毫秒后卸载模型；0 = 从不卸载。 */
  idleTimeoutMs: z.natural().default(300000),
})

/**
 * 加载 sherpa-onnx 与 SenseVoice 识别器。
 *
 * 延迟加载：插件挂载时不一定需要模型（用户可能只是开着界面不说话），
 * 真正开始录音时才加载。加载一次后缓存，空闲超时再释放。
 *
 * @param {object} options - 模型路径与线程数。
 * @returns {{recognize: (samples: Float32Array) => string, dispose: () => void}}
 */
function createRecognizer(options) {
  const require = createRequire(import.meta.url)
  const sherpa = require('sherpa-onnx-node')

  const config = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: join(options.modelDir, 'model.int8.onnx'),
        language: options.language,
        useInverseTextNormalization: 1,
      },
      // 注意：tokens 属于 modelConfig 顶层，不在 senseVoice 里面。
      // 写错位置会报 "tokens: '' does not exist"。
      tokens: join(options.modelDir, 'tokens.txt'),
      numThreads: options.threads,
      provider: 'cpu',
      debug: 0,
    },
  }

  const recognizer = new sherpa.OfflineRecognizer(config)

  return {
    /**
     * 识别一段 16kHz 单声道 Float32 音频。
     * @param {Float32Array} samples - 采样点，取值 [-1, 1]。
     * @returns {string} 识别文本，空串表示没听到语音。
     */
    recognize(samples) {
      if (samples.length === 0) return ''
      const stream = recognizer.createStream()
      stream.acceptWaveform({ samples, sampleRate: 16000 })
      recognizer.decode(stream)
      return recognizer.getResult(stream).text ?? ''
    },
    dispose() {
      // sherpa 没有显式 dispose；交给 GC。这里保留钩子以便未来替换引擎。
    },
  }
}

/**
 * 解析模型目录。
 *
 * 显式配置了 modelDir 就用它（不检查是否存在，交给调用方报错）；
 * 留空时按优先级自动查找：
 *
 *   1. 环境变量 `DSH_VOICE_STREAM_MODEL` —— 最高优先级，
 *      适合把模型放在网络盘、或在多个实例间共享同一份。
 *   2. 当前实例的 `$DSH_HOME/speech-to-text/sensevoice/models/sensevoice-onnx`
 *      —— 官方语音输入插件的默认位置。
 *   3. 用户主目录的 `~/.dsh/speech-to-text/...`
 *      —— 跨实例复用：在 A 实例下过模型，B 实例也能用。
 *
 * 为什么需要第 3 条：DSH 支持多实例，每个实例有独立的 DSH_HOME。
 * 不自动找的话，换个实例就要重下 228MB。
 *
 * @param {string} configured - 配置里的 modelDir（可能为空）。
 * @returns {string} 选定的目录（可能不存在，由调用方检查）。
 */
function resolveModelDir(configured) {
  if (configured !== '') return configured

  const candidates = []
  const fromEnv = process.env.DSH_VOICE_STREAM_MODEL
  if (typeof fromEnv === 'string' && fromEnv !== '') candidates.push(fromEnv)

  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') {
    candidates.push(join(home, 'speech-to-text', 'sensevoice', 'models', 'sensevoice-onnx'))
  }

  // 用户主目录下的默认位置（跨实例复用）。
  const userHome = process.env.USERPROFILE ?? process.env.HOME
  if (typeof userHome === 'string' && userHome !== '') {
    candidates.push(join(userHome, '.dsh', 'speech-to-text', 'sensevoice', 'models', 'sensevoice-onnx'))
  }

  // 返回第一个「确实有模型文件」的候选；都没有就返回第一个，
  // 让调用方的错误信息指向最可能的那个位置。
  for (const dir of candidates) {
    if (existsSync(join(dir, 'model.int8.onnx'))) return dir
  }
  return candidates[0] ?? ''
}

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {z.infer<typeof Config>} config - 配置。
 */
export function apply(ctx, config) {
  if (!config.enabled) {
    ctx.logger.info('voice-stream: disabled by config')
    return
  }

  const log = (msg) => ctx.logger.info(`voice-stream: ${msg}`)
  const warn = (msg) => ctx.logger.warn(`voice-stream: ${msg}`)

  // ── 模型文件检查 ────────────────────────────────────────────────────
  //
  // 在**挂载时**就检查，而不是等用户第一次按麦克风才发现。
  //
  // 为什么重要：DSH 支持多个实例（各自有独立的 DSH_HOME），而
  // `dshHomePath()` 解析的是**当前实例**的目录。用户从别的实例
  // 复制插件过来时，模型往往不在新实例的目录下 —— 如果等到录音
  // 时才报错，用户会以为是插件坏了，实际只是缺模型文件。
  //
  // 这里给出可操作的指引：缺哪个文件、去哪下、放哪。
  const modelDir = resolveModelDir(config.modelDir)
  if (!modelDir) {
    warn(
      '找不到模型目录。请设置 modelDir，或把模型放到 $DSH_HOME/speech-to-text/sensevoice/models/sensevoice-onnx/。\n' +
        '  也可以用环境变量 DSH_VOICE_STREAM_MODEL 指定一个共享位置。\n' +
        '  下载：https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    )
    return
  }
  const modelPath = join(modelDir, 'model.int8.onnx')
  const tokensPath = join(modelDir, 'tokens.txt')
  const missing = []
  if (!existsSync(modelPath)) missing.push('model.int8.onnx')
  if (!existsSync(tokensPath)) missing.push('tokens.txt')
  if (missing.length > 0) {
    warn(
      `模型文件缺失（${missing.join('、')}）。\n` +
        `  期望目录：${modelDir}\n` +
        `  下载地址：https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17\n` +
        `  需要文件：model.int8.onnx（228MB）与 tokens.txt（0.3MB）\n` +
        `  提示：每个 DSH 实例有独立的 DSH_HOME，模型不会自动共享。\n` +
        `  语音输入已禁用，但插件其余部分正常挂载。`,
    )
    return
  }

  // ── 配置交叉校验 ────────────────────────────────────────────────────
  //
  // idleMs 必须明显大于 finalizeSilenceMs，否则会出现这个诡异现象：
  // 用户说完停顿 → 静音计时还没到定稿时长，闲置计时先超时把整个
  // 录音关掉了 → 最后一句永远定不了稿、直接丢失。
  //
  // 不抛错（抛错会让整个插件挂载失败，用户更难排查），而是用局部
  // 变量把 idleMs 抬到安全值并警告。注意不要改 config 本身 ——
  // 那是调用方的对象，改它会产生难以追踪的副作用。
  let effectiveIdleMs = config.idleMs
  if (config.idleMs <= config.finalizeSilenceMs) {
    effectiveIdleMs = config.finalizeSilenceMs + 2000
    warn(
      `idleMs(${config.idleMs}) 必须大于 finalizeSilenceMs(${config.finalizeSilenceMs})，` +
        `否则最后一句会被丢弃。已临时提升到 ${effectiveIdleMs}ms。请修改配置。`,
    )
  }

  // ── 识别器：按需加载 + 空闲释放 ──────────────────────────────────────
  let engine = null
  let idleTimer = null

  const touch = () => {
    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (engine !== null) {
        engine.dispose()
        engine = null
        log('空闲超时，已释放识别模型')
      }
    }, config.idleTimeoutMs)
    idleTimer.unref?.()
  }

  const ensureEngine = () => {
    if (engine === null) {
      const started = Date.now()
      engine = createRecognizer({
        modelDir,
        language: config.language,
        threads: config.threads,
      })
      log(`识别模型已加载（${Date.now() - started}ms）`)
    }
    touch()
    return engine
  }

  ctx.effect(() => () => {
    if (idleTimer !== null) clearTimeout(idleTimer)
    engine?.dispose()
    engine = null
  })

  // ── 一次录音会话 ────────────────────────────────────────────────────
  /**
   * 一个识别会话：累积样本，按节奏重解码。
   *
   * 为什么累积而不是滑窗：断句后要从头开始，累积才能保证「这一句」
   * 的完整音频都在。内存代价可忽略（16kHz × 2 字节 × 30 秒 ≈ 960KB）。
   */
  class StreamSession {
    constructor(send) {
      this.send = send
      /** @type {Float32Array[]} 累积的音频块。 */
      this.chunks = []
      /** 累积采样点数。 */
      this.length = 0
      /** 上次推送的文本，用来避免无意义的重复帧。 */
      this.lastText = ''
      /** 定时器句柄。 */
      this.timer = null
      /** 是否已定稿（定稿后忽略迟到的音频）。 */
      this.done = false
      /**
       * 在此时间戳之前收到的音频直接丢弃。
       *
       * 定稿后新建 session 时设置，用来排空管道里在途的旧音频 ——
       * 否则新一句的开头会粘上上一句的尾巴。0 表示不丢弃任何音频。
       */
      this.dropUntil = 0
    }

    /**
     * 下一次重解码该等多久。
     *
     * 固定间隔有两个问题：太短则长句时 CPU 跑满（重解码耗时随音频长度
     * 线性增长），太长则短句时文字一段段蹦、没有打字感。
     *
     * 所以按「当前音频长度」自适应：
     *   · 1 秒以内（刚开始说）→ 250ms，文字几乎实时跟着长
     *   · 3 秒左右        → 500ms
     *   · 6 秒以上        → 800ms，把 CPU 留给识别本身
     *
     * 判据用重解码耗时占音频时长的比例更准，但这里用长度足够：
     * 实测 RTF 稳定在 0.03 左右，长度就是最直接的代理指标。
     *
     * @returns {number} 毫秒。
     */
    nextDelay() {
      const seconds = this.length / 16000
      if (seconds <= 1.2) return Math.min(250, config.stepMs)
      if (seconds <= 3) return Math.min(500, config.stepMs)
      return config.stepMs
    }

    /** 追加一块音频，并在需要时安排一次重解码。 */
    push(samples) {
      if (this.done) return
      // 排空窗口：定稿后短暂忽略在途的旧音频，避免新句子粘上旧尾巴。
      if (this.dropUntil > 0 && Date.now() < this.dropUntil) return
      this.chunks.push(samples)
      this.length += samples.length

      // 超过单段上限：强制定稿，避免缓冲区无限增长。
      if (this.length > config.maxSegmentSeconds * 16000) {
        this.finalize()
        return
      }

      if (this.timer === null) {
        this.timer = setTimeout(() => {
          this.timer = null
          this.decode(false)
        }, this.nextDelay())
      }
    }

    /**
     * 跑一次识别。
     * @param {boolean} final - 是否定稿（定稿后清空缓冲）。
     */
    decode(final) {
      if (this.done) return
      const total = new Float32Array(this.length)
      let offset = 0
      for (const c of this.chunks) {
        total.set(c, offset)
        offset += c.length
      }

      let text = ''
      try {
        text = ensureEngine().recognize(total)
      } catch (error) {
        warn(`识别失败：${error instanceof Error ? error.message : String(error)}`)
        this.send({ type: 'error', message: '识别失败' })
        // 出错也要清掉定时器，否则它会一直悬着、下一轮又触发一次解码。
        if (this.timer !== null) {
          clearTimeout(this.timer)
          this.timer = null
        }
        return
      }

      if (final) {
        this.done = true
        this.chunks = []
        this.length = 0
        this.lastText = ''
        if (this.timer !== null) {
          clearTimeout(this.timer)
          this.timer = null
        }
        this.send({ type: 'final', text })
        return
      }

      // 文本没变就不发，省一次前端重绘（前端重绘会打断输入法/光标）。
      //
      // ── 关于"抖动"：为什么这里不做抑制 ──────────────────────────────
      //
      // 实测识别结果不是单调变准的：
      //     3.2s  →  …workspaceright 的配置
      //     4.8s  →  …workspacerightite 的配置    ← 中间短暂变差
      //     5.6s  →  …workspaceright 的配置，然后重启DSH。  ← 又好了
      //
      // 试过用「公共前缀比例」和「LCS 相似度」判断要不要压住这一帧，
      // 都不行：抖动时相似度仍然很高（0.74），跟正常增长（0.71）分不开。
      // 根本原因是模型每次都在**整句重新对齐**，没有一个可靠的"变差了"
      // 信号可以在宿主侧算出来。
      //
      // 所以这里选择**如实推送**，把控制权交给用户：
      //   · 抖动只发生在说话过程中，用户不动手就只是看着文字微调
      //   · 用户一旦动手改字，前端立刻永久停手（见 client.js 的
      //     userEditedRef），之后新内容只追加、不再覆盖
      //   · 静音定稿时用整段音频重识别一次，那一次的结果是最终结果
      //
      // 这比加一层猜不准的抑制更诚实：宁可让用户看到模型在犹豫，
      // 也不要假装结果很稳、实际却把错误固定下来。
      if (text !== this.lastText) {
        this.lastText = text
        this.send({ type: 'partial', text })
      }
    }

    /** 定稿：用整句音频再识别一次，然后清空。 */
    finalize() {
      if (this.done) return
      // 无论走哪个分支都要清掉待触发的定时器，
      // 否则定稿后它还会再解码一次（对着已经清空的缓冲区）。
      if (this.timer !== null) {
        clearTimeout(this.timer)
        this.timer = null
      }
      if (this.length === 0) {
        this.done = true
        this.send({ type: 'final', text: '' })
        return
      }
      this.decode(true)
    }

    /** 丢弃（用户取消）。 */
    abort() {
      this.done = true
      this.chunks = []
      this.length = 0
      if (this.timer !== null) {
        clearTimeout(this.timer)
        this.timer = null
      }
    }
  }

  // ── 配置下发路由 ────────────────────────────────────────────────────
  //
  // 客户端需要几个和宿主共享的数值（静音定稿时长、闲置收工时长）。
  // 硬编码在 client.js 里会导致「改了 cordis.patch.yml 却不生效」，
  // 对开源用户来说很难排查。所以开一条只读路由，客户端启动时拉一次。
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/voice-stream/config',
      handler: (req, res) => {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(
          JSON.stringify({
            finalizeSilenceMs: config.finalizeSilenceMs,
            idleMs: effectiveIdleMs,
          }),
        )
      },
    }),
  )

  // ── WebSocket 路由 ──────────────────────────────────────────────────
  //
  // ── 安全边界（开源后尤其重要）────────────────────────────────────────
  //
  // 这条路由没有鉴权：它接受音频、跑 CPU 密集的识别。DSH 默认只监听
  // 127.0.0.1，所以正常情况下只有本机能连。但很多人会把 DSH 通过
  // 反向代理或内网穿透暴露出去 —— 那样任何能访问该端口的人都能
  // 连上来烧 CPU。
  //
  // 三重防护：
  //   1. 来源校验：只接受同源页面发起的连接（浏览器一定会带 Origin）
  //   2. 单连接：同时只允许一个活跃会话，多余的直接拒
  //   3. 帧大小上限：单帧超过 maxFrameBytes 就断开，防止内存打爆
  //
  // 这不是完整的鉴权方案，但能挡掉「别的网页偷偷连上来」和
  // 「误暴露端口后被扫到」这两类最常见的情况。
  let activeConnection = false

  ctx.effect(() =>
    ctx.webServer.registerUpgrade({
      path: '/voice-stream',
      handler: (req, socket, head) => {
        // 只做最小限度的握手：不引第三方 ws 库，避免多一个依赖。
        const key = req.headers['sec-websocket-key']
        if (typeof key !== 'string' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
          socket.destroy()
          return
        }

        // ── 1. 来源校验 ────────────────────────────────────────────────
        // 浏览器发起的 WebSocket 一定带 Origin。校验它的 host 必须和
        // 请求的 Host 一致 —— 这样「别的网站用 JS 连你的本地端口」
        // 会被浏览器同源策略之外的这一层挡住。
        const origin = req.headers.origin
        const host = req.headers.host
        if (typeof origin === 'string' && typeof host === 'string') {
          let originHost
          try {
            originHost = new URL(origin).host
          } catch {
            socket.destroy()
            return
          }
          if (originHost !== host) {
            warn(`拒绝跨源连接：origin=${originHost} host=${host}`)
            socket.destroy()
            return
          }
        }

        // ── 2. 单连接 ──────────────────────────────────────────────────
        if (activeConnection) {
          warn('拒绝连接：已有活跃的语音会话')
          socket.destroy()
          return
        }
        activeConnection = true

        const accept = createAcceptKey(key)
        try {
          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
              'Upgrade: websocket\r\n' +
              'Connection: Upgrade\r\n' +
              `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
          )
        } catch (error) {
          // 握手写失败：必须立刻释放名额，否则 activeConnection 会
          // 永久卡在 true，之后所有连接都被拒。
          warn(`握手写失败：${error instanceof Error ? error.message : String(error)}`)
          activeConnection = false
          try {
            socket.destroy()
          } catch {
            /* ignore */
          }
          return
        }

        let session = null
        const send = (payload) => {
          try {
            socket.write(encodeTextFrame(JSON.stringify(payload)))
          } catch {
            // 连接已断，忽略。
          }
        }

        let buffer = Buffer.alloc(0)
        socket.on('data', (chunk) => {
          buffer = Buffer.concat([buffer, chunk])

          // ── 3. 缓冲区上限 ────────────────────────────────────────────
          // 恶意或异常的客户端可能发超长帧。超过上限直接断开，
          // 而不是让 Buffer.concat 无限增长把内存吃光。
          if (buffer.length > config.maxFrameBytes) {
            warn(`帧超过上限（${config.maxFrameBytes} 字节），断开连接`)
            session?.abort()
            session = null
            try {
              socket.destroy()
            } catch {
              /* ignore */
            }
            return
          }

          // 逐帧解析：一帧可能被拆成多个 TCP 包，也可能多个帧挤在一个包里。
          while (true) {
            const frame = decodeFrame(buffer)
            if (frame === null) break
            buffer = buffer.subarray(frame.consumed)

            // ── 分片帧一律拒绝 ────────────────────────────────────────
            // 这条链路的客户端只发完整小帧，分片要么是异常实现、
            // 要么是恶意构造。把分片当完整帧解码会产生垃圾音频，
            // 所以直接断开，比静默出错更安全。
            if (!frame.fin) {
              warn('收到分片帧，断开连接')
              session?.abort()
              session = null
              try {
                socket.destroy()
              } catch {
                /* ignore */
              }
              return
            }

            if (frame.opcode === 0x8) {
              // close
              session?.abort()
              try {
                socket.end(encodeCloseFrame())
              } catch {
                /* ignore */
              }
              return
            }

            // ── ping / pong ───────────────────────────────────────────
            // 浏览器和中间代理都可能发 ping。RFC 6455 要求回 pong。
            // 不处理的话，ping 会掉到下面的二进制分支被当成音频。
            if (frame.opcode === 0x9) {
              try {
                socket.write(encodePongFrame(frame.payload))
              } catch {
                /* ignore */
              }
              continue
            }
            if (frame.opcode === 0xa) {
              // 收到 pong，不需要做什么。
              continue
            }

            if (frame.opcode === 0x1) {
              // 文本控制消息
              let message
              try {
                message = JSON.parse(frame.payload.toString('utf8'))
              } catch {
                continue
              }
              if (message.type === 'start') {
                session?.abort()
                session = new StreamSession(send)
                send({ type: 'ready' })
              } else if (message.type === 'finalize') {
                session?.finalize()
                // 定稿后立刻换一个新 session。
                //
                // 为什么必须换：StreamSession 定稿时把自己标记成 done，
                // 之后 push 会直接丢弃音频。用户"停一下继续说"是常态，
                // 不换 session 的话第二句永远不会出字。
                //
                // 客户端那边 committed 是累加的，所以换 session 不影响
                // 已经定稿的文本；新 session 只负责新的一句话。
                //
                // ── 排空窗口 ──────────────────────────────────────────
                // 定稿那一刻，客户端可能还有几帧音频在路上（200ms 一帧）。
                // 如果直接开新 session，这些旧音频会被当成新一句的开头，
                // 表现为「新句子前面粘着上一句的尾巴」。
                //
                // 所以新 session 先忽略 `flushMs` 内的音频，把管道排空。
                session = new StreamSession(send)
                session.dropUntil = Date.now() + config.flushMs
              } else if (message.type === 'stop') {
                session?.abort()
                session = null
              }
              continue
            }
            if (frame.opcode === 0x2) {
              // 二进制音频：Float32 小端
              if (session === null) continue
              const payload = frame.payload
              const usable = payload.length - (payload.length % 4)
              if (usable === 0) continue
              // Buffer 可能是池化的，必须复制到独立的 ArrayBuffer 再取视图。
              const copy = new Float32Array(usable / 4)
              for (let i = 0; i < copy.length; i += 1) {
                copy[i] = payload.readFloatLE(i * 4)
              }
              session.push(copy)
              continue
            }

            // ── 未知 opcode ───────────────────────────────────────────
            // 0x0 是分片续帧（已在上面被 FIN 检查挡掉），0x3-0x7 与
            // 0xB-0xF 都是保留 opcode。走到这里说明客户端实现有问题，
            // 断开比静默忽略更容易排查。
            warn(`收到未知 opcode 0x${frame.opcode.toString(16)}，断开连接`)
            session?.abort()
            session = null
            try {
              socket.destroy()
            } catch {
              /* ignore */
            }
            return
          }
        })

        socket.on('error', () => {
          session?.abort()
          session = null
          activeConnection = false
        })
        socket.on('close', () => {
          session?.abort()
          session = null
          // 释放单连接名额，让下一次录音能连上来。
          activeConnection = false
        })
        socket.on('end', () => {
          session?.abort()
          session = null
          activeConnection = false
        })
      },
    }),
  )

  log('已挂载 /voice-stream')
}

// ── 最小 WebSocket 实现（RFC 6455 子集）────────────────────────────────
//
// 为什么自己写而不是装 `ws`：这条链路只服务本机、只传 Float32 音频和
// 三个控制消息，帧格式用到的部分极小。少一个依赖 = 少一个升级时会
// 崩的地方（DSH 是 0.2.x，还在快速变动）。

/** WebSocket 握手用的固定 GUID。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * 计算 Sec-WebSocket-Accept。
 * @param {string} key - 客户端的 Sec-WebSocket-Key。
 * @returns {string} 应答值。
 */
function createAcceptKey(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64')
}

/**
 * 编码一个服务端 → 客户端的文本帧（不掩码，长度用 7/16/64 位）。
 * @param {string} text - 要发送的文本。
 * @returns {Buffer} 完整帧。
 */
function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = 0x81 // FIN + text
  return Buffer.concat([header, payload])
}

/** 编码一个关闭帧。 */
function encodeCloseFrame() {
  return Buffer.from([0x88, 0x00])
}

/**
 * 编码一个 pong 帧（回应客户端的 ping）。
 *
 * 服务端 → 客户端不掩码。payload 原样带回（RFC 6455 §5.5.3）。
 *
 * @param {Buffer} payload - 收到的 ping 载荷。
 * @returns {Buffer} 完整 pong 帧。
 */
function encodePongFrame(payload) {
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    // ping 载荷理论上不超过 125 字节，这里只是兜底。
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = 0x8a // FIN + pong
  return Buffer.concat([header, payload])
}

/**
 * 从缓冲区里解出一帧。
 *
 * 只处理客户端 → 服务端（必须掩码）的情况。
 *
 * 关于分片（FIN=0）：这条链路里客户端每 200ms 发一个完整小帧，
 * 永远不会分片。但如果不检查 FIN，恶意或异常客户端发来分片帧时，
 * 我们会把半个帧当成完整帧去解码，产生垃圾音频。所以这里遇到
 * FIN=0 直接标记为 `fragmented`，由调用方断开连接 —— 比静默
 * 产生错误数据更安全。
 *
 * @param {Buffer} buffer - 已累积的字节。
 * @returns {{opcode: number, payload: Buffer, consumed: number, fin: boolean} | null}
 *   解不出完整帧时返回 null（等待更多数据）。
 */
function decodeFrame(buffer) {
  if (buffer.length < 2) return null
  const first = buffer[0]
  const second = buffer[1]
  const fin = (first & 0x80) !== 0
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  let len = second & 0x7f
  let offset = 2

  if (len === 126) {
    if (buffer.length < 4) return null
    len = buffer.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buffer.length < 10) return null
    len = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }

  let mask = null
  if (masked) {
    if (buffer.length < offset + 4) return null
    mask = buffer.subarray(offset, offset + 4)
    offset += 4
  }

  if (buffer.length < offset + len) return null

  const raw = buffer.subarray(offset, offset + len)
  let payload
  if (mask !== null) {
    payload = Buffer.allocUnsafe(len)
    for (let i = 0; i < len; i += 1) payload[i] = raw[i] ^ mask[i % 4]
  } else {
    payload = raw
  }

  return { opcode, payload, consumed: offset + len, fin }
}
