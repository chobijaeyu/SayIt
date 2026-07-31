/**
 * 云 ASR 配置装配 — 单一来源，避免 CloudAPI / History / 诊断 / 测试各写一份。
 */

import { isQwenOmniProvider, resolveQwenOmniModel } from '@/lib/asrModels'
import { getSetting } from './store'

export interface CloudAsrInvokeConfig {
  provider: string
  api_key: string
  app_id: string
  api_url?: string
  model?: string
  extra?: Record<string, unknown>
}

/** 供应商 → 密钥存储分组（同组共享 Key，切供应商不串号） */
export function asrKeyGroup(provider: string): string {
  if (provider === 'doubao_v2' || provider === 'doubao') return 'doubao'
  if (provider === 'mimo') return 'mimo'
  if (provider === 'openai_compat') return 'openai_compat'
  if (provider.startsWith('qwen')) return 'qwen'
  // 未知供应商：用自身 id，绝不默认落到千问槽
  return provider || 'unknown'
}

/** 从设置读取并装配 cloud_transcribe / test_asr_connection 所需配置 */
export async function buildCloudAsrConfig(): Promise<{
  providerKey: string
  config: CloudAsrInvokeConfig
  isQwenOmni: boolean
}> {
  const providerKey = (await getSetting('cloudAsr.provider', 'doubao_v2')) as string
  const isQwenOmni = isQwenOmniProvider(providerKey)
  const apiKey = (await getSetting('cloudAsr.apiKey', '')) as string
  const appId = (await getSetting('cloudAsr.appId', '')) as string

  const config: CloudAsrInvokeConfig = {
    provider: isQwenOmni ? 'qwen_omni' : providerKey,
    api_key: apiKey,
    app_id: appId,
  }

  if (isQwenOmni) {
    const qwenOmniModel = resolveQwenOmniModel(providerKey)
    const savedPrompt = (await getSetting('cloudAsr.omniSystemPrompt', '')) as string
    config.extra = {
      model: qwenOmniModel,
      instructions: savedPrompt || undefined,
    }
  }

  if (providerKey === 'openai_compat') {
    config.api_url = (await getSetting('cloudAsr.openai_compat.apiUrl', '')) as string
    config.model = (await getSetting('cloudAsr.openai_compat.model', '')) as string
    // 同步全局镜像，便于旧路径读取
    const storedKey = (await getSetting('cloudAsr.openai_compat.apiKey', apiKey)) as string
    if (storedKey) config.api_key = storedKey
  }

  return { providerKey, config, isQwenOmni }
}
