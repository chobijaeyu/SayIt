// 云 API 模式配置面板

import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import { Eye, EyeOff, ExternalLink, AlertTriangle } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { getSetting, setSetting } from '@/services/store'
import { asrKeyGroup } from '@/services/cloudAsrConfig'
import { isQwenOmniProvider, resolveQwenOmniModel } from '@/lib/asrModels'

const ASR_PROVIDERS = [
  { value: 'openai_compat', label: 'OpenAI 兼容（OpenAI / OpenRouter / 自定义）' },
  { value: 'doubao_v2', label: '豆包 ASR（Doubao-Seed-ASR-2.0，中文质量兜底）' },
  { value: 'qwen', label: '千问 ASR（qwen3-asr-flash）' },
  { value: 'qwen_realtime', label: '千问 ASR 流式（qwen3-asr-flash-realtime）' },
  { value: 'qwen_omni_35_plus', label: '千问 3.5 Omni Plus（qwen3.5-omni-plus，ASR+AI）' },
  { value: 'qwen_omni_35_flash', label: '千问 3.5 Omni Flash（qwen3.5-omni-flash，ASR+AI）' },
  { value: 'mimo', label: '小米 MiMo（mimo-v2.5-asr）' },
]

/** OpenAI 兼容 ASR 的 UI preset（只预填 URL/模型，Rust 仍是单一 openai_compat） */
const OPENAI_ASR_PRESETS = [
  {
    id: 'openai',
    label: 'OpenAI',
    apiUrl: 'https://api.openai.com',
    model: 'gpt-4o-mini-transcribe',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    apiUrl: 'https://openrouter.ai/api',
    model: 'openai/gpt-4o-mini-transcribe',
  },
  {
    id: 'custom',
    label: '自定义',
    apiUrl: '',
    model: '',
  },
] as const

interface TestResult {
  ok: boolean
  message: string
  elapsed_ms: number
}

function PasswordInput({ value, onChange, placeholder, className }: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
}) {
  const [visible, setVisible] = useState(false)
  return (
    <div className="relative">
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={className}
      />
      <button
        type="button"
        onClick={() => setVisible(!visible)}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground/50 hover:text-muted-foreground"
        tabIndex={-1}
      >
        {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
    </div>
  )
}

const DEFAULT_OMNI_PROMPT = '你是一个语音转文字助手。请将用户的语音内容准确转写为文字，保持原意，适当添加标点符号，不要添加任何额外的解释或评论。'

const OMNI_PROMPT_POLISH = `你是语音文本精炼助手。输入是 ASR 语音识别的原始转写，你的任务是清洗为可直接使用的干净文本。
核心原则：保留用户全部有效信息，只清除语音噪声和识别错误。
处理规则：
1. 移除口语填充词（嗯、啊、那个、就是说、然后呢）和无意义的重复、犹豫。
2. 识别自我修正——"不对"、"不是"、"应该是"、"改到"后以最终表达为准，删除前序错误。
3. 修正明显的语音识别错误：同音字、音近字、专有名词、英文大小写、数字和时间。
4. 添加标点符号，必要时分段。中英文混合保留合理空格。
5. 检测到"第一/第二/首先/然后"等结构化表达时，输出为有序列表。
约束：不添加原文没有的内容，不改变用户核心语义；不回答、解释、总结或续写文本中提到的问题。
只输出精炼后的文本。`

const OMNI_PROMPT_PRESETS = [
  { id: 'faithful', label: '忠实转录', prompt: DEFAULT_OMNI_PROMPT },
  { id: 'polish', label: '口语润色', prompt: OMNI_PROMPT_POLISH },
] as const

/** 根据供应商检查 API Key 格式，返回提示文字（空字符串表示格式正常） */
function checkAsrKeyFormat(provider: string, key: string): string {
  const k = key.trim()
  if (!k) return ''
  if (provider === 'doubao_v2' || provider === 'doubao') {
    // 豆包 Access Token 可能包含字母、数字以及 - _ 等符号，长度也不固定，
    // 只在出现空白字符（多为粘贴时带进的空格/换行）等明显异常时提示。
    if (/\s/.test(k)) {
      return '豆包 Access Token 不应包含空格或换行，请确认是否粘贴了多余字符'
    }
  } else if (provider === 'mimo' || provider === 'openai_compat') {
    // OpenAI / OpenRouter / MiMo：格式不强制
  } else {
    // 百炼平台 API Key：通常以 sk- 开头
    if (!/^sk-/.test(k)) {
      return '百炼 API Key 通常以 sk- 开头，请确认格式是否正确'
    }
  }
  return ''
}

/** 检查豆包 App ID 格式 */
function checkAsrAppIdFormat(appId: string): string {
  const id = appId.trim()
  if (!id) return ''
  if (!/^\d+$/.test(id)) {
    return 'App ID 通常为纯数字，请确认是否包含了多余字符'
  }
  if (id.length !== 10) {
    return `App ID 通常为 10 位数字（当前 ${id.length} 位），请确认是否正确`
  }
  return ''
}

export default function CloudAPISection() {
  // ASR 配置
  const [asrProvider, setAsrProvider] = useState('doubao_v2')
  const [asrApiKey, setAsrApiKey] = useState('')
  const [asrAppId, setAsrAppId] = useState('')
  const [asrApiUrl, setAsrApiUrl] = useState('')
  const [asrModel, setAsrModel] = useState('')
  const [openaiPreset, setOpenaiPreset] = useState<string>('openai')
  const [asrTesting, setAsrTesting] = useState(false)
  const [asrMessage, setAsrMessage] = useState('')
  const [omniSystemPrompt, setOmniSystemPrompt] = useState(DEFAULT_OMNI_PROMPT)
  const [qwenWorkspaceId, setQwenWorkspaceId] = useState('')

  // 加载指定平台的 ASR key（每个供应商分组独立，不回退到全局，避免带入其它供应商的 key）
  async function loadAsrKeys(provider: string) {
    const group = asrKeyGroup(provider)
    setAsrApiKey(await getSetting(`cloudAsr.${group}.apiKey`, '') as string)
    setAsrAppId(await getSetting(`cloudAsr.${group}.appId`, '') as string)
    if (provider === 'openai_compat') {
      const url = await getSetting('cloudAsr.openai_compat.apiUrl', '') as string
      const model = await getSetting('cloudAsr.openai_compat.model', '') as string
      setAsrApiUrl(url || OPENAI_ASR_PRESETS[0].apiUrl)
      setAsrModel(model || OPENAI_ASR_PRESETS[0].model)
      const matched = OPENAI_ASR_PRESETS.find((p) => p.apiUrl && p.apiUrl === url)
      setOpenaiPreset(matched?.id ?? (url ? 'custom' : 'openai'))
    } else {
      setAsrApiUrl('')
      setAsrModel('')
    }
  }

  useEffect(() => {
    void loadSettings()
  }, [])

  async function loadSettings() {
    const provider = await getSetting('cloudAsr.provider', 'doubao_v2') as string
    setAsrProvider(provider)
    // 一次性迁移：老版本只有全局 key，迁到「当前供应商」的分组，升级后不丢 key，也不污染其它供应商
    const group = asrKeyGroup(provider)
    const existingGroupKey = await getSetting(`cloudAsr.${group}.apiKey`, '') as string
    if (!existingGroupKey) {
      const legacyKey = await getSetting('cloudAsr.apiKey', '') as string
      if (legacyKey) {
        await setSetting(`cloudAsr.${group}.apiKey`, legacyKey)
        await setSetting(`cloudAsr.${group}.appId`, await getSetting('cloudAsr.appId', '') as string)
      }
    }
    await loadAsrKeys(provider)
    setOmniSystemPrompt(await getSetting('cloudAsr.omniSystemPrompt', DEFAULT_OMNI_PROMPT) as string)
    setQwenWorkspaceId(await getSetting('cloudAsr.qwen.workspaceId', '') as string)
  }

  function handleQwenWorkspaceIdChange(v: string) {
    setQwenWorkspaceId(v)
    void setSetting('cloudAsr.qwen.workspaceId', v.trim())
  }

  function applyOpenaiPreset(presetId: string) {
    setOpenaiPreset(presetId)
    const p = OPENAI_ASR_PRESETS.find((x) => x.id === presetId)
    if (!p) return
    if (p.apiUrl) setAsrApiUrl(p.apiUrl)
    if (p.model) setAsrModel(p.model)
  }

  // 切换供应商时自动保存 provider 并加载对应平台的 key，同步到全局 key
  function handleAsrProviderChange(newProvider: string) {
    setAsrProvider(newProvider)
    setAsrMessage('')
    void (async () => {
      await setSetting('cloudAsr.provider', newProvider)
      const group = asrKeyGroup(newProvider)
      const groupKey = await getSetting(`cloudAsr.${group}.apiKey`, '') as string
      const groupAppId = await getSetting(`cloudAsr.${group}.appId`, '') as string
      // 只显示该供应商自己的 key（未配置则为空），并同步到全局供运行时读取，
      // 空也要写空，避免把上一个供应商的 key 带过来。
      setAsrApiKey(groupKey)
      setAsrAppId(groupAppId)
      await setSetting('cloudAsr.apiKey', groupKey)
      await setSetting('cloudAsr.appId', groupAppId)
      if (newProvider === 'openai_compat') {
        const url = await getSetting('cloudAsr.openai_compat.apiUrl', '') as string
        const model = await getSetting('cloudAsr.openai_compat.model', '') as string
        setAsrApiUrl(url || OPENAI_ASR_PRESETS[0].apiUrl)
        setAsrModel(model || OPENAI_ASR_PRESETS[0].model)
        const matched = OPENAI_ASR_PRESETS.find((p) => p.apiUrl && p.apiUrl === url)
        setOpenaiPreset(matched?.id ?? (url ? 'custom' : 'openai'))
      } else {
        setAsrApiUrl('')
        setAsrModel('')
      }
    })()
  }

  async function saveAndTestAsr() {
    if (asrTesting) return // 防止双击重复触发
    setAsrTesting(true)
    setAsrMessage('')

    // 先保存（互相独立，并行写入而非依次 await）
    const group = asrKeyGroup(asrProvider)
    const savePromises = [
      setSetting(`cloudAsr.${group}.apiKey`, asrApiKey),
      setSetting(`cloudAsr.${group}.appId`, asrAppId),
      setSetting('cloudAsr.apiKey', asrApiKey),
      setSetting('cloudAsr.appId', asrAppId),
    ]
    if (asrProvider === 'openai_compat') {
      savePromises.push(
        setSetting('cloudAsr.openai_compat.apiUrl', asrApiUrl.trim()),
        setSetting('cloudAsr.openai_compat.apiKey', asrApiKey),
        setSetting('cloudAsr.openai_compat.model', asrModel.trim()),
      )
    }
    if (asrProvider.startsWith('qwen_omni')) {
      savePromises.push(setSetting('cloudAsr.omniSystemPrompt', omniSystemPrompt))
    }
    await Promise.all(savePromises)

    // 再测试
    try {
      const isQwenOmni = isQwenOmniProvider(asrProvider)
      const qwenOmniModel = resolveQwenOmniModel(asrProvider)

      const result = await invoke<TestResult>('test_asr_connection', {
        config: {
          provider: isQwenOmni ? 'qwen_omni' : asrProvider,
          api_key: asrApiKey,
          app_id: asrAppId,
          ...(asrProvider === 'openai_compat' && {
            api_url: asrApiUrl.trim(),
            model: asrModel.trim(),
          }),
          ...(isQwenOmni && { extra: { model: qwenOmniModel } }),
        },
      })
      setAsrMessage(result.ok ? `已保存，${result.message}` : `已保存，但连接失败：${result.message}`)
    } catch (err) {
      setAsrMessage(`已保存，但测试失败：${String(err)}`)
    } finally {
      setAsrTesting(false)
    }
  }

  const inputClass = 'h-9 w-full rounded-md border border-input-border bg-input-bg px-3 text-sm outline-none transition-colors focus:border-input-focus-border'
  const selectClass = 'h-9 w-full rounded-md border border-input-border bg-input-bg px-2 text-sm outline-none transition-colors focus:border-input-focus-border'

  return (
    <Card>
      <CardContent className="p-6">
        <h2 className="mb-1 text-lg font-semibold">语音识别 (ASR)</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            ASR 与下方 AI 润色独立配置，可任意混搭。国外网络优先 OpenAI 兼容；中文效果不够时再切豆包/千问。
          </p>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-sm text-muted-foreground">供应商</label>
              <select
                value={asrProvider}
                onChange={(e) => handleAsrProviderChange(e.target.value)}
                className={selectClass}
              >
                {ASR_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value} disabled={'disabled' in p && !!p.disabled}>{p.label}</option>
                ))}
              </select>
            </div>

            {asrProvider === 'openai_compat' && (
              <>
                <div>
                  <label className="mb-1 block text-sm text-muted-foreground">服务预设</label>
                  <div className="flex flex-wrap gap-1.5">
                    {OPENAI_ASR_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => applyOpenaiPreset(p.id)}
                        className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                          openaiPreset === p.id
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-input-border text-muted-foreground hover:border-primary/50'
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-sm text-muted-foreground">API URL</label>
                  <input
                    value={asrApiUrl}
                    onChange={(e) => {
                      setAsrApiUrl(e.target.value)
                      setOpenaiPreset('custom')
                    }}
                    placeholder="https://api.openai.com 或 https://openrouter.ai/api"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm text-muted-foreground">模型</label>
                  <input
                    value={asrModel}
                    onChange={(e) => {
                      setAsrModel(e.target.value)
                      setOpenaiPreset('custom')
                    }}
                    placeholder="gpt-4o-mini-transcribe 或 openai/whisper-1"
                    className={inputClass}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    模型名原样发送。OpenAI 用官方 id；OpenRouter 通常带厂商前缀。
                  </p>
                </div>
              </>
            )}

            {/* 只有豆包需要 App ID；千问（含流式/Omni）和 MiMo 只需要 API Key */}
            {asrProvider === 'doubao_v2' && (
            <div>
              <label className="mb-1 block text-sm text-muted-foreground">App ID</label>
              <input
                value={asrAppId}
                onChange={(e) => setAsrAppId(e.target.value)}
                placeholder="输入 App ID（豆包需要）"
                className={inputClass}
              />
              {checkAsrAppIdFormat(asrAppId) && (
                <p className="mt-1.5 flex items-center gap-1 text-xs text-amber-500">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  {checkAsrAppIdFormat(asrAppId)}
                </p>
              )}
            </div>
            )}
            <div>
              <label className="mb-1 block text-sm text-muted-foreground">
                {asrProvider === 'doubao_v2' ? 'Access Token' : 'API Key'}
              </label>
              <div className="flex gap-2">
                <div className="flex-1">
                  <PasswordInput
                    value={asrApiKey}
                    onChange={setAsrApiKey}
                    placeholder={
                      asrProvider === 'doubao_v2'
                        ? '输入火山引擎 Access Token'
                        : asrProvider === 'mimo'
                          ? '输入小米 MiMo API Key'
                          : asrProvider === 'openai_compat'
                            ? '输入 OpenAI / OpenRouter API Key'
                            : '输入百炼平台 API Key'
                    }
                    className={inputClass}
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0"
                  onClick={() => void saveAndTestAsr()}
                  disabled={
                    asrTesting
                    || !asrApiKey
                    || (asrProvider === 'openai_compat' && (!asrApiUrl.trim() || !asrModel.trim()))
                  }
                >
                  {asrTesting ? '测试中...' : '保存'}
                </Button>
              </div>
              {asrMessage && <p className="mt-1.5 text-xs text-muted-foreground">{asrMessage}</p>}
              {!asrMessage && checkAsrKeyFormat(asrProvider, asrApiKey) && (
                <p className="mt-1.5 flex items-center gap-1 text-xs text-amber-500">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  {checkAsrKeyFormat(asrProvider, asrApiKey)}
                </p>
              )}
            </div>
            {asrProvider === 'qwen_realtime' && (
              <div>
                <label className="mb-1 block text-sm text-muted-foreground">
                  业务空间 ID（选填）
                </label>
                <PasswordInput
                  value={qwenWorkspaceId}
                  onChange={handleQwenWorkspaceIdChange}
                  placeholder="如 ws-xxxxxxxx"
                  className={inputClass}
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  使用「流式实时字幕」功能需填入此 ID，否则可留空。登录
                  <button
                    type="button"
                    onClick={() => void shellOpen('https://bailian.console.aliyun.com')}
                    className="mx-0.5 inline-flex items-center gap-0.5 text-primary underline underline-offset-2 decoration-primary/50 transition-colors hover:decoration-primary"
                  >
                    百炼控制台
                    <ExternalLink className="h-3 w-3" />
                  </button>
                  后，鼠标移到右上角「默认业务空间」即可查看。
                </p>
              </div>
            )}
            {asrProvider.startsWith('qwen_omni') && (
              <div>
                <label className="mb-1.5 block text-sm text-muted-foreground">System Prompt</label>
                <div className="mb-1.5 flex gap-1.5">
                  {OMNI_PROMPT_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setOmniSystemPrompt(p.prompt)}
                      className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                        omniSystemPrompt === p.prompt
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-input-border text-muted-foreground hover:border-primary/50'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <textarea
                  value={omniSystemPrompt}
                  onChange={(e) => setOmniSystemPrompt(e.target.value)}
                  placeholder={DEFAULT_OMNI_PROMPT}
                  rows={2}
                  className="w-full rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm outline-none transition-colors focus:border-input-focus-border resize-y"
                />
              </div>
            )}
            {asrProvider.startsWith('qwen_omni') && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  💡 该模型同时具备语音识别和 AI 理解能力，无需再单独配置下方的「AI 校对」。
                </p>
              </div>
            )}
            {asrProvider === 'doubao_v2' && (
              <button
                type="button"
                onClick={() => void shellOpen('https://my.feishu.cn/wiki/V4vLw2UfDiWcATkK2dyckhvynzc')}
                className="inline-flex items-center gap-1 text-xs text-primary/70 underline underline-offset-2 decoration-primary/30 transition-colors hover:text-primary hover:decoration-primary/60"
              >
                SayIt 语音识别配置
                <ExternalLink className="h-3 w-3" />
              </button>
            )}
          </div>
        </CardContent>
      </Card>
  )
}
