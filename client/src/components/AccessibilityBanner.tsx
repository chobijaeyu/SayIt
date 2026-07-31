// macOS：辅助功能未授权时提示 — 后台热键与自动上屏都依赖此权限

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { notifyShortcutsChanged } from '@/services/bridge'

export default function AccessibilityBanner() {
  const [trusted, setTrusted] = useState<boolean | null>(null)
  // 非 macOS 时命令仍返回 true，横幅不显示
  const refresh = useCallback(async () => {
    try {
      const ok = await invoke<boolean>('check_accessibility_permission')
      setTrusted(ok)
      if (ok) {
        // 授权后重挂全局热键
        notifyShortcutsChanged()
      }
    } catch {
      setTrusted(true) // 探测失败不打扰
    }
  }, [])

  useEffect(() => {
    void refresh()
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    const unlisten = listen<{ trusted: boolean }>('macos-accessibility-status', (e) => {
      setTrusted(!!e.payload?.trusted)
      if (e.payload?.trusted) notifyShortcutsChanged()
    })
    // 从系统设置返回时周期性复查
    const timer = window.setInterval(() => { void refresh() }, 4000)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.clearInterval(timer)
      void unlisten.then((fn) => fn())
    }
  }, [refresh])

  if (trusted !== false) return null

  return (
    <div className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-2.5">
      <div className="mx-auto flex max-w-4xl flex-wrap items-start gap-3 text-sm">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium text-foreground">
            需要开启「辅助功能」权限
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            未授权时：只能在 SayIt 自己窗口里触发快捷键，且无法把识别结果自动粘贴到其它 App。
            请到 系统设置 → 隐私与安全性 → 辅助功能，打开 <strong>SayIt</strong>，然后点「重新检测」。
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-background px-2.5 py-1 text-xs font-medium hover:bg-accent"
            onClick={() => {
              void invoke('request_accessibility_permission')
            }}
          >
            打开系统设置
            <ExternalLink className="h-3 w-3" />
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-background px-2.5 py-1 text-xs font-medium hover:bg-accent"
            onClick={() => { void refresh() }}
          >
            <RefreshCw className="h-3 w-3" />
            重新检测
          </button>
        </div>
      </div>
    </div>
  )
}
