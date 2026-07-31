//! 路径沙箱：所有「前端传入路径」的读写删除必须落在允许目录内。
//!
//! 原则：
//! - 读/删：严格限制在 app 数据子目录（audio / logs / diagnostics / models / update temp）
//! - 写 id：只允许安全字符，禁止 `..` 与路径分隔符
//! - 用户主动导出到下载目录等：不走本模块（属于用户意图写）

use std::fs;
use std::path::{Component, Path, PathBuf};

/// 应用数据根目录：`…/com.sayit.app`
pub fn app_data_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.sayit.app")
}

pub fn audio_dir() -> PathBuf {
    app_data_dir().join("audio")
}

pub fn logs_dir() -> PathBuf {
    app_data_dir().join("logs")
}

pub fn diagnostics_dir() -> PathBuf {
    app_data_dir().join("diagnostics")
}

pub fn update_temp_dir() -> PathBuf {
    std::env::temp_dir().join("sayit-update")
}

/// 文件 id：仅 ASCII 字母数字、`-`、`_`，长度 1..=128。
pub fn sanitize_file_id(id: &str) -> Result<String, String> {
    let id = id.trim();
    if id.is_empty() || id.len() > 128 {
        return Err("非法文件 id：长度无效".into());
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("非法文件 id：仅允许字母数字与 - _".into());
    }
    // 额外拒绝 Windows 设备名等
    let upper = id.to_ascii_uppercase();
    if matches!(
        upper.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "LPT1"
    ) {
        return Err("非法文件 id".into());
    }
    Ok(id.to_string())
}

/// 更新安装包文件名：只允许简单名，无路径。
pub fn sanitize_basename(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 200 {
        return Err("非法文件名".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("非法文件名：不允许路径分隔".into());
    }
    if Path::new(name)
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("非法文件名".into());
    }
    Ok(name.to_string())
}

fn ensure_dir(dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {}", e))?;
    fs::canonicalize(dir).map_err(|e| format!("解析目录失败: {}", e))
}

/// 将 `candidate` 解析为绝对路径，并要求其落在 `base` 之下。
/// 文件可不存在（写新文件时）：则校验其父目录在 base 内。
pub fn resolve_under(base: &Path, candidate: impl AsRef<Path>) -> Result<PathBuf, String> {
    let base_canon = ensure_dir(base)?;
    let candidate = candidate.as_ref();

    // 拒绝明显的危险相对片段（在拼绝对路径前）
    if candidate
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        // 允许绝对路径里规范化后的 ..，但相对路径含 .. 直接拒
        if !candidate.is_absolute() {
            return Err("路径越界：不允许 ..".into());
        }
    }

    let full = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        base_canon.join(candidate)
    };

    let resolved = if full.exists() {
        fs::canonicalize(&full).map_err(|e| format!("解析路径失败: {}", e))?
    } else {
        // 文件尚不存在：canonicalize 父目录 + 文件名
        let parent = full
            .parent()
            .ok_or_else(|| "路径无效：无父目录".to_string())?;
        let file_name = full
            .file_name()
            .ok_or_else(|| "路径无效：无文件名".to_string())?;
        // 父目录必须已在 base 下；不存在则尝试创建（仅当 parent 在 base 逻辑下）
        let parent_to_check = if parent.exists() {
            fs::canonicalize(parent).map_err(|e| format!("解析父目录失败: {}", e))?
        } else {
            // 仅允许在 base 下创建子路径：父路径必须以 base 为前缀（字符串/组件级）
            let parent_abs = if parent.is_absolute() {
                parent.to_path_buf()
            } else {
                base_canon.join(parent)
            };
            // 规范化：去掉 . 与 ..（手动）
            let normalized = normalize_path(&parent_abs);
            if !path_is_under(&base_canon, &normalized) {
                return Err("路径越界：父目录不在允许范围内".into());
            }
            fs::create_dir_all(&normalized).map_err(|e| format!("创建父目录失败: {}", e))?;
            fs::canonicalize(&normalized).map_err(|e| format!("解析父目录失败: {}", e))?
        };
        if !path_is_under(&base_canon, &parent_to_check) {
            return Err("路径越界：父目录不在允许范围内".into());
        }
        parent_to_check.join(file_name)
    };

    if !path_is_under(&base_canon, &resolved) {
        return Err("路径越界：不在允许目录内".into());
    }
    Ok(resolved)
}

/// 要求路径已存在且在 base 下（读/删）。
pub fn require_existing_under(base: &Path, candidate: impl AsRef<Path>) -> Result<PathBuf, String> {
    let resolved = resolve_under(base, candidate)?;
    if !resolved.exists() {
        return Err("文件不存在".into());
    }
    Ok(resolved)
}

fn path_is_under(base: &Path, path: &Path) -> bool {
    let base_components: Vec<_> = base.components().collect();
    let path_components: Vec<_> = path.components().collect();
    if path_components.len() < base_components.len() {
        return false;
    }
    path_components
        .iter()
        .zip(base_components.iter())
        .all(|(a, b)| a == b)
}

/// 轻量规范化：解析 `.` / `..`（不访问磁盘）。
fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => out.push(Component::RootDir.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(s) => out.push(s),
        }
    }
    out
}

/// audio 目录下的 wav 路径：`{id}.wav`
pub fn audio_wav_path(id: &str) -> Result<PathBuf, String> {
    let id = sanitize_file_id(id)?;
    let dir = audio_dir();
    resolve_under(&dir, format!("{}.wav", id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn sanitize_id_rejects_traversal() {
        assert!(sanitize_file_id("../etc/passwd").is_err());
        assert!(sanitize_file_id("a/b").is_err());
        assert!(sanitize_file_id("ok-id_1").is_ok());
    }

    #[test]
    fn resolve_under_blocks_escape() {
        let tmp = std::env::temp_dir().join(format!("sayit-path-guard-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let base = tmp.join("base");
        fs::create_dir_all(&base).unwrap();

        // 合法
        let ok = resolve_under(&base, "file.txt").unwrap();
        assert!(ok.ends_with("file.txt"));

        // 逃逸
        let outside = tmp.join("secret.txt");
        fs::write(&outside, b"x").unwrap();
        assert!(require_existing_under(&base, &outside).is_err());

        let _ = fs::remove_dir_all(&tmp);
    }
}
