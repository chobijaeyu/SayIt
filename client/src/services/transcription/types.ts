// 转写 Provider 抽象层类型定义
// 所有工作模式（服务器 / 云 API / 本地）共享此接口

import type { ActiveAppContext } from '../../types/appContext'
import type { ClientRuntimeInfo } from '../../types/appApi'

export type WorkMode = 'server' | 'cloud_api' | 'local'

export type ProviderState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface ASRResult {
  text: string
  asrMs: number
  durationSec: number
}

export interface FinalResult {
  asrText: string
  llmText: string
  asrMs: number
  llmMs: number
  durationSec: number
  asrEngine?: string
  asrModel?: string
  /**
   * 跨语种 preset 下 LLM 未成功时置 true：不得把源语言 ASR 原文当结果自动粘贴。
   */
  llmFailed?: boolean
  llmFailReason?: string
}

export interface TranscriptionCallbacks {
  onStateChange?: (state: ProviderState) => void
  onReady?: (info: { connectionId?: string; asr: boolean; llm: boolean }) => void
  /** 流式识别过程中的中间结果（实时上屏用），text 为到目前为止的累计文本 */
  onPartialASR?: (text: string) => void
  onASR?: (result: ASRResult) => void
  onFinal?: (result: FinalResult) => void
  onDone?: () => void
  onError?: (msg: string) => void
}

export interface StartOptions {
  systemPrompt?: string
  disableAi?: boolean
  clientMeta?: ClientRuntimeInfo | null
  appContext?: ActiveAppContext | null
  source?: 'live' | 'history_reprocess'
  hotwords?: string[]
  language?: string
  /** 是否开启流式实时显示：识别过程中把中间结果实时推给悬浮窗 */
  streamingDisplay?: boolean
  /** 当前解析后的 preset id（用于翻译 fail-closed 等） */
  presetId?: string
}

export interface StopOptions {
  pttHoldMs?: number
  audioStats?: {
    avgRms: number
    peakRms: number
    peakAmplitude: number
    silenceRatio: number
    totalFrames: number
  }
}

/**
 * 转写 Provider 接口。
 * RecorderOrchestrator 通过此接口与具体的转写实现交互，
 * 不再直接依赖 WebSocket 或任何特定的后端协议。
 */
export interface TranscriptionProvider {
  readonly mode: WorkMode

  /** 建立连接 / 初始化 */
  connect(callbacks: TranscriptionCallbacks): Promise<void>

  /** 开始一次转写会话 */
  start(opts?: StartOptions): boolean

  /** 发送音频数据（流式，PCM Int16 ArrayBuffer） */
  sendAudio(buffer: ArrayBuffer): void

  /** 结束录音，触发处理 */
  stop(opts?: StopOptions): boolean

  /** 断开连接 / 释放资源 */
  disconnect(): void

  /** 是否已就绪可以开始转写 */
  isReady(): boolean
}
