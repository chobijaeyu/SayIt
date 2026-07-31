//! OpenAI 兼容 ASR：`POST {base}/v1/audio/transcriptions`
//!
//! 覆盖 OpenAI 官方、OpenRouter，以及其它实现同一 multipart 接口的网关。
//! 模型名原样转发（如 `gpt-4o-mini-transcribe` 或 `openai/whisper-1`）。

use super::audio_util::{pcm_to_wav, truncate_chars};
use super::types::{AsrProviderConfig, AsrResult, TestResult};
use std::time::Instant;

/// 将 API base 规范为以版本路径结尾的 URL（如 `.../v1`），不碰豆包 `/api→/v3` 特殊逻辑。
fn normalize_api_base(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    // 已带版本后缀
    if trimmed.ends_with("/v1")
        || trimmed.ends_with("/v1beta")
        || trimmed.ends_with("/v2")
        || trimmed.ends_with("/v3")
    {
        return trimmed.to_string();
    }
    // OpenRouter 常见：https://openrouter.ai/api
    if trimmed.ends_with("/api") {
        return format!("{}/v1", trimmed);
    }
    // OpenAI 常见：https://api.openai.com
    format!("{}/v1", trimmed)
}

fn resolve_api_url(config: &AsrProviderConfig) -> Result<String, String> {
    // 优先顶层字段；兼容误塞进 extra 的旧/临时数据
    let raw = if !config.api_url.trim().is_empty() {
        config.api_url.trim()
    } else {
        config
            .extra
            .get("api_url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
    };
    if raw.is_empty() {
        return Err("ASR API 地址为空：请填写 OpenAI / OpenRouter 的 API URL".into());
    }
    let base = normalize_api_base(raw);
    Ok(format!("{}/audio/transcriptions", base))
}

fn resolve_model(config: &AsrProviderConfig) -> Result<String, String> {
    let model = if !config.model.trim().is_empty() {
        config.model.trim()
    } else {
        config
            .extra
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
    };
    if model.is_empty() {
        return Err("ASR 模型为空：请填写模型名（如 gpt-4o-mini-transcribe 或 openai/whisper-1）".into());
    }
    Ok(model.to_string())
}

fn build_prompt(hotwords: &[String]) -> Option<String> {
    if hotwords.is_empty() {
        return None;
    }
    // OpenAI transcriptions 的 prompt 是“风格提示 / 词汇偏好”，不是严格热词表
    let joined = hotwords
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .take(64)
        .collect::<Vec<_>>()
        .join(", ");
    if joined.is_empty() {
        None
    } else {
        Some(format!("Vocabulary: {}", joined))
    }
}

fn extract_text(data: &serde_json::Value) -> String {
    if let Some(t) = data.get("text").and_then(|v| v.as_str()) {
        return t.trim().to_string();
    }
    // 少数网关把结果包在 data 里
    if let Some(t) = data
        .get("data")
        .and_then(|d| d.get("text"))
        .and_then(|v| v.as_str())
    {
        return t.trim().to_string();
    }
    String::new()
}

fn extract_error_message(body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(msg) = v
            .pointer("/error/message")
            .and_then(|m| m.as_str())
            .or_else(|| v.get("message").and_then(|m| m.as_str()))
        {
            return truncate_chars(msg, 200);
        }
    }
    truncate_chars(body, 200)
}

pub async fn transcribe(
    audio_pcm_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
    hotwords: &[String],
) -> Result<AsrResult, String> {
    if config.api_key.trim().is_empty() {
        return Err("API Key 为空".into());
    }
    let url = resolve_api_url(config)?;
    let model = resolve_model(config)?;

    let pcm = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        audio_pcm_b64,
    )
    .map_err(|e| format!("base64 解码失败: {}", e))?;

    if pcm.is_empty() {
        return Ok(AsrResult {
            text: String::new(),
            elapsed_ms: 0,
        });
    }

    let wav = pcm_to_wav(&pcm, sample_rate);
    let file_part = reqwest::multipart::Part::bytes(wav)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|e| format!("构造 multipart 失败: {}", e))?;

    let mut form = reqwest::multipart::Form::new()
        .text("model", model.clone())
        .part("file", file_part);

    if let Some(prompt) = build_prompt(hotwords) {
        form = form.text("prompt", prompt);
    }

    // 新模型（gpt-4o-*-transcribe）仅支持 json；whisper-1 也接受 json
    form = form.text("response_format", "json");

    let client = reqwest::Client::new();
    let start = Instant::now();
    let api_key = config.api_key.trim();

    // 注意：先设 Authorization，再 multipart（reqwest 会保留鉴权头并改写 Content-Type boundary）
    let mut req = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key));
    // OpenRouter 企业网关有时对 STT 也要求 Referer；无害可带
    if url.contains("openrouter") {
        req = req
            .header("HTTP-Referer", "https://github.com/chobijaeyu/SayIt")
            .header("X-OpenRouter-Title", "SayIt");
    }
    let resp = req
        .multipart(form)
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("HTTP 请求失败: {}", e))?;

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!(
            "ASR 错误 {} (请求 {})：{}",
            status,
            url,
            extract_error_message(&body)
        ));
    }

    let data: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("解析响应失败: {} body={}", e, truncate_chars(&body, 120)))?;

    Ok(AsrResult {
        text: extract_text(&data),
        elapsed_ms,
    })
}

pub async fn test_connection(config: &AsrProviderConfig) -> TestResult {
    let start = Instant::now();
    let url = match resolve_api_url(config) {
        Ok(u) => u,
        Err(e) => {
            return TestResult {
                ok: false,
                message: e,
                elapsed_ms: 0,
                detail: String::new(),
            };
        }
    };
    let model = match resolve_model(config) {
        Ok(m) => m,
        Err(e) => {
            return TestResult {
                ok: false,
                message: e,
                elapsed_ms: 0,
                detail: String::new(),
            };
        }
    };
    if config.api_key.trim().is_empty() {
        return TestResult {
            ok: false,
            message: "API Key 为空".into(),
            elapsed_ms: 0,
            detail: String::new(),
        };
    }

    // 0.5s 静音 WAV，真正打到 transcriptions 端点
    let silence = vec![0u8; 16000];
    let wav = pcm_to_wav(&silence, 16000);
    let file_part = match reqwest::multipart::Part::bytes(wav)
        .file_name("test.wav")
        .mime_str("audio/wav")
    {
        Ok(p) => p,
        Err(e) => {
            return TestResult {
                ok: false,
                message: format!("构造测试音频失败: {}", e),
                elapsed_ms: 0,
                detail: String::new(),
            };
        }
    };

    let form = reqwest::multipart::Form::new()
        .text("model", model.clone())
        .text("response_format", "json")
        .part("file", file_part);

    let client = reqwest::Client::new();
    let api_key = config.api_key.trim();
    let mut req = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key));
    if url.contains("openrouter") {
        req = req
            .header("HTTP-Referer", "https://github.com/chobijaeyu/SayIt")
            .header("X-OpenRouter-Title", "SayIt");
    }
    let result = req
        .multipart(form)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await;

    let elapsed_ms = start.elapsed().as_millis() as u64;
    match result {
        Ok(resp) if resp.status().is_success() => {
            let body = resp.text().await.unwrap_or_default();
            let text = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .map(|v| extract_text(&v))
                .unwrap_or_default();
            TestResult {
                ok: true,
                message: format!("连接成功 ({}ms)", elapsed_ms),
                elapsed_ms,
                detail: format!(
                    "耗时: {}ms\n模型: {}\n请求: {}\n转写预览: {}",
                    elapsed_ms,
                    model,
                    url,
                    if text.is_empty() { "(空/静音)" } else { &text }
                ),
            }
        }
        Ok(resp) => {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            let mut hint = String::new();
            if status.as_u16() == 401 {
                hint = "\n提示: 401 多为 Key 未带上或企业网关不认；确认 Key 已粘贴、供应商为 OpenAI 兼容、地址为 …/api（不要填控制台网页 URL）。企业代理若未开通 /audio/transcriptions 也会失败。".into();
            } else if status.as_u16() == 404 {
                hint = "\n提示: 404 多为 URL 拼错或企业 OpenRouter 未开通 STT；确认最终请求含 /v1/audio/transcriptions。".into();
            }
            TestResult {
                ok: false,
                message: format!("API 返回 {}: {}", status, extract_error_message(&body)),
                elapsed_ms,
                detail: format!("模型: {}\n请求地址: {}{}", model, url, hint),
            }
        }
        Err(e) => TestResult {
            ok: false,
            message: format!("请求失败: {}", e),
            elapsed_ms,
            detail: format!("模型: {}\n请求地址: {}", model, url),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_openai_and_openrouter() {
        assert_eq!(
            normalize_api_base("https://api.openai.com"),
            "https://api.openai.com/v1"
        );
        assert_eq!(
            normalize_api_base("https://api.openai.com/v1"),
            "https://api.openai.com/v1"
        );
        assert_eq!(
            normalize_api_base("https://openrouter.ai/api"),
            "https://openrouter.ai/api/v1"
        );
        assert_eq!(
            normalize_api_base("https://openrouter.ai/api/v1/"),
            "https://openrouter.ai/api/v1"
        );
    }
}
