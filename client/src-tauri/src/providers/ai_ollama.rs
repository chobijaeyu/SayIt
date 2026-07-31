// Ollama AI 供应商
// 调用本地 Ollama 的 /api/generate 接口

use super::prompt::wrap_user_text;
use super::types::{AiProviderConfig, AiResult, TestResult};
use std::time::Instant;

/// 调用 Ollama 进行文本校对
pub async fn polish(
    text: &str,
    config: &AiProviderConfig,
    system_prompt: Option<&str>,
) -> Result<AiResult, String> {
    generate(
        text,
        config,
        system_prompt.unwrap_or("你是语音转文本的校对助手。"),
        true,
    )
    .await
}

/// 历史「学习」：不把空结果回退成原文（避免把 ASR 当讲解缓存）
pub async fn learning_complete(
    text: &str,
    config: &AiProviderConfig,
    system_prompt: &str,
) -> Result<AiResult, String> {
    generate(text, config, system_prompt, false).await
}

async fn generate(
    text: &str,
    config: &AiProviderConfig,
    system_prompt: &str,
    empty_fallback_to_input: bool,
) -> Result<AiResult, String> {
    if text.trim().is_empty() {
        return Ok(AiResult {
            text: String::new(),
            elapsed_ms: 0,
        });
    }

    let url = normalize_url(&config.api_url);
    // Ollama /api/generate 是单一 prompt 字符串，没有 system/user 角色区分，
    // 这里手动拼接：system prompt 在前，user 消息（中性标签包裹）在后。
    let combined = format!("{}\n\n{}", system_prompt, wrap_user_text(text));

    let model = if config.model.is_empty() {
        "qwen2.5:7b"
    } else {
        &config.model
    };

    let body = serde_json::json!({
        "model": model,
        "stream": false,
        "prompt": combined
    });

    let client = reqwest::Client::new();
    let start = Instant::now();

    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(std::time::Duration::from_secs(90))
        .send()
        .await
        .map_err(|e| format!("Ollama 请求失败: {}", e))?;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(format!("Ollama 返回错误 {}: {}", status, truncate(&body_text, 200)));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析 Ollama 响应失败: {}", e))?;

    let result_text = data
        .get("response")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    let text_out = if result_text.is_empty() {
        if empty_fallback_to_input {
            text.to_string()
        } else {
            String::new()
        }
    } else {
        result_text
    };

    Ok(AiResult {
        text: text_out,
        elapsed_ms,
    })
}

/// 测试 Ollama 连接 — 实际调用模型，验证模型是否可用
pub async fn test_connection(config: &AiProviderConfig) -> TestResult {
    let url = normalize_url(&config.api_url);

    let model = if config.model.is_empty() {
        "qwen2.5:7b"
    } else {
        &config.model
    };

    let prompt = "只回复「连接正常」四个字，不要输出任何其他内容。";

    let body = serde_json::json!({
        "model": model,
        "stream": false,
        "prompt": prompt
    });

    let client = reqwest::Client::new();
    let start = Instant::now();

    let result = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(resp) if resp.status().is_success() => {
            let data: serde_json::Value = resp.json().await.unwrap_or_default();
            let reply = data
                .get("response")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let detail = format!(
                "耗时: {}ms\n模型: {}\n发送: \"{}\"\n回复: {}",
                elapsed_ms, model, prompt,
                if reply.is_empty() { "(空)" } else { &reply }
            );
            TestResult {
                ok: true,
                message: format!("连接成功 ({}ms)", elapsed_ms),
                elapsed_ms,
                detail,
            }
        }
        Ok(resp) => {
            let status = resp.status();
            let body_text = resp.text().await.unwrap_or_default();
            TestResult {
                ok: false,
                message: format!("Ollama 返回 {} : {}", status, truncate(&body_text, 100)),
                elapsed_ms,
                detail: format!("模型: {}\n请求地址: {}", model, url),
            }
        }
        Err(e) => TestResult {
            ok: false,
            message: format!("连接失败: {}", e),
            elapsed_ms,
            detail: format!("模型: {}\n请求地址: {}", model, url),
        },
    }
}

fn normalize_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.ends_with("/api/generate") {
        trimmed.to_string()
    } else if trimmed.ends_with("/api") {
        format!("{}/generate", trimmed)
    } else {
        format!("{}/api/generate", trimmed)
    }
}

fn truncate(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        format!("{}...", &s[..max_len])
    }
}
