// macOS：辅助功能未授权时提示 — 后台热键与自动上屏都依赖此权限
//
// 重要：绝不能在「已授权」时周期性 reconfigure 键盘钩子。
// reconfigure = 拆掉 CGEventTap 再装上，会卡住全系统按键输入。

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { notifyShortcutsChanged } from '@/services/bridge'

export default function AccessibilityBanner() {
  const [trusted, setTrusted] = useState<boolean | null>(null)
  // 仅在从未授权 → 已授权 时重挂热键，避免反复 reconfigure
  const wasTrustedRef = useRef<boolean | null>(null)

  const applyStatus = useCallback((ok: boolean, forceReconfigure = false) => {
    const prev = wasTrustedRef.current
    wasTrustedRef.current = ok
    setTrusted(ok)
    // 只在：手动强制 / 从未授权变为已授权 时重挂
    if (forceReconfigure || (ok && prev === false)) {
      notifyShortcutsChanged()
    }
  }, [])

  const refresh = useCallback(async (opts?: { forceReconfigure?: boolean }) => {
    try {
      const ok = await invoke<boolean>('check_accessibility_permission')
      applyStatus(ok, opts?.forceReconfigure === true)
    } catch {
      // 探测失败不打扰（当已授权处理，且不 reconfigure）
      setTrusted(true)
      wasTrustedRef.current = true
    }
  }, [applyStatus])

  useEffect(() => {
    void refresh()

    const unlisten = listen<{ trusted: boolean }>('macos-accessibility-status', (e) => {
      applyStatus(!!e.payload?.trusted)
    })

    // 仅在未授权时轮询（用户可能从系统设置返回）；已授权则停掉，避免卡键
    let timer: number | undefined
    const armPoll = () => {
      if (timer !== undefined) window.clearInterval(timer)
      timer = window.setInterval(() => {
        if (wasTrustedRef.current === false) {
          void refresh()
        }
      }, 5000)
    }
    armPoll()

    const onFocus = () => {
      // 窗口重新聚焦：若之前未授权，再查一次（用户可能刚在设置里打开）
      if (wasTrustedRef.current === false) {
        void refresh()
      }
    }
    window.addEventListener('focus', onFocus)

    return () => {
      window.removeEventListener('focus', onFocus)
      if (timer !== undefined) window.clearInterval(timer)
      void unlisten.then((fn) => fn())
    }
  }, [refresh, applyStatus])

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
            请到 系统设置 → 隐私与安全性 → 辅助功能，打开 <strong>SayIt</strong>（/Applications/SayIt.app），然后点「重新检测」。
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
            onClick={() => { void refresh({ forceReconfigure: true }) }}
          >
            <RefreshCw className="h-3 w-3" />
            重新检测
          </button>
        </div>
      </div>
    </div>
  )
}
