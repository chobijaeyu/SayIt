// Audio capture service — AudioWorklet with ScriptProcessorNode fallback.
// WebView2 on Windows has known issues where AudioWorklet's process() never
// fires despite addModule() succeeding.  We detect this and fall back to the
// deprecated-but-reliable ScriptProcessorNode.

import { addRuntimeEvent } from './debugLog'

let audioCtx: AudioContext | null = null
let workletNode: AudioWorkletNode | null = null
let scriptNode: ScriptProcessorNode | null = null
let mediaStream: MediaStream | null = null
let sourceNode: MediaStreamAudioSourceNode | null = null
let onAudioData: ((buffer: ArrayBuffer) => void) | null = null
let onVolumeChange: ((volume: number) => void) | null = null
let onPCMFrame: ((pcm: Int16Array) => void) | null = null
let actualSampleRate = 16000
let firstPCMFrameLogged = false
let firstRmsLogged = false
let usingFallback = false

/** 预热中的麦克风流：后台 PTT 时 getUserMedia 会卡死在 WKWebView，必须事先开好。 */
let warmStream: MediaStream | null = null
let warmDeviceId: string | undefined
let warmInFlight: Promise<void> | null = null

const TARGET_SAMPLE_RATE = 16000
/** getUserMedia 超时（后台时常见无限挂起） */
const GET_USER_MEDIA_TIMEOUT_MS = 4000

// HMR cleanup: tear down audio capture when module is hot-replaced
if ((import.meta as unknown as Record<string, unknown>).hot) {
  const hot = (import.meta as unknown as Record<string, unknown>).hot as { dispose: (cb: () => void) => void }
  hot.dispose(() => {
    console.log('[audio] HMR dispose: tearing down audio capture')
    if (workletNode) {
      try { workletNode.port.onmessage = null } catch { /* ignore */ }
      try { workletNode.disconnect() } catch { /* ignore */ }
      workletNode = null
    }
    if (scriptNode) {
      try { scriptNode.onaudioprocess = null } catch { /* ignore */ }
      try { scriptNode.disconnect() } catch { /* ignore */ }
      scriptNode = null
    }
    if (sourceNode) {
      try { sourceNode.disconnect() } catch { /* ignore */ }
      sourceNode = null
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop())
      mediaStream = null
    }
    if (warmStream) {
      warmStream.getTracks().forEach((track) => track.stop())
      warmStream = null
    }
    if (audioCtx && audioCtx.state !== 'closed') {
      audioCtx.close().catch(() => { })
    }
    audioCtx = null
    onAudioData = null
    onVolumeChange = null
    onPCMFrame = null
  })
}

export function getActualSampleRate(): number {
  return actualSampleRate
}

const PCM_WORKLET_CODE = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.targetRate = opts.targetRate || 16000;
    this.inputRate = opts.inputRate || sampleRate || 48000;
    this.ratio = this.inputRate / this.targetRate;
    this.tail = new Float32Array(0);
    this.phase = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) {
      return true;
    }

    let sum = 0;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      sum += s * s;
    }
    const rms = Math.sqrt(sum / input.length);

    const merged = new Float32Array(this.tail.length + input.length);
    merged.set(this.tail, 0);
    merged.set(input, this.tail.length);

    let outFloat;

    if (Math.abs(this.ratio - 1) < 0.0001) {
      outFloat = merged;
      this.tail = new Float32Array(0);
      this.phase = 0;
    } else {
      const available = merged.length - this.phase;
      const outLen = Math.floor(available / this.ratio);

      if (outLen <= 0) {
        this.tail = merged;
        this.port.postMessage({ rms, sampleRate: this.targetRate });
        return true;
      }

      outFloat = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const pos = this.phase + i * this.ratio;
        const i0 = Math.floor(pos);
        const i1 = Math.min(i0 + 1, merged.length - 1);
        const frac = pos - i0;
        outFloat[i] = merged[i0] * (1 - frac) + merged[i1] * frac;
      }

      const consumed = this.phase + outLen * this.ratio;
      const keepFrom = Math.floor(consumed);
      this.phase = consumed - keepFrom;
      this.tail = keepFrom < merged.length ? merged.slice(keepFrom) : new Float32Array(0);
    }

    const int16 = new Int16Array(outFloat.length);
    for (let i = 0; i < outFloat.length; i++) {
      const s = Math.max(-1, Math.min(1, outFloat[i]));
      int16[i] = s < 0 ? s * 32768 : s * 32767;
    }

    this.port.postMessage({ pcm: int16.buffer, rms, sampleRate: this.targetRate }, [int16.buffer]);
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
`

export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  const audioInputs = (list: MediaDeviceInfo[]) => list.filter((d) => d.kind === 'audioinput')

  let devices = audioInputs(await navigator.mediaDevices.enumerateDevices())

  // 没有持久麦克风权限时，enumerateDevices() 只返回一个无名字的通用项。
  // 此时临时打开一路音频流触发授权，趁流活跃时重新枚举，拿到真实名称。
  if (devices.length <= 1 || devices.some((d) => !d.label)) {
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      devices = audioInputs(await navigator.mediaDevices.enumerateDevices())
    } catch {
      // 权限被拒或无可用麦克风：保留已有结果
    } finally {
      if (stream) stream.getTracks().forEach((t) => t.stop())
    }
  }

  return devices
}

function createAudioContext() {
  const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) {
    throw new Error('Current browser does not support AudioContext')
  }
  try {
    return new AudioContextCtor({ latencyHint: 'interactive', sinkId: { type: 'none' } } as unknown as AudioContextOptions)
  } catch {
    // ignore unsupported sinkId
  }
  try {
    return new AudioContextCtor({ latencyHint: 'interactive' })
  } catch {
    // ignore constructor option failures
  }
  return new AudioContextCtor()
}

function isStreamLive(stream: MediaStream | null): boolean {
  if (!stream) return false
  const tracks = stream.getAudioTracks()
  return tracks.length > 0 && tracks.every((t) => t.readyState === 'live')
}

function buildAudioConstraints(deviceId?: string): MediaStreamConstraints {
  return {
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: false,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  }
}

async function getUserMediaWithTimeout(
  constraints: MediaStreamConstraints,
  timeoutMs = GET_USER_MEDIA_TIMEOUT_MS,
): Promise<MediaStream> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      navigator.mediaDevices.getUserMedia(constraints),
      new Promise<MediaStream>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`麦克风打开超时（${timeoutMs}ms）。请把 SayIt 切到前台一次以预热麦克风。`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 预热麦克风：在应用前台时打开设备并常驻，供后台 PTT 瞬间复用。 */
export async function prewarmMicrophone(deviceId?: string): Promise<boolean> {
  const wanted = deviceId || undefined
  if (isStreamLive(warmStream) && warmDeviceId === wanted) {
    return true
  }
  if (warmInFlight) {
    await warmInFlight
    return isStreamLive(warmStream)
  }

  warmInFlight = (async () => {
    if (warmStream && (!isStreamLive(warmStream) || warmDeviceId !== wanted)) {
      warmStream.getTracks().forEach((t) => t.stop())
      warmStream = null
    }
    if (isStreamLive(warmStream) && warmDeviceId === wanted) return

    const t0 = performance.now()
    addRuntimeEvent('info', 'audio', '麦克风预热开始', { deviceId: wanted || 'default' })
    try {
      const stream = await getUserMediaWithTimeout(buildAudioConstraints(wanted), 8000)
      warmStream = stream
      warmDeviceId = wanted
      addRuntimeEvent('info', 'audio', '麦克风预热成功', {
        deviceId: wanted || 'default',
        elapsedMs: Math.round(performance.now() - t0),
        trackLabel: stream.getAudioTracks()[0]?.label || '',
      })
    } catch (error) {
      addRuntimeEvent('warn', 'audio', '麦克风预热失败', {
        deviceId: wanted || 'default',
        error: String(error),
        elapsedMs: Math.round(performance.now() - t0),
      })
    }
  })()

  try {
    await warmInFlight
  } finally {
    warmInFlight = null
  }
  return isStreamLive(warmStream)
}

/** 仅拆掉处理图；默认保留 warm 流供下次复用（避免后台再次 getUserMedia 卡死）。 */
async function teardownCapture(options?: { releaseWarmStream?: boolean }) {
  if (workletNode) {
    try { workletNode.port.onmessage = null } catch { /* ignore */ }
    try { workletNode.disconnect() } catch { /* ignore */ }
    workletNode = null
  }

  if (scriptNode) {
    try { scriptNode.onaudioprocess = null } catch { /* ignore */ }
    try { scriptNode.disconnect() } catch { /* ignore */ }
    scriptNode = null
  }

  if (sourceNode) {
    try { sourceNode.disconnect() } catch { /* ignore */ }
    sourceNode = null
  }

  if (mediaStream) {
    if (!options?.releaseWarmStream && isStreamLive(mediaStream)) {
      warmStream = mediaStream
    } else {
      mediaStream.getTracks().forEach((track) => track.stop())
      if (warmStream === mediaStream) warmStream = null
    }
    mediaStream = null
  }

  if (audioCtx && audioCtx.state !== 'closed') {
    await audioCtx.close().catch(() => { })
  }
  audioCtx = null
  actualSampleRate = TARGET_SAMPLE_RATE
}

/** 彻底释放预热流（退出应用 / 切换设备时） */
export async function releaseWarmMicrophone() {
  await teardownCapture({ releaseWarmStream: true })
  if (warmStream) {
    warmStream.getTracks().forEach((t) => t.stop())
    warmStream = null
  }
  warmDeviceId = undefined
}

// ── Resampler state for ScriptProcessorNode fallback ──
let spnTail = new Float32Array(0)
let spnPhase = 0

/** Resample + convert to Int16 (same algorithm as the AudioWorklet) */
function resampleToInt16(input: Float32Array, inputRate: number): { pcm: Int16Array; rms: number } {
  const ratio = inputRate / TARGET_SAMPLE_RATE

  let sum = 0
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    sum += s * s
  }
  const rms = Math.sqrt(sum / input.length)

  const merged = new Float32Array(spnTail.length + input.length)
  merged.set(spnTail, 0)
  merged.set(input, spnTail.length)

  let outFloat: Float32Array

  if (Math.abs(ratio - 1) < 0.0001) {
    outFloat = merged
    spnTail = new Float32Array(0)
    spnPhase = 0
  } else {
    const available = merged.length - spnPhase
    const outLen = Math.floor(available / ratio)

    if (outLen <= 0) {
      spnTail = merged
      return { pcm: new Int16Array(0), rms }
    }

    outFloat = new Float32Array(outLen)
    for (let i = 0; i < outLen; i++) {
      const pos = spnPhase + i * ratio
      const i0 = Math.floor(pos)
      const i1 = Math.min(i0 + 1, merged.length - 1)
      const frac = pos - i0
      outFloat[i] = merged[i0] * (1 - frac) + merged[i1] * frac
    }

    const consumed = spnPhase + outLen * ratio
    const keepFrom = Math.floor(consumed)
    spnPhase = consumed - keepFrom
    spnTail = keepFrom < merged.length ? merged.slice(keepFrom) : new Float32Array(0)
  }

  const int16 = new Int16Array(outFloat.length)
  for (let i = 0; i < outFloat.length; i++) {
    const s = Math.max(-1, Math.min(1, outFloat[i]))
    int16[i] = s < 0 ? s * 32768 : s * 32767
  }

  return { pcm: int16, rms }
}

/** Wire up ScriptProcessorNode as fallback when AudioWorklet fails */
function setupScriptProcessorFallback(ctx: AudioContext, src: MediaStreamAudioSourceNode) {
  usingFallback = true
  spnTail = new Float32Array(0)
  spnPhase = 0
  actualSampleRate = TARGET_SAMPLE_RATE

  // Disconnect worklet if it was connected
  if (workletNode) {
    try { workletNode.port.onmessage = null } catch { /* ignore */ }
    try { workletNode.disconnect() } catch { /* ignore */ }
    try { src.disconnect(workletNode) } catch { /* ignore */ }
    workletNode = null
  }

  // 4096 samples buffer — good balance between latency and efficiency
  const spn = ctx.createScriptProcessor(4096, 1, 1)
  scriptNode = spn

  let totalPCMBytes = 0
  let totalPCMFrames = 0
  let captureStartTime = performance.now()

  spn.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0)
    const { pcm, rms } = resampleToInt16(input, ctx.sampleRate)

    if (!firstRmsLogged && rms > 0) {
      firstRmsLogged = true
      addRuntimeEvent('info', 'audio', '收到首个 RMS (ScriptProcessor)', {
        rms: Number(rms.toFixed(6)),
        sampleRate: TARGET_SAMPLE_RATE,
      })
    }
    onVolumeChange?.(rms)

    if (pcm.length > 0) {
      const pcmBuffer = pcm.buffer as ArrayBuffer
      totalPCMBytes += pcmBuffer.byteLength
      totalPCMFrames++

      if (!firstPCMFrameLogged) {
        firstPCMFrameLogged = true
        captureStartTime = performance.now()
        let peak = 0
        for (let i = 0; i < pcm.length; i++) {
          const value = Math.abs(pcm[i])
          if (value > peak) peak = value
        }
        addRuntimeEvent('info', 'audio', '收到首个 PCM 帧 (ScriptProcessor)', {
          samples: pcm.length,
          peak,
          byteLength: pcmBuffer.byteLength,
          sampleRate: TARGET_SAMPLE_RATE,
        })
        console.log('[audio-diag] 首个 PCM 帧 (ScriptProcessor)', {
          samples: pcm.length,
          byteLength: pcmBuffer.byteLength,
          contextSampleRate: ctx.sampleRate,
          targetSampleRate: TARGET_SAMPLE_RATE,
        })
      }

      if (totalPCMFrames % 100 === 0) {
        const elapsedSec = (performance.now() - captureStartTime) / 1000
        const pcmDurationSec = (totalPCMBytes / 2) / 16000
        console.log('[audio-diag] PCM 累计 (ScriptProcessor)', {
          frames: totalPCMFrames,
          totalBytes: totalPCMBytes,
          wallTimeSec: elapsedSec.toFixed(2),
          pcmDurationSec: pcmDurationSec.toFixed(2),
        })
      }

      onPCMFrame?.(pcm)
      onAudioData?.(pcmBuffer)
    }
  }

  src.connect(spn)
  // ScriptProcessorNode requires an output connection to work
  spn.connect(ctx.destination)
  console.log('[audio-diag] ScriptProcessorNode fallback active')
  addRuntimeEvent('info', 'audio', 'ScriptProcessorNode 兜底已激活', {
    bufferSize: 4096,
    inputSampleRate: ctx.sampleRate,
    targetSampleRate: TARGET_SAMPLE_RATE,
  })
}

/** 尝试加载 AudioWorklet 模块（data URL → Blob URL 两种方式） */
async function tryLoadAudioWorklet(ctx: AudioContext): Promise<boolean> {
  try {
    const dataUrl = 'data:application/javascript;base64,' + btoa(PCM_WORKLET_CODE)
    await Promise.race([
      ctx.audioWorklet.addModule(dataUrl),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('addModule timeout')), 3000)),
    ])
    console.log('[audio-diag] AudioWorklet module loaded (data URL)')
    return true
  } catch (dataUrlErr) {
    console.warn('[audio-diag] data URL addModule failed:', dataUrlErr)
  }

  try {
    const blob = new Blob([PCM_WORKLET_CODE], { type: 'application/javascript' })
    const blobUrl = URL.createObjectURL(blob)
    try {
      await Promise.race([
        ctx.audioWorklet.addModule(blobUrl),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('addModule timeout')), 3000)),
      ])
      console.log('[audio-diag] AudioWorklet module loaded (Blob URL)')
      return true
    } finally {
      URL.revokeObjectURL(blobUrl)
    }
  } catch (blobErr) {
    console.warn('[audio-diag] Blob URL addModule also failed:', blobErr)
  }

  return false
}

/** 创建 AudioWorkletNode 并绑定 onmessage 处理 */
function setupAudioWorkletNode(ctx: AudioContext, src: MediaStreamAudioSourceNode): AudioWorkletNode {
  const node = new AudioWorkletNode(ctx, 'pcm-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    processorOptions: {
      targetRate: TARGET_SAMPLE_RATE,
      inputRate: ctx.sampleRate,
    },
  })

  addRuntimeEvent('info', 'audio', 'AudioContext 就绪', {
    contextState: ctx.state,
    inputSampleRate: ctx.sampleRate,
    targetSampleRate: TARGET_SAMPLE_RATE,
    ratio: (ctx.sampleRate / TARGET_SAMPLE_RATE).toFixed(4),
  })

  let totalPCMBytes = 0
  let totalPCMFrames = 0
  let captureStartTime = performance.now()

  node.port.onmessage = (e) => {
    // 标记已收到 worklet 数据（用于外部静默检测）
    node.dispatchEvent(new Event('worklet-data'))

    if (typeof e.data.sampleRate === 'number') {
      actualSampleRate = e.data.sampleRate
    }

    if (typeof e.data.rms === 'number') {
      if (!firstRmsLogged) {
        firstRmsLogged = true
        addRuntimeEvent('info', 'audio', '收到首个 RMS', {
          rms: Number(e.data.rms.toFixed(6)),
          sampleRate: actualSampleRate,
        })
      }
      onVolumeChange?.(e.data.rms)
    }

    const pcmBuffer = e.data.pcm as ArrayBuffer | undefined
    if (pcmBuffer && pcmBuffer.byteLength > 0) {
      const pcmFrame = new Int16Array(pcmBuffer)
      totalPCMBytes += pcmBuffer.byteLength
      totalPCMFrames++
      if (!firstPCMFrameLogged) {
        firstPCMFrameLogged = true
        captureStartTime = performance.now()
        let peak = 0
        for (let i = 0; i < pcmFrame.length; i++) {
          const value = Math.abs(pcmFrame[i])
          if (value > peak) peak = value
        }
        addRuntimeEvent('info', 'audio', '收到首个 PCM 帧', {
          samples: pcmFrame.length,
          peak,
          byteLength: pcmBuffer.byteLength,
          sampleRate: actualSampleRate,
        })
        console.log('[audio-diag] 首个 PCM 帧', {
          samples: pcmFrame.length,
          byteLength: pcmBuffer.byteLength,
          contextSampleRate: audioCtx?.sampleRate,
          targetSampleRate: TARGET_SAMPLE_RATE,
          actualSampleRate,
        })
      }
      if (totalPCMFrames % 5000 === 0) {
        const elapsedSec = (performance.now() - captureStartTime) / 1000
        const pcmDurationSec = (totalPCMBytes / 2) / 16000
        console.log('[audio-diag] PCM 累计', {
          frames: totalPCMFrames,
          totalBytes: totalPCMBytes,
          wallTimeSec: elapsedSec.toFixed(2),
          pcmDurationSec: pcmDurationSec.toFixed(2),
        })
      }
      onPCMFrame?.(pcmFrame)
      onAudioData?.(pcmBuffer)
    }
  }

  src.connect(node)
  console.log('[audio-diag] sourceNode connected to workletNode')
  return node
}

export async function startCapture(
  deviceId: string | undefined,
  onData: (buffer: ArrayBuffer) => void,
  onVolume?: (volume: number) => void,
  onFrame?: (pcm: Int16Array) => void,
) {
  // Always tear down previous capture to prevent stale state leaks
  const hadPriorCtx = audioCtx !== null
  const hadPriorWorklet = workletNode !== null
  const hadPriorStream = mediaStream !== null
  if (hadPriorCtx || hadPriorWorklet || hadPriorStream) {
    console.warn('[audio-diag] startCapture 发现残留状态，正在清理', {
      hadAudioCtx: hadPriorCtx,
      priorCtxState: audioCtx?.state,
      hadWorklet: hadPriorWorklet,
      hadStream: hadPriorStream,
    })
    addRuntimeEvent('warn', 'audio', 'startCapture 清理残留状态', {
      hadAudioCtx: hadPriorCtx,
      priorCtxState: audioCtx?.state,
      hadWorklet: hadPriorWorklet,
      hadStream: hadPriorStream,
    })
  }
  await teardownCapture()

  onAudioData = onData
  onVolumeChange = onVolume ?? null
  onPCMFrame = onFrame ?? null
  firstPCMFrameLogged = false
  firstRmsLogged = false
  actualSampleRate = TARGET_SAMPLE_RATE
  usingFallback = false

  const wanted = deviceId || undefined
  const constraints = buildAudioConstraints(wanted)

  try {
    const t0 = performance.now()
    // 优先复用预热流：后台 WKWebView 里重新 getUserMedia 会挂起数秒到永远
    if (isStreamLive(warmStream) && warmDeviceId === wanted) {
      mediaStream = warmStream
      warmStream = null // 会话占用中
      addRuntimeEvent('info', 'audio', '复用预热麦克风流', {
        requestedDeviceId: wanted || 'default',
        elapsedMs: Math.round(performance.now() - t0),
      })
      console.log('[audio-diag] reusing warm MediaStream', { deviceId: wanted || 'default' })
    } else {
      console.log('[audio-diag] getUserMedia starting...', { deviceId: wanted || 'default' })
      addRuntimeEvent('info', 'audio', 'getUserMedia 开始', { deviceId: wanted || 'default' })
      mediaStream = await getUserMediaWithTimeout(constraints)
      warmDeviceId = wanted
      addRuntimeEvent('info', 'audio', 'getUserMedia 成功', {
        deviceId: wanted || 'default',
        elapsedMs: Math.round(performance.now() - t0),
      })
    }

    const stream = mediaStream
    if (!stream) {
      throw new Error('麦克风流为空')
    }

    // 确保 track 开启
    stream.getAudioTracks().forEach((t) => {
      if (!t.enabled) t.enabled = true
    })

    const track = stream.getAudioTracks()[0] || null
    const settings = track?.getSettings?.()

    console.log('[audio-diag] getUserMedia success', {
      trackCount: stream.getAudioTracks().length,
      trackLabel: track?.label,
      trackEnabled: track?.enabled,
      trackMuted: track?.muted,
      trackReadyState: track?.readyState,
      settings,
    })

    addRuntimeEvent('info', 'audio', '麦克风采集已启动', {
      requestedDeviceId: wanted || 'default',
      trackLabel: track?.label || '',
      trackSettings: settings || null,
      elapsedMs: Math.round(performance.now() - t0),
    })

    audioCtx = createAudioContext()
    actualSampleRate = audioCtx.sampleRate || TARGET_SAMPLE_RATE
    console.log('[audio-diag] AudioContext created', {
      state: audioCtx.state,
      sampleRate: audioCtx.sampleRate,
    })

    sourceNode = audioCtx.createMediaStreamSource(stream)

    // Try AudioWorklet, with ScriptProcessor fallback
    const fallbackCtx = audioCtx
    const fallbackSrc = sourceNode
    const fallbackTimerId = setTimeout(() => {
      if (!usingFallback && fallbackCtx === audioCtx && fallbackSrc === sourceNode) {
        console.warn('[audio-diag] AudioWorklet 超时 (1.5s)，切换到 ScriptProcessorNode')
        addRuntimeEvent('warn', 'audio', 'AudioWorklet 超时，切换 ScriptProcessorNode 兜底')
        setupScriptProcessorFallback(fallbackCtx, fallbackSrc)
      }
    }, 1500)

    const workletLoaded = await tryLoadAudioWorklet(audioCtx)

    if (audioCtx.state === 'suspended') {
      console.log('[audio-diag] AudioContext is suspended, resuming...')
      await audioCtx.resume()
      console.log('[audio-diag] AudioContext resumed, state:', audioCtx.state)
    }

    if (!workletLoaded) {
      clearTimeout(fallbackTimerId)
      if (!usingFallback) {
        console.log('[audio-diag] AudioWorklet unavailable, using ScriptProcessorNode directly')
        setupScriptProcessorFallback(audioCtx, sourceNode)
      }
      return
    }

    clearTimeout(fallbackTimerId)
    if (usingFallback) {
      console.log('[audio-diag] ScriptProcessorNode already active, skipping worklet setup')
      return
    }

    // AudioWorklet loaded — set up node and monitor for data
    workletNode = setupAudioWorkletNode(audioCtx, sourceNode)

    // Secondary monitor: if worklet loaded but no data within 800ms, switch
    let gotWorkletData = false
    workletNode.addEventListener('worklet-data', () => { gotWorkletData = true }, { once: true })
    setTimeout(() => {
      if (!gotWorkletData && !usingFallback && fallbackCtx === audioCtx && fallbackSrc === sourceNode) {
        console.warn('[audio-diag] AudioWorklet 未产生数据 (800ms)，切换到 ScriptProcessorNode')
        addRuntimeEvent('warn', 'audio', 'AudioWorklet 静默，切换 ScriptProcessorNode 兜底')
        setupScriptProcessorFallback(fallbackCtx, fallbackSrc)
      }
    }, 800)

  } catch (error) {
    await teardownCapture()
    addRuntimeEvent('error', 'audio', '启动麦克风采集失败', {
      requestedDeviceId: deviceId || 'default',
      error: String(error),
    })
    throw error
  }
}

export async function stopCapture() {
  const finalCtxRate = audioCtx?.sampleRate
  console.log('[audio-diag] stopCapture 最终汇总', {
    contextSampleRate: finalCtxRate,
    actualSampleRate,
    targetSampleRate: TARGET_SAMPLE_RATE,
    usingFallback,
  })
  addRuntimeEvent('info', 'audio', '采集停止汇总', {
    contextSampleRate: finalCtxRate,
    actualSampleRate,
    targetSampleRate: TARGET_SAMPLE_RATE,
    usingFallback,
  })

  await teardownCapture()

  onAudioData = null
  onVolumeChange = null
  onPCMFrame = null
}
