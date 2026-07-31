import { Pencil, Plus, Trash2, Keyboard } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import {
  BUILTIN_PRESETS,
  PRESET_GROUP_LABELS,
  getPresetGroupId,
  type PresetGroupId,
  type PromptPreset,
} from '@/services/store'
import { ComboShortcutInput } from './ShortcutInputs'
import { displayAccelerator } from './utils'

export default function PromptPresetSection({
  presets,
  activePresetId,
  editingPreset,
  presetShortcuts,
  onSelectPreset,
  onStartNewPreset,
  onStartEditing,
  onEditingPresetChange,
  onCancelEditing,
  onSavePreset,
  onDeletePreset,
  onSetPresetShortcut,
  onApplyRecommendedShortcuts,
}: {
  presets: PromptPreset[]
  activePresetId: string
  editingPreset: PromptPreset | null
  presetShortcuts: Record<string, string>
  onSelectPreset: (id: string) => void
  onStartNewPreset: () => void
  onStartEditing: (preset: PromptPreset) => void
  onEditingPresetChange: (preset: PromptPreset) => void
  onCancelEditing: () => void
  onSavePreset: (preset: PromptPreset) => void
  onDeletePreset: (id: string) => void
  onSetPresetShortcut: (presetId: string, accelerator: string) => void
  onApplyRecommendedShortcuts?: () => void
}) {
  const groups: { id: PresetGroupId; items: PromptPreset[] }[] = [
    { id: 'same_lang', items: [] },
    { id: 'translate', items: [] },
    { id: 'custom', items: [] },
  ]
  for (const preset of presets) {
    const gid = getPresetGroupId(preset)
    groups.find((g) => g.id === gid)!.items.push(preset)
  }

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold">润色模式</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              按住说话键只负责录音；当前模式决定输出语言与风格。
              同语种整理输出中文；翻译模式在去噪纠错后<strong className="font-medium text-foreground">一步</strong>
              输出目标语（不是先整理再二次翻译）。
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {onApplyRecommendedShortcuts && (
              <button
                type="button"
                onClick={onApplyRecommendedShortcuts}
                className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent"
                title="Alt+1 意图整理 · Alt+2 中→英 · Alt+3 中→日 · Alt+4 口语化（可再改）"
              >
                <Keyboard className="h-3 w-3" /> 推荐快捷键
              </button>
            )}
            <button
              type="button"
              onClick={onStartNewPreset}
              className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent"
            >
              <Plus className="h-3 w-3" /> 新建
            </button>
          </div>
        </div>

        <div className="space-y-5">
          {groups.map((group) => {
            if (group.items.length === 0) return null
            return (
              <div key={group.id}>
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {PRESET_GROUP_LABELS[group.id]}
                </p>
                <div className="space-y-2">
                  {group.items.map((preset) => (
                    <div
                      key={preset.id}
                      className={`cursor-pointer rounded-lg border p-3 transition-colors ${
                        activePresetId === preset.id
                          ? 'border-primary/40 bg-primary/5'
                          : 'border-border hover:bg-accent/50'
                      }`}
                      onClick={() => onSelectPreset(preset.id)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-3">
                          <div
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
                              activePresetId === preset.id ? 'border-primary' : 'border-muted-foreground/40'
                            }`}
                          >
                            {activePresetId === preset.id && (
                              <div className="h-2 w-2 rounded-full bg-primary" />
                            )}
                          </div>

                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-medium">{preset.name}</p>
                              {preset.builtin && (
                                <span className="rounded border px-1 text-xs text-muted-foreground">内置</span>
                              )}
                              {group.id === 'translate' && (
                                <span className="rounded border border-sky-500/30 bg-sky-500/10 px-1 text-xs text-sky-700 dark:text-sky-300">
                                  翻译
                                </span>
                              )}
                              {presetShortcuts[preset.id] && (
                                <span className="rounded border border-primary/30 bg-primary/5 px-1.5 text-xs text-muted-foreground">
                                  {displayAccelerator(presetShortcuts[preset.id]).join('+')}
                                </span>
                              )}
                            </div>
                            <p className="truncate text-xs text-muted-foreground">
                              {preset.systemPrompt.slice(0, 60)}...
                            </p>
                          </div>
                        </div>

                        <div className="ml-2 flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation()
                              onStartEditing({ ...preset })
                            }}
                            className="rounded p-1.5 hover:bg-accent"
                            aria-label="编辑"
                          >
                            <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                          </button>

                          {!preset.builtin && (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation()
                                onDeletePreset(preset.id)
                              }}
                              className="rounded p-1.5 hover:bg-accent"
                              aria-label="删除"
                            >
                              <Trash2 className="h-3.5 w-3.5 text-destructive" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>

        <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
          推荐绑定：意图整理 Alt+1 · 中→英 Alt+2 · 中→日 Alt+3 · 口语化 Alt+4。
          按住说话仍是右 Shift。应用规则请尽量「继承当前模式」，只补充语气，避免锁死语言。
        </p>

        {editingPreset && (
          <div className="mt-4 space-y-3 rounded-lg border border-primary/30 bg-muted p-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-foreground">名称</label>
              <input
                value={editingPreset.name}
                onChange={(event) => onEditingPresetChange({ ...editingPreset, name: event.target.value })}
                placeholder="例如：会议纪要整理"
                className="h-9 w-full rounded-md border border-input-border bg-input-bg px-3 text-sm"
                disabled={editingPreset.builtin}
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-foreground">系统提示词（System Prompt）</label>
              <p className="mb-2 text-xs text-muted-foreground">
                定义 AI 的角色和处理规则，语音文本会自动附加为用户消息。
              </p>
              <textarea
                value={editingPreset.systemPrompt}
                onChange={(event) => onEditingPresetChange({ ...editingPreset, systemPrompt: event.target.value })}
                placeholder="定义 AI 的角色、行为和处理规则..."
                rows={8}
                className="w-full resize-none rounded-md border border-input-border bg-input-bg px-3 py-2 text-xs leading-normal"
              />
            </div>

            <div className="border-t border-border/60 pt-3">
              <ComboShortcutInput
                value={presetShortcuts[editingPreset.id] || ''}
                onChange={(accel) => onSetPresetShortcut(editingPreset.id, accel)}
                label="快捷键（可选）"
                description="设置组合键随时切换到此模式，如 Alt+1、Alt+2（需含修饰键）"
                comboOnly
              />
            </div>

            <div className="flex justify-end gap-2">
              {editingPreset.builtin && (
                <button
                  type="button"
                  onClick={() => {
                    const original = BUILTIN_PRESETS.find((builtin) => builtin.id === editingPreset.id)
                    if (original) onEditingPresetChange({ ...original })
                  }}
                  className="px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  恢复默认
                </button>
              )}

              <button
                type="button"
                onClick={onCancelEditing}
                className="rounded-md border px-3 py-1 text-xs transition-colors hover:bg-accent"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!editingPreset.name.trim() || !editingPreset.systemPrompt.trim()}
                onClick={() => onSavePreset(editingPreset)}
                className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                保存
              </button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
