import { describe, expect, it } from 'vitest'
import {
  buildLearningFingerprint,
  isLearningCacheFresh,
  parseLearningCache,
  type LearningCacheV1,
  type LearningContentV1,
} from '../translationLearning'
import type { HistoryRecord } from '../store'

// 通过 re-export 路径测 parse：用 parseLearningCache 间接校验 content
// 以及 fingerprint / freshness

function sampleContent(overrides: Partial<LearningContentV1> = {}): LearningContentV1 {
  return {
    summaryZh: '把「明天开会」译成英文，语气自然。',
    vocabulary: [
      {
        expression: 'meeting',
        sourceExpression: '开会',
        pronunciation: null,
        meaningZh: '会议',
        usageZh: '商务语境常用',
        example: { text: 'We have a meeting tomorrow.', translationZh: '我们明天有会。' },
      },
    ],
    grammar: [],
    phrases: [],
    pitfalls: [{ issueZh: '不要直译「开」', adviceZh: '用 have a meeting' }],
    variants: [{ style: 'casual', text: "We've got a meeting tomorrow.", noteZh: '更口语' }],
    ...overrides,
  }
}

function sampleRecord(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    id: 'h1',
    timestamp: 1,
    asrText: '明天开会',
    llmText: 'We have a meeting tomorrow.',
    asrMs: 100,
    llmMs: 200,
    durationSec: 1,
    charCount: 10,
    promptPresetId: 'zh2en',
    promptPresetName: '中文→英文',
    ...overrides,
  }
}

describe('buildLearningFingerprint', () => {
  it('same content → same fingerprint', () => {
    const a = buildLearningFingerprint(sampleRecord())
    const b = buildLearningFingerprint(sampleRecord())
    expect(a).toBe(b)
    expect(a.length).toBeGreaterThan(0)
  })

  it('llmText change → different fingerprint', () => {
    const a = buildLearningFingerprint(sampleRecord())
    const b = buildLearningFingerprint(sampleRecord({ llmText: 'Meeting tomorrow.' }))
    expect(a).not.toBe(b)
  })

  it('preset change → different fingerprint', () => {
    const a = buildLearningFingerprint(sampleRecord({ promptPresetId: 'zh2en' }))
    const b = buildLearningFingerprint(sampleRecord({ promptPresetId: 'zh2ja' }))
    expect(a).not.toBe(b)
  })
})

describe('isLearningCacheFresh', () => {
  it('matches fingerprint', () => {
    const record = sampleRecord()
    const cache: LearningCacheV1 = {
      schemaVersion: 1,
      promptVersion: 1,
      fingerprint: buildLearningFingerprint(record),
      mode: 'translation',
      sourceLanguage: 'zh-CN',
      targetLanguage: 'en',
      generatedAt: Date.now(),
      provider: 'openai_compat',
      model: 'test',
      content: sampleContent(),
    }
    expect(isLearningCacheFresh(cache, record)).toBe(true)
    expect(isLearningCacheFresh(cache, sampleRecord({ llmText: 'changed' }))).toBe(false)
  })

  it('null / empty summary → not fresh', () => {
    expect(isLearningCacheFresh(null, sampleRecord())).toBe(false)
  })
})

describe('parseLearningCache', () => {
  it('accepts valid envelope', () => {
    const record = sampleRecord()
    const raw = {
      schemaVersion: 1,
      promptVersion: 1,
      fingerprint: buildLearningFingerprint(record),
      mode: 'translation',
      sourceLanguage: 'zh-CN',
      targetLanguage: 'en',
      generatedAt: 123,
      provider: 'x',
      model: 'y',
      content: sampleContent(),
    }
    const parsed = parseLearningCache(raw)
    expect(parsed).not.toBeNull()
    expect(parsed!.content.summaryZh).toContain('开会')
    expect(parsed!.content.vocabulary).toHaveLength(1)
  })

  it('rejects non-object / wrong schema', () => {
    expect(parseLearningCache(null)).toBeNull()
    expect(parseLearningCache({ schemaVersion: 2 })).toBeNull()
    expect(parseLearningCache({ schemaVersion: 1, fingerprint: 'a' })).toBeNull()
  })
})
