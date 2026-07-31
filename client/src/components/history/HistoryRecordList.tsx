import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Trash2, ChevronDown, ChevronUp, VolumeX, Star, Play, Pause, RotateCcw, Loader2, Download, Check, Copy, X, FolderOpen, Pencil, GraduationCap } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { Card, CardContent } from '@/components/ui/card'
import { type HistoryRecord } from '@/services/store'
import * as bridge from '@/services/bridge'
import { pickVoiceDurationSec } from '@/services/timeModel'
import { loadAudioAsDataUrl } from '@/services/audioFileService'
import { invoke } from '@tauri-apps/api/core'
import {
  buildLearningFingerprint,
  canLearnFromRecord,
  explainHistoryRecord,
  isLearningCacheFresh,
  isLikelyTranslationRecord,
  learningCacheToPersistPayload,
  parseLearningCache,
  type LearningCacheV1,
  type LearningContentV1,
  type LearningPersistPayload,
} from '@/services/translationLearning'

/** 云 API 内部 key → 用户友好的模型 ID */
const ASR_PROVIDER_DISPLAY: Record<string, string> = {
  doubao_v2: 'Doubao-Seed-ASR-2.0',
  doubao: 'Doubao-Seed-ASR',
  qwen: 'qwen3-asr-flash',
  qwen_omni_35_plus: 'qwen3.5-omni-plus-realtime',
  qwen_omni_35_flash: 'qwen3.5-omni-flash-realtime',
  qwen_omni_flash: 'qwen3-omni-flash-realtime',
  qwen_omni_turbo: 'qwen-omni-turbo-realtime',
  qwen_omni_plus: 'qwen3.5-omni-plus-realtime',
}

interface HistoryRecordListProps {
  records: HistoryRecord[]
  onDelete: (id: string) => Promise<void> | void
  onToggleFavorite?: (id: string, nextFavorite: boolean) => Promise<void> | void
  onReprocess?: (record: HistoryRecord) => Promise<void> | void
  /** 手工编辑转换结果并保存 */
  onEdit?: (id: string, nextText: string) => Promise<void> | void
  /** 缓存「学习」讲解到历史记录（结构化 v1 + 兼容 notes） */
  onLearningNotes?: (id: string, payload: LearningPersistPayload) => Promise<void> | void
  emptyText?: string
  /** 搜索关键词：在正文与 ASR 原文里高亮命中处 */
  highlight?: string
}

function getDayLabel(ts: number): string {
  const now = new Date()
  const date = new Date(ts)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const recordDay = new Date(date.getFullYear(), date.getMonth(), date.getDate())

  const dateStr = date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
  if (recordDay.getTime() === today.getTime()) return `今天 · ${dateStr}`
  if (recordDay.getTime() === yesterday.getTime()) return `昨天 · ${dateStr}`
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/** 把 text 中命中 keyword 的子串用 <mark> 高亮（大小写不敏感，用 indexOf 避免正则特殊字符问题）。 */
function highlightText(text: string, keyword: string) {
  const kw = keyword.trim()
  if (!kw) return text
  const lower = text.toLowerCase()
  const kwLower = kw.toLowerCase()
  const parts: Array<string | JSX.Element> = []
  let from = 0
  let idx = lower.indexOf(kwLower, from)
  let key = 0
  while (idx !== -1) {
    if (idx > from) parts.push(text.slice(from, idx))
    parts.push(
      <mark key={key++} className="rounded-sm bg-amber-200/70 px-0.5 text-inherit dark:bg-amber-500/30">
        {text.slice(idx, idx + kw.length)}
      </mark>,
    )
    from = idx + kw.length
    idx = lower.indexOf(kwLower, from)
  }
  if (from < text.length) parts.push(text.slice(from))
  return parts
}

function HistoryItem({
  record,
  onDelete,
  onToggleFavorite,
  onReprocess,
  onEdit,
  onLearningNotes,
  highlight = '',
}: {
  record: HistoryRecord
  onDelete: () => void
  onToggleFavorite?: (nextFavorite: boolean) => void
  onReprocess?: () => Promise<void> | void
  onEdit?: (nextText: string) => Promise<void> | void
  onLearningNotes?: (payload: LearningPersistPayload) => Promise<void> | void
  highlight?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState('')
  const [audioPlaying, setAudioPlaying] = useState(false)
  const [audioLoading, setAudioLoading] = useState(false)
  const [reprocessing, setReprocessing] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadStatus, setDownloadStatus] = useState<'idle' | 'ok' | 'fail'>('idle')
  const [downloadPath, setDownloadPath] = useState('')
  const [copied, setCopied] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [audioReady, setAudioReady] = useState(false)
  const [learningOpen, setLearningOpen] = useState(false)
  const [learningLoading, setLearningLoading] = useState(false)
  const [learningError, setLearningError] = useState('')
  const [learningSaveWarn, setLearningSaveWarn] = useState('')
  const [learningNotes, setLearningNotes] = useState(record.learningNotes || '')
  const [learningCache, setLearningCache] = useState<LearningCacheV1 | null>(
    () => parseLearningCache(record.learningCache) ,
  )
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef<string>('')
  const rafRef = useRef<number>(0)
  const learningInFlightRef = useRef(false)
  const learningFingerprintRef = useRef('')

  const text = record.llmText || record.asrText
  const isEmpty = record.isEmpty || (!text && record.charCount === 0)
  const canLearn = canLearnFromRecord(record)
  const learnIsTranslation = isLikelyTranslationRecord(record)
  const cacheFresh = isLearningCacheFresh(learningCache, record)
  const hasLearning = cacheFresh || !!(learningNotes && learningNotes.trim())

  useEffect(() => {
    setLearningNotes(record.learningNotes || '')
    setLearningCache(parseLearningCache(record.learningCache))
    setLearningError('')
    setLearningSaveWarn('')
  }, [record.id, record.learningNotes, record.learningCache, record.asrText, record.llmText, record.promptPresetId])

  const runLearning = useCallback(async (force: boolean) => {
    if (!canLearn) return
    if (learningInFlightRef.current) return
    setLearningOpen(true)
    setLearningError('')
    setLearningSaveWarn('')

    // 已有缓存内容：只展开，不自动重请求（过期提示在面板内；点「重新生成」才 force）
    if (!force && learningCache?.content) return
    if (!force && learningNotes.trim()) return

    learningInFlightRef.current = true
    setLearningLoading(true)
    const expectedFp = buildLearningFingerprint(record)
    learningFingerprintRef.current = expectedFp

    try {
      const cache = await explainHistoryRecord(record)
      // 请求期间文本/preset 变了：丢弃迟到响应，防止覆盖新内容
      if (buildLearningFingerprint(record) !== expectedFp) {
        return
      }
      setLearningCache(cache)
      setLearningNotes(cache.content.summaryZh)
      if (onLearningNotes) {
        try {
          await onLearningNotes(learningCacheToPersistPayload(cache))
        } catch {
          setLearningSaveWarn('讲解已生成，但未能写入本地缓存')
        }
      }
    } catch (err) {
      setLearningError(String(err))
    } finally {
      learningInFlightRef.current = false
      setLearningLoading(false)
    }
  }, [canLearn, learningCache, learningNotes, onLearningNotes, record])

  const handleLearn = useCallback(async () => {
    await runLearning(false)
  }, [runLearning])

  const handleRefreshLearn = useCallback(async () => {
    await runLearning(true)
  }, [runLearning])
  const voiceDurationSec = pickVoiceDurationSec({
    holdSec: record.durationSec,
    audioSec: record.audioDurationSec,
    asrSec: record.asrDurationSec,
  })

  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current)
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current)
        audioUrlRef.current = ''
      }
    }
  }, [])

  // Sync time via requestAnimationFrame for smooth progress
  useEffect(() => {
    function tick() {
      if (audioRef.current) {
        setCurrentTime(audioRef.current.currentTime)
      }
      if (audioPlaying) {
        rafRef.current = requestAnimationFrame(tick)
      }
    }
    if (audioPlaying) {
      rafRef.current = requestAnimationFrame(tick)
    }
    return () => cancelAnimationFrame(rafRef.current)
  }, [audioPlaying])

  const handleTogglePlayback = useCallback(async () => {
    if (!record.audioFilePath) return

    // If already playing, pause
    if (audioRef.current && audioPlaying) {
      audioRef.current.pause()
      setAudioPlaying(false)
      return
    }

    // If we have an audio element ready, resume
    if (audioRef.current && audioUrlRef.current) {
      audioRef.current.playbackRate = playbackRate
      await audioRef.current.play()
      setAudioPlaying(true)
      return
    }

    // Load audio file
    setAudioLoading(true)
    try {
      const dataUrl = await loadAudioAsDataUrl(record.audioFilePath)
      if (!dataUrl) {
        setAudioLoading(false)
        return
      }
      const audio = new Audio(dataUrl)
      audioRef.current = audio
      audioUrlRef.current = dataUrl
      audio.playbackRate = playbackRate
      audio.onloadedmetadata = () => {
        setDuration(audio.duration)
        setAudioReady(true)
      }
      // 原生 timeupdate 兜底：远程桌面 / 窗口失焦时 requestAnimationFrame 会被降频甚至暂停，
      // 导致进度条卡住。timeupdate 是媒体事件，不受 rAF 节流影响，保证进度稳定推进。
      audio.ontimeupdate = () => setCurrentTime(audio.currentTime)
      audio.onended = () => {
        setAudioPlaying(false)
        setCurrentTime(0)
      }
      audio.onpause = () => setAudioPlaying(false)
      audio.onplay = () => setAudioPlaying(true)
      await audio.play()
    } catch {
      // ignore playback errors
    } finally {
      setAudioLoading(false)
    }
  }, [record.audioFilePath, audioPlaying, playbackRate])

  const handleReprocess = useCallback(async () => {
    if (!onReprocess || reprocessing) return
    setReprocessing(true)
    try {
      await onReprocess()
    } finally {
      setReprocessing(false)
    }
  }, [onReprocess, reprocessing])

  // ── 编辑：自动保存（失焦 / 离开页面即存，无需按钮）──
  // 用 ref 保存最新值，供失焦回调与卸载清理读取，避免闭包拿到旧值。
  const editTextRef = useRef('')
  const editingRef = useRef(false)
  const textRef = useRef(text)
  const onEditRef = useRef(onEdit)
  textRef.current = text
  onEditRef.current = onEdit

  const startEdit = useCallback(() => {
    editTextRef.current = text
    editingRef.current = true
    setEditText(text)
    setEditing(true)
  }, [text])

  // 提交：仅当仍在编辑且内容有变化时写回。幂等——重复调用（失焦后又卸载）不会重复保存。
  const commitEdit = useCallback(async () => {
    if (!editingRef.current) return
    editingRef.current = false
    setEditing(false)
    const next = editTextRef.current
    if (!onEditRef.current || next === textRef.current) return
    await onEditRef.current(next)
  }, [])

  // 取消：不保存，直接退出（后续失焦/卸载因 editingRef=false 而跳过）。
  const cancelEdit = useCallback(() => {
    editingRef.current = false
    setEditing(false)
  }, [])

  // 离开页面（组件卸载）时若仍在编辑，自动保存。
  useEffect(() => () => { void commitEdit() }, [commitEdit])

  const handleDownloadAudio = useCallback(async () => {
    if (!record.audioFilePath || downloading) return
    setDownloading(true)
    setDownloadStatus('idle')
    setDownloadPath('')
    try {
      const dataUrl = await loadAudioAsDataUrl(record.audioFilePath)
      if (!dataUrl) {
        setDownloadStatus('fail')
        setDownloadPath('音频文件不存在')
        setTimeout(() => setDownloadStatus('idle'), 3000)
        return
      }

      const ts = new Date(record.timestamp)
      const dateStr = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}_${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}`
      const filename = `sayit_${dateStr}.wav`

      // Extract base64 from data URL
      const base64Data = dataUrl.split(',')[1]
      const savedPath = await invoke<string>('save_audio_to_downloads', {
        base64Data,
        filename,
      })

      setDownloadStatus('ok')
      setDownloadPath(savedPath)
      setTimeout(() => setDownloadStatus('idle'), 5000)
    } catch (err) {
      setDownloadStatus('fail')
      setDownloadPath(String(err))
      setTimeout(() => setDownloadStatus('idle'), 3000)
    } finally {
      setDownloading(false)
    }
  }, [record.audioFilePath, record.timestamp, downloading])

  const handleSeek = useCallback((value: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = value
      setCurrentTime(value)
    }
  }, [])

  const handleRateChange = useCallback((rate: number) => {
    setPlaybackRate(rate)
    if (audioRef.current) {
      audioRef.current.playbackRate = rate
    }
  }, [])

  const formatElapsed = (value: number) => {
    const safe = Number.isFinite(value) ? Math.max(0, value) : 0
    const m = Math.floor(safe / 60)
    const s = Math.floor(safe % 60)
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  const progress = duration > 0 ? Math.min(currentTime / duration, 1) : 0

  return (
    <div className="group rounded-md transition-colors hover:bg-accent/50">
      <div className="flex items-start gap-2 px-2 py-2">
        <span className="w-12 shrink-0 pt-0.5 text-xs text-muted-foreground">
          {formatTime(record.timestamp)}
        </span>

        <div className="min-w-0 flex-1">
          {editing ? (
            <div onClick={(e) => e.stopPropagation()}>
              <textarea
                value={editText}
                onChange={(e) => { setEditText(e.target.value); editTextRef.current = e.target.value }}
                autoFocus
                rows={Math.min(Math.max(editText.split('\n').length, 2), 12)}
                className="w-full resize-y rounded-md border border-input-border bg-input-bg px-2.5 py-1.5 text-sm leading-relaxed focus:border-input-focus-border focus:outline-none"
                onBlur={() => { void commitEdit() }}
                onKeyDown={(e) => {
                  // Esc 取消（不保存）；Ctrl/Cmd+Enter 立即保存（失焦触发提交）
                  if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur() }
                }}
              />
              <span className="mt-1 inline-block text-[11px] text-muted-foreground/50">改完点击其它地方即自动保存 · Esc 取消</span>
            </div>
          ) : isEmpty ? (
            <div className="flex items-center gap-2">
              <VolumeX className="h-3.5 w-3.5 text-muted-foreground/40" />
              <p className="text-sm italic text-muted-foreground/60">无有效声音</p>
            </div>
          ) : (
            <div
              className="cursor-pointer text-sm leading-relaxed text-foreground/75 select-text transition-colors hover:text-foreground"
              onClick={() => {
                const selection = window.getSelection()
                if (selection && selection.toString().trim()) return
                void bridge.copyText(text).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                })
              }}
            >
              {(() => {
                // 编辑过的记录：在正文末尾内联一个小铅笔图标（hover 提示「已编辑」），不占额外行、不混入正文文本
                const editedMark = record.manualEditedAt ? (
                  <Tooltip content="已编辑">
                    <Pencil className="ml-1 inline-block h-3 w-3 translate-y-[1px] text-muted-foreground/40" />
                  </Tooltip>
                ) : null
                if (text.includes('\n')) {
                  const paras = text.split(/\n{2,}/)
                  return paras.map((para, idx) => (
                    <p key={idx} className={idx > 0 ? 'mt-1.5' : undefined}>
                      {highlightText(para, highlight)}
                      {idx === paras.length - 1 && editedMark}
                    </p>
                  ))
                }
                return <p>{highlightText(text, highlight)}{editedMark}</p>
              })()}
            </div>
          )}

          <div
            className="grid transition-[grid-template-rows] duration-200 ease-out"
            style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
          >
            <div className="overflow-hidden">
              {(expanded || true) && (
                <div className="mt-2 space-y-2 text-xs">
                  {!isEmpty && record.asrText && (
                    <div className="text-muted-foreground">
                      <span className="font-medium">ASR 原文：</span>
                      <span className="whitespace-pre-line">{highlightText(record.asrText, highlight)}</span>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                    {record.workMode && (
                      <>
                        <span className="rounded border border-border px-1.5 py-0.5 text-xs">
                          {record.workMode === 'server' ? '服务器' : record.workMode === 'cloud_api' ? '云 API' : '本地'}
                        </span>
                        {record.asrProvider && (
                          <span className="text-xs">ASR: {ASR_PROVIDER_DISPLAY[record.asrProvider] || record.asrProvider}</span>
                        )}
                        {record.aiProvider && record.aiProvider !== 'server' && record.llmMs > 0 && (
                          <span className="text-xs">
                            AI: {record.aiProvider}{record.aiModel ? ` (${record.aiModel})` : ''}
                          </span>
                        )}
                        <span className="text-border">|</span>
                      </>
                    )}
                    <span>语音长度 {voiceDurationSec.toFixed(1)}s</span>
                    <span className="text-border">|</span>
                    <span>识别 {((record.asrMs + record.llmMs) / 1000).toFixed(1)}s (ASR {record.asrMs}ms + LLM {record.llmMs}ms)</span>
                    {record.audioFilePath && (
                      <Tooltip content={audioPlaying ? '暂停播放' : '播放录音'}>
                        <button
                          type="button"
                          onClick={() => { void handleTogglePlayback() }}
                          disabled={audioLoading}
                          className="relative top-[0.5px] flex h-7 w-7 items-center justify-center rounded p-1.5 hover:bg-accent disabled:opacity-50"
                          aria-label={audioPlaying ? '暂停播放' : '播放录音'}
                        >
                          {audioLoading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          ) : audioPlaying ? (
                            <Pause className="h-3.5 w-3.5 text-primary" />
                          ) : (
                            <Play className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </button>
                      </Tooltip>
                    )}
                    {record.audioFilePath && (
                      <Tooltip content={downloadStatus === 'ok' ? `已保存到 ${downloadPath}` : downloadStatus === 'fail' ? `下载失败: ${downloadPath}` : '下载音频'}>
                        <button
                          type="button"
                          onClick={() => { void handleDownloadAudio() }}
                          disabled={downloading}
                          className="relative top-[0.5px] flex h-7 w-7 items-center justify-center rounded p-1.5 hover:bg-accent disabled:opacity-50"
                          aria-label="下载音频"
                        >
                          {downloading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          ) : downloadStatus === 'ok' ? (
                            <Check className="h-3.5 w-3.5 text-success" />
                          ) : downloadStatus === 'fail' ? (
                            <X className="h-3.5 w-3.5 text-destructive" />
                          ) : (
                            <Download className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </button>
                      </Tooltip>
                    )}
                    {record.audioFilePath && onReprocess && (
                      <Tooltip content="重新识别">
                        <button
                          type="button"
                          onClick={() => { void handleReprocess() }}
                          disabled={reprocessing}
                          className="relative top-[0.5px] flex h-7 w-7 items-center justify-center rounded p-1.5 hover:bg-accent disabled:opacity-50"
                          aria-label="重新识别"
                        >
                          {reprocessing ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          ) : (
                            <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </button>
                      </Tooltip>
                    )}
                  </div>
                  {downloadStatus === 'ok' && downloadPath && (
                    <div className="mt-1 flex items-center gap-2 text-xs text-success break-all">
                      <span className="min-w-0 truncate">已保存到 {downloadPath}</span>
                      <button
                        onClick={() => void invoke('reveal_file_in_folder', { filePath: downloadPath })}
                        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        aria-label="打开文件所在目录"
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                  {downloadStatus === 'fail' && downloadPath && (
                    <div className="mt-1 text-xs text-destructive break-all">
                      下载失败: {downloadPath}
                    </div>
                  )}
                  {learningOpen && (
                    <div className="mt-2 rounded-md border border-sky-500/25 bg-sky-500/5 p-3 text-xs leading-relaxed text-foreground">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium text-sky-800 dark:text-sky-200">
                          {learnIsTranslation ? '翻译学习' : '润色学习'}
                        </span>
                        <div className="flex items-center gap-1">
                          {(hasLearning || learningError) && !learningLoading && (
                            <button
                              type="button"
                              onClick={() => { void handleRefreshLearn() }}
                              className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                            >
                              重新生成
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setLearningOpen(false)}
                            className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                          >
                            收起
                          </button>
                        </div>
                      </div>
                      <div className="mb-2 space-y-1 text-muted-foreground">
                        <p>
                          <span className="font-medium text-foreground/80">原文：</span>
                          <span className="whitespace-pre-line">{record.asrText}</span>
                        </p>
                        <p>
                          <span className="font-medium text-foreground/80">输出：</span>
                          <span className="whitespace-pre-line">{record.llmText}</span>
                        </p>
                      </div>
                      {learningLoading && (
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          正在生成讲解…
                        </div>
                      )}
                      {learningError && (
                        <p className="text-destructive">{learningError}</p>
                      )}
                      {learningSaveWarn && (
                        <p className="text-amber-700 dark:text-amber-300">{learningSaveWarn}</p>
                      )}
                      {!learningLoading && learningCache?.content && (
                        <>
                          {!cacheFresh && (
                            <p className="mb-2 text-[11px] text-amber-700 dark:text-amber-300">
                              文本或模式已变更，讲解可能过期，建议重新生成
                            </p>
                          )}
                          <LearningContentView
                            content={learningCache.content}
                            mode={learningCache.mode}
                            isTranslation={learnIsTranslation}
                          />
                        </>
                      )}
                      {!learningLoading && !learningCache?.content && learningNotes.trim() && (
                        <div className="whitespace-pre-wrap border-t border-border/60 pt-2 text-[12px] leading-relaxed">
                          <p className="mb-1 text-[11px] text-muted-foreground">旧版讲解（重新生成可升级为结构化）</p>
                          {learningNotes}
                        </div>
                      )}
                    </div>
                  )}
                  {/* 音频进度条 + 倍速 */}
                  {audioReady && (
                    <div className="mt-2 flex items-center gap-2">
                      <span className="w-[72px] shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {formatElapsed(currentTime)} / {formatElapsed(duration)}
                      </span>
                      <div className="relative h-3 min-w-0 flex-1 overflow-visible">
                        <div className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-border" />
                        <div className="absolute left-0 top-1/2 h-px -translate-y-1/2 bg-foreground" style={{ width: `${progress * 100}%` }} />
                        <div
                          className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-foreground bg-card shadow-sm"
                          style={{ left: `${progress * 100}%` }}
                        />
                        <input
                          type="range"
                          min={0}
                          max={Math.max(duration, 0.1)}
                          step={0.1}
                          value={Math.min(currentTime, duration || 0)}
                          onChange={(e) => handleSeek(Number(e.target.value))}
                          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                        />
                      </div>
                      <div className="flex shrink-0 gap-0.5">
                        {[0.75, 1, 1.5, 2, 2.5].map((rate) => (
                          <button
                            key={rate}
                            type="button"
                            onClick={() => handleRateChange(rate)}
                            className={`rounded px-1.5 py-0.5 text-[11px] transition-colors ${playbackRate === rate
                              ? 'bg-foreground text-background font-medium'
                              : 'text-muted-foreground hover:bg-accent'
                              }`}
                          >
                            {rate}x
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {!isEmpty && (
            <Tooltip content={copied ? '已复制' : '复制文本'} forceVisible={copied}>
              <button
                onClick={() => {
                  void bridge.copyText(text).then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  })
                }}
                className="inline-flex items-center rounded p-1 transition-colors hover:bg-accent"
                aria-label="复制"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-success" />
                ) : (
                  <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </button>
            </Tooltip>
          )}

          {canLearn && (
            <Tooltip content={learnIsTranslation ? '学习：为何这样翻译' : '学习：为何这样整理'}>
              <button
                type="button"
                onClick={() => {
                  setExpanded(true)
                  void handleLearn()
                }}
                disabled={learningLoading}
                className="inline-flex items-center rounded p-1 transition-colors hover:bg-accent disabled:opacity-50"
                aria-label="学习"
              >
                {learningLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-600" />
                ) : (
                  <GraduationCap className={`h-3.5 w-3.5 ${hasLearning ? 'text-sky-600' : 'text-muted-foreground'}`} />
                )}
              </button>
            </Tooltip>
          )}

          {!isEmpty && onEdit && !editing && (
            <Tooltip content="编辑文本">
              <button
                onClick={startEdit}
                className="inline-flex items-center rounded p-1 transition-colors hover:bg-accent"
                aria-label="编辑"
              >
                <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </Tooltip>
          )}

          {onToggleFavorite && (
            <Tooltip content={record.favorite ? '取消收藏' : '收藏'}>
              <button
                onClick={() => onToggleFavorite(!record.favorite)}
                className="rounded p-1 hover:bg-accent"
                aria-label={record.favorite ? '取消收藏' : '收藏'}
              >
                <Star className={`h-3.5 w-3.5 ${record.favorite ? 'fill-amber-400 text-amber-500' : 'text-muted-foreground'}`} />
              </button>
            </Tooltip>
          )}

          <Tooltip content={expanded ? '收起详情' : '展开详情'}>
            <button
              onClick={() => setExpanded(!expanded)}
              className="rounded p-1 hover:bg-accent"
              aria-label="详情"
            >
              {expanded ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
            </button>
          </Tooltip>
          <Tooltip content="删除记录">
            <button
              onClick={onDelete}
              className="rounded p-1 hover:bg-accent"
              aria-label="删除"
            >
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}

function DayGroup({
  label,
  records,
  onDelete,
  onToggleFavorite,
  onReprocess,
  onEdit,
  onLearningNotes,
  highlight,
}: {
  label: string
  records: HistoryRecord[]
  onDelete: (id: string) => void
  onToggleFavorite?: (id: string, nextFavorite: boolean) => Promise<void> | void
  onReprocess?: (record: HistoryRecord) => Promise<void> | void
  onEdit?: (id: string, nextText: string) => Promise<void> | void
  onLearningNotes?: (id: string, payload: LearningPersistPayload) => Promise<void> | void
  highlight?: string
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">{label}</h2>
        <div className="divide-y">
          {records.map((record) => (
            <HistoryItem
              key={record.id}
              record={record}
              onDelete={() => onDelete(record.id)}
              onToggleFavorite={onToggleFavorite ? (next) => onToggleFavorite(record.id, next) : undefined}
              onReprocess={onReprocess ? () => onReprocess(record) : undefined}
              onEdit={onEdit ? (nextText) => onEdit(record.id, nextText) : undefined}
              onLearningNotes={
                onLearningNotes ? (payload) => onLearningNotes(record.id, payload) : undefined
              }
              highlight={highlight}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

/** 结构化学习内容卡片；空栏目隐藏 */
function LearningContentView({
  content,
  mode,
  isTranslation,
}: {
  content: LearningContentV1
  mode: LearningCacheV1['mode']
  isTranslation: boolean
}) {
  const translateUi = isTranslation || mode === 'translation'
  const labels = translateUi
    ? {
        summary: '概览',
        vocabulary: '词汇与用法',
        grammar: '语法',
        phrases: '固定表达',
        pitfalls: '易错点',
        variants: '表达变体',
      }
    : {
        summary: '修改概览',
        vocabulary: '词语与术语',
        grammar: '句式与标点',
        phrases: '表达习惯',
        pitfalls: '注意点',
        variants: '可选说法',
      }

  const styleLabel = (s: string) => (s === 'casual' ? '更口语' : s === 'formal' ? '更正式' : s)

  return (
    <div className="space-y-3 border-t border-border/60 pt-2 text-[12px] leading-relaxed">
      {content.summaryZh.trim() && (
        <section>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-sky-800/80 dark:text-sky-200/80">
            {labels.summary}
          </h4>
          <p className="text-foreground">{content.summaryZh}</p>
        </section>
      )}

      {content.vocabulary.length > 0 && (
        <section>
          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-sky-800/80 dark:text-sky-200/80">
            {labels.vocabulary}
          </h4>
          <ul className="space-y-2">
            {content.vocabulary.map((item, i) => (
              <li key={i} className="rounded-md bg-background/60 px-2 py-1.5">
                <div className="font-medium text-foreground">
                  {item.expression}
                  {item.pronunciation && (
                    <span className="ml-1.5 font-normal text-muted-foreground">/{item.pronunciation}/</span>
                  )}
                </div>
                {item.sourceExpression && (
                  <div className="text-muted-foreground">← {item.sourceExpression}</div>
                )}
                <div>{item.meaningZh}</div>
                {item.usageZh && <div className="text-muted-foreground">{item.usageZh}</div>}
                {item.example && (
                  <div className="mt-0.5 text-muted-foreground">
                    例：{item.example.text}
                    {item.example.translationZh ? `（${item.example.translationZh}）` : ''}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {content.grammar.length > 0 && (
        <section>
          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-sky-800/80 dark:text-sky-200/80">
            {labels.grammar}
          </h4>
          <ul className="space-y-2">
            {content.grammar.map((item, i) => (
              <li key={i} className="rounded-md bg-background/60 px-2 py-1.5">
                <div className="font-medium">{item.pattern}</div>
                <div className="text-muted-foreground">文中：{item.excerpt}</div>
                <div>{item.explanationZh}</div>
                {item.example && (
                  <div className="mt-0.5 text-muted-foreground">
                    例：{item.example.text}
                    {item.example.translationZh ? `（${item.example.translationZh}）` : ''}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {content.phrases.length > 0 && (
        <section>
          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-sky-800/80 dark:text-sky-200/80">
            {labels.phrases}
          </h4>
          <ul className="space-y-2">
            {content.phrases.map((item, i) => (
              <li key={i} className="rounded-md bg-background/60 px-2 py-1.5">
                <div className="font-medium">
                  {item.expression}
                  {item.pronunciation && (
                    <span className="ml-1.5 font-normal text-muted-foreground">/{item.pronunciation}/</span>
                  )}
                </div>
                {item.sourceExpression && (
                  <div className="text-muted-foreground">← {item.sourceExpression}</div>
                )}
                <div>{item.meaningZh}</div>
                {item.usageZh && <div className="text-muted-foreground">{item.usageZh}</div>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {content.pitfalls.length > 0 && (
        <section>
          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-sky-800/80 dark:text-sky-200/80">
            {labels.pitfalls}
          </h4>
          <ul className="space-y-2">
            {content.pitfalls.map((item, i) => (
              <li key={i} className="rounded-md bg-background/60 px-2 py-1.5">
                <div className="text-amber-800 dark:text-amber-200">{item.issueZh}</div>
                <div className="text-muted-foreground">{item.adviceZh}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {content.variants.length > 0 && (
        <section>
          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-sky-800/80 dark:text-sky-200/80">
            {labels.variants}
          </h4>
          <ul className="space-y-2">
            {content.variants.map((item, i) => (
              <li key={i} className="rounded-md bg-background/60 px-2 py-1.5">
                <div className="text-[11px] font-medium text-muted-foreground">{styleLabel(item.style)}</div>
                <div className="whitespace-pre-wrap">{item.text}</div>
                {item.noteZh && <div className="text-muted-foreground">{item.noteZh}</div>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

export default function HistoryRecordList({
  records,
  onDelete,
  onToggleFavorite,
  onReprocess,
  onEdit,
  onLearningNotes,
  emptyText = '还没有记录，去语音工作台试试吧',
  highlight,
}: HistoryRecordListProps) {
  const grouped = useMemo(() => {
    return records.reduce((acc, record) => {
      const label = getDayLabel(record.timestamp)
      if (!acc[label]) acc[label] = []
      acc[label].push(record)
      return acc
    }, {} as Record<string, HistoryRecord[]>)
  }, [records])

  const sortedDays = useMemo(() => {
    return Object.keys(grouped).sort((a, b) => {
      const aIsToday = a.startsWith('今天')
      const bIsToday = b.startsWith('今天')
      const aIsYesterday = a.startsWith('昨天')
      const bIsYesterday = b.startsWith('昨天')
      if (aIsToday) return -1
      if (bIsToday) return 1
      if (aIsYesterday) return -1
      if (bIsYesterday) return 1
      return b.localeCompare(a)
    })
  }, [grouped])

  if (records.length === 0) {
    return <p className="py-12 text-center text-muted-foreground">{emptyText}</p>
  }

  return (
    <div className="space-y-3">
      {sortedDays.map((day) => (
        <DayGroup
          key={day}
          label={day}
          records={grouped[day]}
          onDelete={onDelete}
          onToggleFavorite={onToggleFavorite}
          onReprocess={onReprocess}
          onEdit={onEdit}
          onLearningNotes={onLearningNotes}
          highlight={highlight}
        />
      ))}
    </div>
  )
}
