/**
 * 历史记录「学习」：对照 ASR 原文与 AI 输出，按需生成语言讲解。
 * 不改变 PTT→粘贴主流程；仅用户主动点击时调用。
 */

import { invoke } from '@tauri-apps/api/core'
import { getSetting, isTranslationPreset, type HistoryRecord } from './store'
import { addRuntimeEvent } from './debugLog'

interface AiResult {
  text: string
  elapsed_ms: number
}

const LEARNING_SYSTEM_PROMPT = `你是耐心的双语语言教练。用户会提供「语音识别中文原文」和「系统生成的最终文本」（可能是英文、日文或润色后的中文）。

你的任务是用**简体中文**讲解，帮助用户理解为什么这样处理/翻译，并顺带教表达。

【输出结构】（严格按下列小标题，用 Markdown）
## 对照
- 用一两句话概括：原文在说什么，最终文本做了什么（整理 / 英译 / 日译）

## 为什么这样处理
- 2～4 条要点。若是翻译：说明词选、语序、语气、省略口水话等；若是同语种整理：说明删改了什么、为何更清晰。
- 对照用户可能的「直译/脑补」误区。

## 可学表达
- 2～5 个词组或句式：写出目标语表达 + 中文释义 + 一个极短例句（目标语）。

## 可选变体（可选）
- 若适合，各给一句「更口语」和「更正式」的目标语说法。

【约束】
- 全文用中文讲解；例句可用目标语。
- 简洁，总长度控制在大约 400～800 字。
- 不要复述过长原文；不要输出与学习无关的寒暄。
- 不要声称修改或重新生成「应粘贴的最终文本」——你只做教学讲解。`

/** 是否适合出「学习」按钮：有原文与结果，且二者可对照 */
export function canLearnFromRecord(record: HistoryRecord): boolean {
  const asr = (record.asrText || '').trim()
  const llm = (record.llmText || '').trim()
  if (!asr || !llm) return false
  if (record.isEmpty) return false
  // 翻译 preset 优先；同语种整理也可学「为什么这样润色」
  return true
}

export function isLikelyTranslationRecord(record: HistoryRecord): boolean {
  if (isTranslationPreset(record.promptPresetId)) return true
  const name = record.promptPresetName || ''
  return /翻|译|英|日|English|Japanese|zh2en|zh2ja/i.test(name)
}

/**
 * 调用当前云端 AI 配置生成讲解。
 */
export async function explainHistoryRecord(record: HistoryRecord): Promise<string> {
  const asr = (record.asrText || '').trim()
  const llm = (record.llmText || '').trim()
  if (!asr || !llm) {
    throw new Error('缺少原文或处理结果，无法讲解')
  }

  const aiProvider = (await getSetting('cloudAi.provider', 'openai_compat')) as string
  const aiApiUrl = (await getSetting('cloudAi.apiUrl', '')) as string
  const aiApiKey = (await getSetting('cloudAi.apiKey', '')) as string
  const aiModel = (await getSetting('cloudAi.model', '')) as string

  if (!aiApiUrl || !aiModel || (!aiApiKey && aiProvider !== 'ollama')) {
    throw new Error('请先在「AI 供应商」配置可用的 API')
  }

  const mode = record.promptPresetName || record.promptPresetId || '未知'
  const userContent = [
    `【模式】${mode}`,
    `【语音识别原文】`,
    asr,
    ``,
    `【系统输出（用户实际看到/粘贴的文本）】`,
    llm,
    ``,
    `请按系统要求用中文做学习讲解。`,
  ].join('\n')

  addRuntimeEvent('info', 'learning', '开始生成学习讲解', {
    historyId: record.id,
    presetId: record.promptPresetId,
    asrLen: asr.length,
    llmLen: llm.length,
  })

  const aiResult = await invoke<AiResult>('cloud_polish', {
    request: {
      text: userContent,
      ai_config: {
        provider: aiProvider,
        api_url: aiApiUrl,
        api_key: aiApiKey,
        model: aiModel,
      },
      // wrap_user_text 会再包一层；这里 system 已完整，user 侧用说明性正文即可
      system_prompt: LEARNING_SYSTEM_PROMPT,
    },
  })

  const notes = (aiResult.text || '').trim()
  if (!notes) {
    throw new Error('AI 返回空讲解')
  }

  addRuntimeEvent('info', 'learning', '学习讲解完成', {
    historyId: record.id,
    elapsedMs: aiResult.elapsed_ms,
    notesLen: notes.length,
  })

  return notes
}
