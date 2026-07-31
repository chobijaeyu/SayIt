use base64::{engine::general_purpose::STANDARD, Engine};
use std::fs;
use crate::path_guard::{audio_dir, audio_wav_path, require_existing_under};

#[tauri::command]
pub fn save_audio_file(id: String, wav_base64: String) -> Result<String, String> {
    let path = audio_wav_path(&id)?;
    let bytes = STANDARD.decode(&wav_base64).map_err(|e| e.to_string())?;
    // 限制单文件体积，防止恶意前端灌盘（约 100MB）
    if bytes.len() > 100 * 1024 * 1024 {
        return Err("音频过大".into());
    }
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// 接收 PCM Int16 LE 原始数据（base64），在 Rust 侧编码 WAV header 并写入文件。
/// 避免前端拼 WAV + base64 编码的开销。
#[tauri::command]
pub fn save_pcm_as_wav(id: String, pcm_base64: String, sample_rate: Option<u32>) -> Result<String, String> {
    let path = audio_wav_path(&id)?;

    let pcm = STANDARD.decode(&pcm_base64).map_err(|e| e.to_string())?;
    if pcm.len() > 100 * 1024 * 1024 {
        return Err("音频过大".into());
    }
    let sr = sample_rate.unwrap_or(16000);
    let data_len = pcm.len() as u32;

    // Build 44-byte WAV header + PCM data
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());   // chunk size
    wav.extend_from_slice(&1u16.to_le_bytes());    // PCM format
    wav.extend_from_slice(&1u16.to_le_bytes());    // mono
    wav.extend_from_slice(&sr.to_le_bytes());      // sample rate
    wav.extend_from_slice(&(sr * 2).to_le_bytes()); // byte rate
    wav.extend_from_slice(&2u16.to_le_bytes());    // block align
    wav.extend_from_slice(&16u16.to_le_bytes());   // bits per sample
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(&pcm);

    fs::write(&path, &wav).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn read_audio_file(file_path: String) -> Result<Option<String>, String> {
    let base = audio_dir();
    let path = match require_existing_under(&base, &file_path) {
        Ok(p) => p,
        Err(_) => return Ok(None), // 不存在或越界：对调用方表现为无文件，不泄露是否存在系统路径
    };
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(Some(STANDARD.encode(&bytes)))
}

#[tauri::command]
pub fn delete_audio_file(file_path: String) -> Result<(), String> {
    let base = audio_dir();
    match require_existing_under(&base, &file_path) {
        Ok(path) => {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
            Ok(())
        }
        // 越界直接报错，避免被当成「已删除」
        Err(e) if e.contains("越界") => Err(e),
        Err(_) => Ok(()), // 不存在：幂等成功
    }
}
