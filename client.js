/**
 * dsh-voice-stream —— 浏览器半：边说边出字。
 *
 * ── 挂在哪儿 ────────────────────────────────────────────────────────────
 *
 * 两个槽位，各司其职：
 *
 *   conversation.input.activity   右侧的麦克风按钮（官方语音输入也用这格）
 *   conversation.composer.dock    输入框下方那一整行 —— 放波形
 *
 * **绝不调 `onActiveChange(true)`**：官方 CSS 里
 * `.trailingActive{flex:1;margin-left:0}` 会让工具栏铺满一行，
 * 按钮就被挤到最左边。保持 false 才是右侧小按钮。
 *
 * ── 波形为什么照抄官方写法 ──────────────────────────────────────────────
 *
 * 官方 Waveform 用 SVG 画 80 根竖线，靠 requestAnimationFrame 直接改
 * DOM 属性（`setAttribute('y1'/'y2')`），**完全不经过 React state**。
 * 这样每 50ms 更新一次也不触发重渲染，不会卡。
 *
 * 照抄这套是必要的：如果用 React state 驱动，每帧都会重渲染整个组件，
 * 输入框会被拖慢。
 *
 * 数据来源是 AnalyserNode 的实时 RMS，通过一个 ref 共享给波形组件，
 * 避免 React 层参与。
 *
 * ── 文字为什么像打字 ────────────────────────────────────────────────────
 *
 * 只重写变化的尾巴：拿新结果和上次写的比，找公共前缀，只替换分叉点
 * 之后的部分。识别结果通常是在末尾继续长，所以绝大多数时候只是
 * append 几个字 —— 这才是打字的感觉。
 *
 * ── 提交后自动关闭 ──────────────────────────────────────────────────────
 *
 * 录音时每 400ms 看一眼编辑器：内容变空说明消息发出去了，立即停止录音。
 */

window.__ModuleLoader__.load({
  id: 'dsh-voice-stream',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useRef, useCallback, useEffect } = React

    /** 宿主 WebSocket 端点。 */
    const WS_PATH = '/voice-stream'

    /** 发音频的间隔（毫秒）。 */
    const FRAME_MS = 200

    /** 目标采样率。 */
    const TARGET_RATE = 16000

    /** 静音多久算一句说完（默认值，运行时会被宿主配置覆盖）。 */
    const SILENCE_MS = 1200

    /** 说话时的能量阈值（RMS）。 */
    const SPEECH_RMS = 0.012

    /** 定稿后图标保持高亮的时长。 */
    const FLASH_MS = 700

    /** 提交检测的轮询间隔（毫秒）。 */
    const WATCH_MS = 400

    /**
     * 多久没说话就自动收工（默认值，运行时会被宿主配置覆盖）。
     *
     * 用途：用户点开麦克风后忘了关、或者说完就走开了，此时麦克风
     * 一直亮着、识别也在空转，既费电又容易把环境噪音录进去。
     *
     * 为什么取 10 秒：定稿静音是 1.2 秒，10 秒相当于「连续 8 秒多
     * 完全没有说话」。正常说话中间换气、思考不会超过这个长度；
     * 而用户如果想继续说，10 秒也足够他意识到「哎怎么停了」再点一次。
     * 太短（3-5 秒）会在思考时被误关，太长（30 秒）就失去了意义。
     */
    const IDLE_MS = 10000

    /**
     * 运行时可调参数。宿主在 `/voice-stream/config` 上公布，
     * 客户端首次渲染时拉一次并写进这里。
     *
     * 为什么要下发而不是硬编码：用户改 `cordis.patch.yml` 里的
     * `finalizeSilenceMs` / `idleMs` 时，若客户端写死就完全不生效，
     * 对开源用户来说是很难排查的坑。
     */
    const runtime = { silenceMs: SILENCE_MS, idleMs: IDLE_MS }

    /** 从宿主拉一次运行配置（失败就沿用默认值）。 */
    async function loadRuntimeConfig() {
      try {
        const res = await fetch('/voice-stream/config', { credentials: 'same-origin' })
        if (!res.ok) return
        const cfg = await res.json()
        if (Number.isFinite(cfg.finalizeSilenceMs)) runtime.silenceMs = cfg.finalizeSilenceMs
        if (Number.isFinite(cfg.idleMs)) runtime.idleMs = cfg.idleMs
      } catch {
        // 拉不到就用默认值，不影响功能。
      }
    }

    /** 波形竖线数量（与官方一致）。 */
    const WAVE_BARS = 80

    /** 波形采样步长（毫秒，与官方一致）。 */
    const WAVE_STEP_MS = 50

    /**
     * 全局的实时音量载体。
     *
     * 为什么放在模块级而不是组件里：波形和按钮分属两个槽位、两棵
     * 组件树，彼此没有 props 通道。用模块级对象共享是最轻的做法
     * （同一个 JS 上下文，不需要 Context）。
     *
     * @type {{ current: () => number }}
     */
    const liveAmplitude = { current: () => 0 }

    /**
     * 当前有几个录音会话在进行（0 或 1）。
     *
     * 波形那半靠它决定要不要显示自己：dock 是常驻槽位，
     * 不录音时必须返回 null，否则输入框下面会一直空出一行。
     *
     * @type {{ current: number }}
     */
    const activeSessions = { current: 0 }

    const CSS = [
      // ── 按钮 ──
      '.dsv-wrap{flex:none;display:inline-flex;align-items:center;gap:8px;min-width:0}',
      // 待机态对齐官方 .ddpbLW_trigger：28px、无背景、无边框。
      '.dsv-btn{flex:none;width:28px;height:28px;padding:0;border:none;background:transparent;',
      'color:inherit;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;',
      'border-radius:999px;transition:background .15s,color .15s}',
      '.dsv-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid,rgba(128,128,128,.18))}',
      '.dsv-btn:disabled{cursor:not-allowed;opacity:.35}',
      // 录音态对齐官方 .ddpbLW_roundButton：32px 圆形 + 主题色底。
      '.dsv-btn[data-state="listening"]{width:32px;height:32px;',
      'background:var(--dsw-specific-selector,rgba(128,128,128,.16));',
      'color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.dsv-btn[data-state="finalized"]{color:var(--dsw-alias-state-success-primary,#3fb950)}',
      '.dsv-btn[data-state="error"]{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.dsv-pulse{animation:dsv-pulse 1.2s ease-in-out infinite}',
      '@keyframes dsv-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '.dsv-msg{min-width:0;max-width:200px;color:var(--dsw-alias-label-secondary);white-space:nowrap;',
      'overflow:hidden;text-overflow:ellipsis;font-size:12px;line-height:1}',
      '.dsv-msg[data-tone="error"]{color:var(--dsw-alias-state-error-primary,#e5484d)}',

      // ── 波形（输入框下方整行）──
      //
      // 官方 .ddpbLW_waveform 是 flex:1 + height:24px；这里要占满
      // composer.dock 那一行，所以用 width:100% 并给一点上下留白。
      '.dsv-wave{width:100%;height:28px;display:block;color:var(--dsw-alias-label-secondary);',
      'padding:2px 0;box-sizing:border-box}',
      // 波形出现/消失的过渡，避免突然弹出。
      '.dsv-waveWrap{width:100%;max-width:var(--dsh-composer-card-max-width,100%);',
      'margin:0 auto;padding:0 var(--dsh-composer-side-clearance,0);',
      'animation:dsv-waveIn .18s ease-out}',
      '@keyframes dsv-waveIn{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}',
    ].join('')

    /** 注入样式（只注入一次）。 */
    function ensureCss() {
      if (typeof document === 'undefined') return
      const id = 'dsh-voice-stream-css'
      if (document.getElementById(id) !== null) return
      const tag = document.createElement('style')
      tag.id = id
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** 麦克风图标。 */
    function MicIcon({ pulsing }) {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          className: pulsing ? 'dsv-pulse' : undefined,
          'aria-hidden': 'true',
        },
        [
          h('rect', { key: 'a', x: 9, y: 2, width: 6, height: 11, rx: 3 }),
          h('path', { key: 'b', d: 'M5 10v1a7 7 0 0 0 14 0v-1' }),
          h('line', { key: 'c', x1: 12, y1: 18, x2: 12, y2: 22 }),
        ],
      )
    }

    /** 停止图标。 */
    function StopIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true' },
        h('rect', { x: 6, y: 6, width: 12, height: 12, rx: 2.5 }),
      )
    }

    /** 定稿对勾。 */
    function CheckIcon() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('polyline', { points: '20 6 9 17 4 12' }),
      )
    }

    /**
     * 实时波形 —— 照抄官方 Waveform 的做法。
     *
     * 80 根竖线，每 50ms 取一次实时音量，把整条历史向左推一格，
     * 新值从右边进来。所以看到的是"声音从右往左流过"的涟漪，
     * 而不是所有柱子一起跳。
     *
     * 全部通过 requestAnimationFrame 直接改 DOM，不触发 React 渲染。
     */
    function Waveform() {
      const svgRef = useRef(null)

      useEffect(() => {
        const svg = svgRef.current
        if (svg === null) return undefined

        // 官方写法：从右往左排（reverse），新值从末尾进入。
        const bars = Array.from(svg.querySelectorAll('line'))
          .reverse()
          .map((element) => ({ element, level: 0 }))

        let frame
        let previous = -Infinity
        let mounted = true

        const draw = (now) => {
          if (!mounted) return
          if (now - previous >= WAVE_STEP_MS) {
            previous = now
            let next = liveAmplitude.current()
            for (const bar of bars) {
              const previousLevel = bar.level
              bar.level = next
              next = previousLevel
              // 高度：静音时 1px 基线，最大 17px（官方同款曲线）。
              const height = 1 + Math.min(1, bar.level * 5) * 17
              bar.element.setAttribute('y1', String(20 - height))
              bar.element.setAttribute('y2', String(20 + height))
            }
          }
          frame = requestAnimationFrame(draw)
        }
        frame = requestAnimationFrame(draw)

        return () => {
          mounted = false
          cancelAnimationFrame(frame)
        }
      }, [])

      return h(
        'svg',
        {
          ref: svgRef,
          className: 'dsv-wave',
          viewBox: '0 0 640 40',
          preserveAspectRatio: 'none',
          role: 'img',
          'aria-label': '麦克风输入波形',
        },
        Array.from({ length: WAVE_BARS }, (_, index) =>
          h('line', {
            key: index,
            x1: index * 8 + 4,
            x2: index * 8 + 4,
            y1: '19',
            y2: '21',
            stroke: 'currentColor',
            strokeWidth: '3',
            strokeLinecap: 'round',
            // 越靠右越亮，形成方向感（官方同款）。
            opacity: 0.25 + index / 120,
          }),
        ),
      )
    }

    /**
     * 线性插值重采样到 16kHz。
     * @param {Float32Array} input - 原始样本。
     * @param {number} fromRate - 原采样率。
     * @returns {Float32Array} 16kHz 样本。
     */
    function resample(input, fromRate) {
      if (fromRate === TARGET_RATE) return input
      const ratio = fromRate / TARGET_RATE
      const outLength = Math.floor(input.length / ratio)
      const out = new Float32Array(outLength)
      for (let i = 0; i < outLength; i += 1) {
        const x = i * ratio
        const i0 = Math.floor(x)
        const i1 = Math.min(i0 + 1, input.length - 1)
        out[i] = input[i0] + (input[i1] - input[i0]) * (x - i0)
      }
      return out
    }

    /**
     * 找到 composer 的 Lexical 编辑器元素。
     *
     * Lexical 把实例挂在宿主元素的 `__lexicalEditor` 上，composer 的
     * namespace 固定是 `dsh-composer`（见 ui-conversation 的
     * DraftEditorRuntime）。用命名空间而不是 class 猜测，避免认错元素。
     *
     * @returns {HTMLElement | null} 编辑器宿主元素。
     */
    function findEditor() {
      if (typeof document === 'undefined') return null
      const nodes = document.querySelectorAll('[contenteditable="true"]')
      for (const node of nodes) {
        const editor = /** @type {any} */ (node).__lexicalEditor
        if (editor !== undefined && editor !== null && editor._config?.namespace === 'dsh-composer') {
          return /** @type {HTMLElement} */ (node)
        }
      }
      return nodes.length > 0 ? /** @type {HTMLElement} */ (nodes[0]) : null
    }

    /**
     * 麦克风按钮组件（右侧槽位）。
     *
     * @param {object} props - 槽位 props。
     * @param {object} props.inputActions - 编辑器动作。
     * @param {string} props.sessionId - 当前会话。
     * @param {boolean} props.locked - 输入框是否锁定。
     */
    function VoiceStreamButton({ inputActions, sessionId, locked }) {
      ensureCss()

      /** idle | connecting | listening | finalized | error */
      const [state, setState] = useState('idle')
      const [message, setMessage] = useState('')

      const wsRef = useRef(null)
      const ctxRef = useRef(null)
      const streamRef = useRef(null)
      const processorRef = useRef(null)
      const analyserRef = useRef(null)

      const anchorRef = useRef(null)
      const writtenRef = useRef('')
      const committedRef = useRef('')
      const silenceTimerRef = useRef(null)
      const flashTimerRef = useRef(null)
      const watchTimerRef = useRef(null)
      /**
       * 手动停止时的兜底定时器。
       *
       * 单独一个 ref，不复用 watchTimerRef —— 后者被轮询循环占用，
       * 复用会把轮询打断，导致"发消息自动关闭"失效。
       */
      const stopTimerRef = useRef(null)
      const spokeRef = useRef(false)
      const activeRef = useRef(false)
      /**
       * 下一次收到 final 时不要并入 committed。
       *
       * 用在 restartSegment（用户改字）里：那时已经主动发了 finalize，
       * 宿主回的 final 带着上一段的文本，而那段文本早就在编辑器里了。
       * 再并入一次就会重复。
       */
      const skipNextFinalRef = useRef(false)
      /**
       * 最后一次检测到「有人在说话」的时间戳。
       *
       * 自动收工靠它算闲置时长：从开始录音算起，如果连续 IDLE_MS
       * 都没有新的说话信号，就认为用户已经走了，自动关闭。
       *
       * 用时间戳而不是计数器：轮询和音频回调的频率不同（400ms vs
       * 每帧），时间戳对两者都成立。
       */
      const lastSpeechAtRef = useRef(0)

      // ── 基础动作（必须排在最前面）──────────────────────────────────────
      //
      // JS 的 const 有暂时性死区：下面 restartSegment / writeTail 的
      // useCallback 依赖数组里会**立即求值** flashFinalized 和 sendControl。
      // 如果它们声明在后面，这里就会抛 ReferenceError，整个组件渲染失败
      // （表现是按钮完全不出现）。所以这两个必须先声明。

      /** 发一条控制消息给宿主。 */
      const sendControl = useCallback((type) => {
        const ws = wsRef.current
        if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type }))
      }, [])

      /** 定稿反馈：图标变绿对勾 700ms，告诉用户"这句定了"。 */
      const flashFinalized = useCallback(() => {
        setState('finalized')
        if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current)
        flashTimerRef.current = setTimeout(() => {
          flashTimerRef.current = null
          setState((prev) => (prev === 'finalized' ? 'listening' : prev))
        }, FLASH_MS)
      }, [])

      /**
       * 用户动过手之后，重新开始一段。
       *
       * ── 为什么要这样做 ──────────────────────────────────────────────
       *
       * 上一版的处理是「检测到用户编辑 → 永久停止写入」，这是错的：
       * 用户改完字还想继续说，结果麦克风还在录、识别也在跑，但文字
       * 再也不出现了 —— 看起来就是"语音坏了"。
       *
       * 正确语义是：**用户一动光标/删字，这一段就算定稿了**。
       * 此时应该：
       *   1. 把当前编辑器里的内容当作新基线（保住用户的修改）
       *   2. 通知宿主把正在识别的那句定稿掉
       *   3. 图标闪一下绿对勾，告诉用户"这句定了，继续说"
       *   4. 之后的新语音从当前光标处重新开始一段
       *
       * 这样「改字」和「停顿」在语义上就统一了：都是"这句说完了"。
       *
       * @param {number} caretStart - 用户当前光标位置，作为新锚点。
       */
      const restartSegment = useCallback(
        (caretStart) => {
          // 把正在识别的那句请求定稿，宿主会清空缓冲开始新的一句。
          // 设标记：这次 finalize 的回包不要并入 committed（那段文本
          // 已经在编辑器里了，再并入会重复）。
          skipNextFinalRef.current = true
          sendControl('finalize')
          spokeRef.current = false

          // 新一段的锚点 = 用户当前光标位置。
          anchorRef.current = caretStart
          writtenRef.current = ''
          committedRef.current = ''

          // 清掉可能还在跑的静音计时，避免定稿后立刻又触发。
          if (silenceTimerRef.current !== null) {
            clearTimeout(silenceTimerRef.current)
            silenceTimerRef.current = null
          }
          flashFinalized()
        },
        [flashFinalized, sendControl],
      )

      /**
       * 只重写变化的尾巴，制造"打字"的观感。
       *
       * @param {string} next - 目标文本。
       * @returns {boolean} 是否成功写入。
       */
      const writeTail = useCallback(
        (next) => {
          if (inputActions === undefined || inputActions === null) return false
          if (anchorRef.current === null) return false

          const prev = writtenRef.current
          if (next === prev) return true

          let keep = 0
          const min = Math.min(prev.length, next.length)
          while (keep < min && prev[keep] === next[keep]) keep += 1

          const caret = inputActions.captureInsertion()
          if (caret === undefined || caret === null) return false

          // ── 光标/内容被用户动过 ──────────────────────────────────────
          //
          // 正常情况光标应该停在我们上次写的末尾。偏离了就说明用户
          // 点了别处、删了字、或改了内容 —— 这时候不要放弃，而是
          // 把这一段当作已定稿，以用户的光标为新起点继续。
          const expected = anchorRef.current + prev.length
          if (prev.length > 0 && Math.abs(caret.start - expected) > 2) {
            restartSegment(caret.start)
            return false
          }

          const span = {
            start: anchorRef.current + keep,
            end: anchorRef.current + prev.length,
            draftRev: caret.draftRev,
          }
          const ok = inputActions.insertText(next.slice(keep), span)
          if (!ok) {
            // draftRev 对不上（用户在两次识别之间改过字）。
            // 同样按"这段结束"处理，而不是永久停手。
            restartSegment(caret.start)
            return false
          }
          writtenRef.current = next
          return true
        },
        [inputActions, restartSegment],
      )

      /** 释放资源。 */
      const teardown = useCallback(() => {
        activeRef.current = false
        activeSessions.current = 0
        liveAmplitude.current = () => 0
        // 重置「跳过下一个 final」标记。
        //
        // 这个标记在改字/停止时会置 true，等宿主的 final 回来才清。
        // 但如果 final 丢了（连接断了、宿主崩了），标记会永久为 true，
        // 导致下一次静音定稿的 final 被错误吞掉、那句文字丢失。
        // 所以每次拆连接时都清掉。
        skipNextFinalRef.current = false
        for (const ref of [silenceTimerRef, flashTimerRef, watchTimerRef, stopTimerRef]) {
          if (ref.current !== null) {
            clearTimeout(ref.current)
            ref.current = null
          }
        }
        const processor = processorRef.current
        if (processor !== null) {
          processor.onaudioprocess = null
          try {
            processor.disconnect()
          } catch {
            /* ignore */
          }
          processorRef.current = null
        }
        const ctx = ctxRef.current
        if (ctx !== null) {
          try {
            ctx.close()
          } catch {
            /* ignore */
          }
          ctxRef.current = null
        }
        analyserRef.current = null
        const stream = streamRef.current
        if (stream !== null) {
          for (const track of stream.getTracks()) track.stop()
          streamRef.current = null
        }
        const ws = wsRef.current
        if (ws !== null) {
          try {
            ws.send(JSON.stringify({ type: 'stop' }))
            ws.close()
          } catch {
            /* ignore */
          }
          wsRef.current = null
        }
      }, [])

      useEffect(() => () => teardown(), [teardown])

      // 挂载时拉一次宿主配置（静音定稿时长、闲置收工时长）。
      // 拉不到就沿用默认值，不影响功能。
      useEffect(() => {
        loadRuntimeConfig()
      }, [])

      const finalize = useCallback(() => {
        if (!spokeRef.current) return
        sendControl('finalize')
      }, [sendControl])

      const shutdown = useCallback(
        (why) => {
          teardown()
          setState('idle')
          setMessage('')
          anchorRef.current = null
          writtenRef.current = ''
          committedRef.current = ''
          spokeRef.current = false
          // 清掉闲置计时基准，否则下次录音一开就立刻被判超时。
          lastSpeechAtRef.current = 0
          if (why !== undefined) setMessage(why)
        },
        [teardown],
      )

      /**
       * 闲置自动收工。
       *
       * 和手动 stop 的区别：这个没有用户在场，所以反馈要更明确 ——
       * 先把图标变成绿色对勾停一下（告诉用户"结束了"），再复位成
       * 麦克风。否则用户回来看见按钮自己变回原样，会以为插件崩了。
       *
       * 顺序：
       *   1. 请求定稿（把最后半句存下来）
       *   2. 图标变绿对勾
       *   3. 等 FLASH_MS 后拆资源、复位
       */
      const autoStop = useCallback(() => {
        // 已经停了就别重复触发（轮询可能连续命中）。
        if (!activeRef.current) return
        activeRef.current = false

        skipNextFinalRef.current = true
        sendControl('finalize')
        setState('finalized')

        setTimeout(() => {
          teardown()
          setState('idle')
          setMessage('')
          anchorRef.current = null
          writtenRef.current = ''
          committedRef.current = ''
          spokeRef.current = false
          lastSpeechAtRef.current = 0
        }, FLASH_MS)
      }, [sendControl, teardown])

      const start = useCallback(async () => {
        setMessage('')
        setState('connecting')

        try {
          if (inputActions === undefined || inputActions === null) throw new Error('输入框不可用')
          const caret = inputActions.captureInsertion()
          if (caret === undefined || caret === null) throw new Error('无法获取光标位置')

          anchorRef.current = caret.start
          writtenRef.current = ''
          committedRef.current = ''
          spokeRef.current = false
          // 闲置计时从「开始录音」算起：即使一句话没说，
          // 开着麦克风发呆 IDLE_MS 也会自动收工。
          lastSpeechAtRef.current = Date.now()

          const media = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
            video: false,
          })
          streamRef.current = media

          const ws = new WebSocket(
            `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${WS_PATH}`,
          )
          ws.binaryType = 'arraybuffer'
          wsRef.current = ws

          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('连接识别服务超时')), 5000)
            ws.onopen = () => {
              clearTimeout(timer)
              resolve()
            }
            ws.onerror = () => {
              clearTimeout(timer)
              reject(new Error('无法连接识别服务'))
            }
          })

          ws.onmessage = (event) => {
            let msg
            try {
              msg = JSON.parse(event.data)
            } catch {
              return
            }
            if (msg.type === 'partial') {
              writeTail(committedRef.current + msg.text)
            } else if (msg.type === 'final') {
              // ── 这个 final 是不是我们自己触发的那次？─────────────────
              //
              // restartSegment（用户改字）会发 finalize，宿主回一个 final，
              // 里面带着**上一段**的完整文本。但那时我们已经把 committed
              // 清空、锚点移到新位置了。如果直接 +=，上一段的文本会被
              // 追加到新一段里，表现为「改完字后出现重复文字」。
              //
              // 用 awaitingFinalize 标记：只有客户端主动要定稿时才吞掉
              // 这个 final（因为那段文本已经在编辑器里了）；静音定稿
              // 产生的 final 才需要并入 committed。
              if (skipNextFinalRef.current) {
                skipNextFinalRef.current = false
                // 这段文本已经在编辑器里，不要再写一次。
                spokeRef.current = false
                flashFinalized()
                return
              }
              committedRef.current += msg.text
              writeTail(committedRef.current)
              spokeRef.current = false
              if (silenceTimerRef.current !== null) {
                clearTimeout(silenceTimerRef.current)
                silenceTimerRef.current = null
              }
              flashFinalized()
            } else if (msg.type === 'error') {
              setMessage(msg.message ?? '识别失败')
            }
          }

          ws.onclose = () => {
            if (wsRef.current === ws) wsRef.current = null
          }

          sendControl('start')

          // ── 音频采集 ──
          const ctx = new AudioContext()
          ctxRef.current = ctx
          const source = ctx.createMediaStreamSource(media)
          const analyser = ctx.createAnalyser()
          analyser.fftSize = 512
          // 持有引用防止 GC：AudioContext 的节点如果只被闭包临时引用，
          // 在 ctx 存活期间可能被回收，导致波形读数变成 0。
          analyserRef.current = analyser
          source.connect(analyser)

          // 波形读这里：每次调用都算一次当前 RMS。
          const levelBuf = new Float32Array(analyser.fftSize)
          liveAmplitude.current = () => {
            analyser.getFloatTimeDomainData(levelBuf)
            let sum = 0
            for (let i = 0; i < levelBuf.length; i += 1) sum += levelBuf[i] * levelBuf[i]
            return Math.sqrt(sum / levelBuf.length)
          }

          const processor = ctx.createScriptProcessor(4096, 1, 1)
          processorRef.current = processor

          const nativeRate = ctx.sampleRate
          let carry = new Float32Array(0)
          const framesPerSend = Math.floor((TARGET_RATE * FRAME_MS) / 1000)

          processor.onaudioprocess = (event) => {
            const input = event.inputBuffer.getChannelData(0)

            // VAD 用同一份音量读数。
            const rms = liveAmplitude.current()
            const speaking = rms > SPEECH_RMS

            if (speaking) {
              spokeRef.current = true
              // 记下最后一次说话的时刻，自动收工靠它判断闲置时长。
              lastSpeechAtRef.current = Date.now()
              if (silenceTimerRef.current !== null) {
                clearTimeout(silenceTimerRef.current)
                silenceTimerRef.current = null
              }
            } else if (spokeRef.current && silenceTimerRef.current === null) {
              silenceTimerRef.current = setTimeout(() => {
                silenceTimerRef.current = null
                finalize()
              }, runtime.silenceMs)
            }

            // ── 重采样 + 发送 ──
            const resampled = resample(input, nativeRate)
            const merged = new Float32Array(carry.length + resampled.length)
            merged.set(carry, 0)
            merged.set(resampled, carry.length)

            let offset = 0
            while (merged.length - offset >= framesPerSend) {
              const frame = merged.subarray(offset, offset + framesPerSend)
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength))
              }
              offset += framesPerSend
            }
            carry = merged.slice(offset)
          }

          source.connect(processor)
          const mute = ctx.createGain()
          mute.gain.value = 0
          processor.connect(mute)
          mute.connect(ctx.destination)

          activeRef.current = true
          activeSessions.current = 1
          setState('listening')

          // ── 轮询：提交检测 / 用户编辑 / 闲置收工 ─────────────────────
          //
          // 三件事：
          //   1. 编辑器被清空 → 消息发出去了，停止录音
          //   2. 用户动了光标或改了内容 → 这一段定稿，从新位置继续
          //   3. 连续 IDLE_MS 没说话 → 自动收工，按钮复位
          //
          // 第 2、3 条必须主动轮询：它们都不会触发识别回调，
          // 不轮询的话插件永远不知道"用户已经改完"或"用户已经走了"。
          const watch = () => {
            if (!activeRef.current) return
            const editor = findEditor()

            if (editor !== null && writtenRef.current !== '' && editor.textContent.trim() === '') {
              // 消息发出去了（或用户全删了）。
              shutdown()
              return
            }

            // ── 闲置收工 ────────────────────────────────────────────
            //
            // 用户点开麦克风后忘了关、或说完就走开：麦克风一直亮着、
            // 识别空转、还会把环境噪音录进去。连续 IDLE_MS 没有任何
            // 说话信号就自动收工，按钮从红色停止变回麦克风。
            //
            // 注意这里**不判断 writtenRef**：即使一个字都没说，
            // 开着麦克风发呆 10 秒也该关掉。
            if (lastSpeechAtRef.current > 0 && Date.now() - lastSpeechAtRef.current > runtime.idleMs) {
              autoStop()
              return
            }

            // 只在「已经写过东西」时才检查光标偏移，
            // 否则一开始录音光标在锚点上是正常的。
            if (anchorRef.current !== null && writtenRef.current !== '') {
              const caret = inputActions?.captureInsertion()
              if (caret !== undefined && caret !== null) {
                const expected = anchorRef.current + writtenRef.current.length
                if (Math.abs(caret.start - expected) > 2) {
                  // 用户动了光标或改了字：这段定稿，重新起一段。
                  restartSegment(caret.start)
                }
              }
            }

            watchTimerRef.current = setTimeout(watch, WATCH_MS)
          }
          watchTimerRef.current = setTimeout(watch, WATCH_MS)
        } catch (error) {
          teardown()
          setState('error')
          setMessage(error instanceof Error ? error.message : String(error))
        }
      }, [autoStop, finalize, flashFinalized, inputActions, restartSegment, sendControl, shutdown, teardown, writeTail])

      const stop = useCallback(() => {
        // stop 也会触发一次 final。这段文本已经在编辑器里了，
        // 所以回包不要并入 committed（否则会重复）。
        skipNextFinalRef.current = true
        finalize()
        const ws = wsRef.current
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          shutdown()
        }
        if (ws !== null) {
          const prev = ws.onmessage
          ws.onmessage = (event) => {
            prev?.(event)
            try {
              if (JSON.parse(event.data).type === 'final') finish()
            } catch {
              /* ignore */
            }
          }
        }
        // 兜底定时器必须存进 ref，否则 teardown 清不掉：
        // 用户如果在 2 秒内又点开始录音，这个旧定时器会把新会话关掉。
        if (stopTimerRef.current !== null) clearTimeout(stopTimerRef.current)
        stopTimerRef.current = setTimeout(() => {
          stopTimerRef.current = null
          finish()
        }, 2000)
      }, [finalize, shutdown])

      const onClick = useCallback(() => {
        if (locked) return
        if (state === 'listening' || state === 'finalized') stop()
        else if (state === 'idle' || state === 'error') start()
      }, [locked, start, state, stop])

      /** 阻止按钮抢焦点：编辑器保持焦点，光标才一直可见。 */
      const keepFocus = useCallback((event) => {
        event.preventDefault()
      }, [])

      const disabled = locked || state === 'connecting'
      const title =
        state === 'listening' || state === 'finalized'
          ? '录音中 —— 再点一下结束'
          : state === 'connecting'
            ? '正在连接…'
            : '语音输入（边说边出字）'

      return h('div', { className: 'dsv-wrap' }, [
        h(
          'button',
          {
            key: 'btn',
            type: 'button',
            className: 'dsv-btn',
            'data-state': state,
            onClick,
            onMouseDown: keepFocus,
            disabled,
            title,
            'aria-label': title,
          },
          state === 'listening'
            ? h(StopIcon)
            : state === 'finalized'
              ? h(CheckIcon)
              : h(MicIcon, { pulsing: state === 'connecting' }),
        ),
        message !== ''
          ? h(
              'span',
              { key: 'msg', className: 'dsv-msg', 'data-tone': state === 'error' ? 'error' : undefined },
              message,
            )
          : null,
      ])
    }

    /**
     * 输入框下方的一整行波形（`conversation.composer.dock` 槽位）。
     *
     * 只在录音时渲染，其它时候返回 null —— dock 是 list 槽位，
     * 返回 null 时这一行会自动收起，不占高度。
     */
    function WaveformDock() {
      ensureCss()
      const [recording, setRecording] = useState(false)

      // 用一个轻量定时器同步「是否在录音」。
      //
      // 为什么不用事件：两个槽位是两棵组件树，没有 props 通道。
      // 每 200ms 查一次模块级状态足够（波形本身是 rAF 驱动的，
      // 这个定时器只负责挂载/卸载）。
      useEffect(() => {
        const timer = setInterval(() => {
          setRecording(activeSessions.current > 0)
        }, 200)
        return () => clearInterval(timer)
      }, [])

      if (!recording) return null
      return h('div', { className: 'dsv-waveWrap' }, h(Waveform))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.activity', () =>
          ctx.slots.register({ name: 'conversation.input.activity' }, VoiceStreamButton),
        )
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'voice-stream-wave' }, WaveformDock),
        )
      },
    }
  },
})
