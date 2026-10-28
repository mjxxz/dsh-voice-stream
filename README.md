# dsh-voice-stream 

咱做了个语音输入插件，说话的时候字会一个一个冒出来，像自己在打字一样喵～

用的是本地 SenseVoice 模型，不联网、不占显存，CPU 就能跑喵 (｡•̀ᴗ-)✧

---

## 咱为啥要做这个喵？

DSH 自带的语音输入是「说完 → 按停止 → 等结果」那种喵，说一大段之后往回看很麻烦，而且说错了当场看不到，只能整段重说 (´･_･`)

咱这个改成边说边识别喵！每 250～800ms 就把从这句开头到现在的音频重新认一遍，字就一点点长出来了喵～

---

## 有啥好玩的喵 ✧

**边说边出字** 说话的时候字实时冒出来，不是等你说完才蹦一大坨喵 (๑˃̵ᴗ˂̵)

**像打字不像刷新** 只重写变化的那一小段尾巴，所以看起来是「打字」不是「整段闪」喵

**说完会变绿** 停顿 1.2 秒，麦克风变成绿色小对勾，告诉你「这句定啦，可以继续说喵～」

**改完还能接着说** 看到错字直接改，改完继续说，会从你光标那儿接着出字，不会把你改的覆盖掉喵 (｡･ω･｡)

**下面有波形** 输入框下面有一整行波形，跟着你说话的声音跳动喵 ♪

**忘了关也没事** 10 秒不说话会自动关掉，不用担心麦克风一直亮着喵

**发消息自动关** 消息发出去麦克风就自己停了喵

**纯本地** SenseVoice 跑在 CPU 上，不联网、不占显存喵 (๑•̀ㅂ•́)و✧

---

## 咋装喵？

### 先准备模型

要两个文件喵：

```
<模型目录>/
  ├── model.int8.onnx   228 MB
  └── tokens.txt        0.3 MB
```

从这儿下（国内用镜像快一点喵）：

- HuggingFace：`csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`
- 镜像：`https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`

> 小提示喵：如果你装过 DSH 官方的语音输入，模型已经在
> `$DSH_HOME/speech-to-text/sensevoice/models/sensevoice-onnx/` 啦，直接复用就行喵～

**模型放哪儿喵？** 咱会自动找这三个地方 (｡･ω･｡)

1. 环境变量 `DSH_VOICE_STREAM_MODEL` 指向的目录
2. 当前实例的 `$DSH_HOME/speech-to-text/sensevoice/models/sensevoice-onnx/`
3. `~/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx/`

**如果你开了好几个 DSH 实例**（每个实例有自己的 `DSH_HOME` 喵），
把模型放到第 3 个位置，所有实例都能共用，不用每个都下一遍喵～ (๑•̀ㅂ•́)و✧

### 装插件

```bash
dsh plugin --profile web add github:mjxxz/dsh-voice-stream
```

> 插件管理页那个 npm 源选择器是给 npm 包用的喵，咱这个是 GitHub 仓库，
> 直接在输入框里填 `github:mjxxz/dsh-voice-stream` 就行啦 (๑˃̵ᴗ˂̵)

> 也支持本地目录安装喵：把仓库路径填进去就行～

### 关掉官方语音输入

两个插件抢同一个位置喵，只能开一个 (｡•́︿•̀｡)

从 `bundles` 里把 `@deepseek-ai/dsh-experimental-voice-input-bundle` 删掉就行喵～

### 重启 DSH

重启完就能用啦喵 ♪(´▽｀)

---

## 想调参数的话喵

改 `$DSH_HOME/profiles/web/cordis.patch.yml` 喵～

注意补丁是**整体替换** config 的，所以要覆盖就把整个 config 写全喵 (｡･ω･｡)

```yaml
- id: voice-stream
  name: 'dsh-voice-stream'
  config:
    enabled: true
    modelDir: 'C:\path\to\sensevoice-onnx'
    language: zh          # auto / zh / en / yue / ja / ko
    threads: 4            # CPU 线程数
    stepMs: 800           # 长句重解码间隔（短句会自动更快喵）
    finalizeSilenceMs: 1200
    idleMs: 10000         # 多久不说话自动收工
    maxSegmentSeconds: 30
    flushMs: 300
    maxFrameBytes: 1048576
    idleTimeoutMs: 300000 # 模型空闲多久释放
```

---

## 跑得快不快喵？

咱在 i7-12700H 上测的（4 线程，纯 CPU）喵：

| 音频长度 | 识别耗时 |
|---|---|
| 0.8 秒 | 40ms |
| 1.6 秒 | 64ms |
| 3.2 秒 | 97ms |
| 5.6 秒 | 165ms |

比实时快好多喵，所以边说边认完全跟得上 (๑•̀ㅂ•́)و✧ 而且一点显存都不占喵～

---

## 准不准喵？

安静环境下纯中文大概 **5～8% 字错误率**喵，加一点噪音大概 9% 左右～

**但是有个弱点要老实说喵** (´･_･`)：

- **中英混着说会翻车** —— `token` 可能认成 `抽ken`，`workspace-write` 可能变成 `workspace。right` 喵
- 专有名词容易掉字
- 数字会被转成阿拉伯数字（说「四十」出来是「40」）喵

这是 SenseVoice 模型本身的毛病，不是插件的锅喵 (｡•́︿•̀｡)

---

## 有啥限制喵？

- **麦克风要安全环境** 浏览器只在 `https://` 或 `localhost` / `127.0.0.1` 下给麦克风权限喵。用局域网 IP 打开会拿不到麦克风 (´･_･`)
- **一次只能开一个** 两个标签页不能同时录音喵
- **一次只能选一种语言** 中英混杂是弱项喵

---

## 兼容性喵

- DSH `0.2.0-rc.2` 测过喵
- Cordis `~4.0.4`
- 需要 `sherpa-onnx-node`（DSH 自带，装 dsh 的时候就有啦）
- 浏览器：Chrome / Edge 喵

---

## 开源喵

Apache-2.0，随便用随便改喵 ♪(´▽｀)

咱就是想做个自己用得顺手的东西，你要是也觉得好用那就太好啦喵 (๑˃̵ᴗ˂̵)
