// OpenAI 兼容 AI 供应商
// 覆盖所有支持 /v1/chat/completions 的服务：DeepSeek、通义、豆包（火山方舟）等

use super::prompt::wrap_user_text;
use super::types::{AiProviderConfig, AiResult, TestResult};
use std::time::Instant;

/// 调用 OpenAI 兼容接口进行文本校对
pub async fn polish(
    text: &str,
    config: &AiProviderConfig,
    system_prompt: Option<&str>,
) -> Result<AiResult, String> {
    if text.trim().is_empty() {
        return Ok(AiResult {
            text: String::new(),
            elapsed_ms: 0,
        });
    }

    let base_url = normalize_base_url(&config.api_url);
    let url = format!("{}/chat/completions", base_url);

    let sys_prompt = system_prompt.unwrap_or("你是语音转文本的校对助手。");
    let user_content = wrap_user_text(text);

    let mut body = serde_json::json!({
        "model": config.model,
        "temperature": 0.2,
        "max_tokens": 1024,
        "messages": [
            { "role": "system", "content": sys_prompt },
            { "role": "user", "content": user_content },
        ]
    });

    inject_disable_thinking(&mut body, config);

    let client = reqwest::Client::new();
    let start = Instant::now();

    let api_key = config.api_key.trim();
    if api_key.is_empty() {
        return Err("API Key 为空".into());
    }
    let mut req = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json");
    // 小米 MiMo 规范鉴权头为 api-key（同时兼容 Bearer），两个都带最稳妥
    if config.provider == "mimo" {
        req = req.header("api-key", api_key.to_string());
    }
    // OpenRouter 官方/企业代理：可选归属头（不影响鉴权，部分网关会校验 Referer）
    if url.contains("openrouter.ai") || config.api_url.to_ascii_lowercase().contains("openrouter") {
        req = req
            .header("HTTP-Referer", "https://github.com/chobijaeyu/SayIt")
            .header("X-OpenRouter-Title", "SayIt");
    }
    let resp = req
        .json(&body)
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("HTTP 请求失败: {}", describe_reqwest_error(&e)))?;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "API 返回错误 {} (请求 {})：{}",
            status,
            url,
            truncate_chars(&body_text, 200)
        ));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    // 便于对照 OpenRouter Activity：看实际落到哪个 host、是否仍在 reasoning
    if let Some(provider) = data.get("provider").and_then(|v| v.as_str()) {
        let reason_tok = data
            .get("usage")
            .and_then(|u| u.get("completion_tokens_details"))
            .and_then(|d| d.get("reasoning_tokens"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        log::info!(
            "ai polish provider={} model={} elapsed_ms={} reasoning_tokens={}",
            provider,
            config.model,
            elapsed_ms,
            reason_tok
        );
    }

    let result_text = extract_chat_completion_text(&data)
        .unwrap_or_else(|| text.to_string());

    // 去除 <think>...</think> 标签（部分模型如 Qwen3 会输出思考过程）
    let cleaned = strip_thinking(&result_text);

    Ok(AiResult {
        text: if cleaned.is_empty() { text.to_string() } else { cleaned },
        elapsed_ms,
    })
}

/// 测试 AI 连接 — 发送一个简短的聊天请求，验证地址、Key、模型是否都可用
pub async fn test_connection(config: &AiProviderConfig) -> TestResult {
    let base_url = normalize_base_url(&config.api_url);
    let url = format!("{}/chat/completions", base_url);

    let system_prompt = "只回复「连接正常」四个字，不要输出任何其他内容。";
    let user_prompt = "测试";

    let mut body = serde_json::json!({
        "model": config.model,
        "temperature": 0,
        "max_tokens": 10,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ]
    });

    inject_disable_thinking(&mut body, config);

    let client = reqwest::Client::new();
    let start = Instant::now();

    let api_key = config.api_key.trim();
    if api_key.is_empty() {
        return TestResult {
            ok: false,
            message: "API Key 为空".into(),
            elapsed_ms: 0,
            detail: format!("请求地址: {}", url),
        };
    }
    let mut req = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json");
    if config.provider == "mimo" {
        req = req.header("api-key", api_key.to_string());
    }
    if url.contains("openrouter.ai") || config.api_url.to_ascii_lowercase().contains("openrouter") {
        req = req
            .header("HTTP-Referer", "https://github.com/chobijaeyu/SayIt")
            .header("X-OpenRouter-Title", "SayIt");
    }
    let result = req
        .json(&body)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(resp) if resp.status().is_success() => {
            let data: serde_json::Value = resp.json().await.unwrap_or_default();
            let raw_reply = data
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let reply = strip_thinking(&raw_reply);
            let detail = format!(
                "耗时: {}ms\n模型: {}\n请求地址: {}\n发送: system=\"{}\" user=\"{}\"\n回复: {}",
                elapsed_ms, config.model, url, system_prompt, user_prompt,
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
            let body = resp.text().await.unwrap_or_default();
            TestResult {
                ok: false,
                message: format!("API 返回 {}: {}", status, truncate_chars(&body, 120)),
                elapsed_ms,
                detail: format!(
                    "模型: {}\n请求地址: {}\n提示: OpenRouter 地址应类似 https://openrouter.ai/api 或企业代理的 /api 根路径；模型用 deepseek/deepseek-v4-flash 这类 slug，且供应商选「OpenAI 兼容」而非「DeepSeek」直连。",
                    config.model, url
                ),
            }
        }
        Err(e) => TestResult {
            ok: false,
            message: format!("连接失败: {}", describe_reqwest_error(&e)),
            elapsed_ms,
            detail: format!("模型: {}\n请求地址: {}", config.model, url),
        },
    }
}

/// 将 reqwest 错误转为用户友好的中文描述
fn describe_reqwest_error(e: &reqwest::Error) -> String {
    let raw = format!("{}", e);
    if e.is_timeout() {
        return "请求超时，请检查网络或 API 地址是否正确".to_string();
    }
    if e.is_connect() {
        // 尝试区分 DNS / TLS / 连接拒绝
        let lower = raw.to_lowercase();
        if lower.contains("dns") || lower.contains("resolve") || lower.contains("getaddrinfo") {
            return format!("DNS 解析失败，域名可能不存在或网络不通: {}", raw);
        }
        if lower.contains("ssl") || lower.contains("tls") || lower.contains("certificate")
            || lower.contains("handshake") || lower.contains("schannel")
        {
            return format!("TLS/SSL 握手失败，可能是证书问题: {}", raw);
        }
        if lower.contains("refused") {
            return format!("连接被拒绝，服务可能未启动: {}", raw);
        }
        return format!("无法连接到服务器: {}", raw);
    }
    raw
}

/// 校对场景一律关闭思考/推理。覆盖：
/// - provider 字段为 qwen / deepseek / mimo
/// - openai_compat + OpenRouter 上 model slug 含 deepseek/qwen（此前只看 provider，漏关）
/// OpenRouter 实测 `reasoning.effort=none` 比单独 `thinking.disabled` 更稳。
fn inject_disable_thinking(body: &mut serde_json::Value, config: &AiProviderConfig) {
    let Some(obj) = body.as_object_mut() else {
        return;
    };
    let provider = config.provider.to_ascii_lowercase();
    let model = config.model.to_ascii_lowercase();
    let url = config.api_url.to_ascii_lowercase();
    let is_openrouter = url.contains("openrouter");
    let is_openai_compat = provider == "openai_compat" || is_openrouter;

    let is_qwen = provider == "qwen" || model.contains("qwen");
    let is_deepseek_family = provider == "deepseek"
        || provider == "mimo"
        || model.contains("deepseek")
        || model.contains("mimo");

    if is_qwen {
        obj.insert("enable_thinking".to_string(), serde_json::Value::Bool(false));
    }

    if is_deepseek_family {
        // 原生 DeepSeek / MiMo：thinking.type=disabled
        obj.insert(
            "thinking".to_string(),
            serde_json::json!({"type": "disabled"}),
        );
        // OpenRouter 等多 provider 网关：额外带 reasoning.effort=none（实测更可靠）
        if is_openai_compat {
            obj.insert(
                "reasoning".to_string(),
                serde_json::json!({"effort": "none"}),
            );
        }
    }
}

/// 规范化 base URL，得到可拼 `/chat/completions` 的前缀。
///
/// 规则：
/// - 已以 `/v1` / `/v3` 等版本结尾 → 原样
/// - 火山方舟 / 豆包 host 且以 `/api` 结尾 → `/api/v3`（豆包专用）
/// - 其它以 `/api` 结尾（含 OpenRouter 官方与企业代理）→ `/api/v1`
/// - 其它 → 补 `/v1`
fn normalize_base_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return trimmed.to_string();
    }
    // 已经以版本路径结尾
    if trimmed.ends_with("/v1")
        || trimmed.ends_with("/v1beta")
        || trimmed.ends_with("/v2")
        || trimmed.ends_with("/v3")
    {
        return trimmed.to_string();
    }
    // 豆包/火山方舟：…/api → …/api/v3（绝不能误伤 OpenRouter）
    let lower = trimmed.to_ascii_lowercase();
    let is_volc =
        lower.contains("volces.com") || lower.contains("volcengine.com") || lower.contains("ark.cn-");
    if trimmed.ends_with("/api") {
        if is_volc {
            return format!("{}/v3", trimmed);
        }
        // OpenRouter 官方 https://openrouter.ai/api → /api/v1
        // 企业 OpenRouter 代理 https://xxx.company.com/api → /api/v1
        return format!("{}/v1", trimmed);
    }
    format!("{}/v1", trimmed)
}

/// 从 chat completion 响应中提取文本
fn extract_chat_completion_text(data: &serde_json::Value) -> Option<String> {
    let content = data
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?;

    match content {
        serde_json::Value::String(s) => Some(s.trim().to_string()),
        serde_json::Value::Array(arr) => {
            let text: String = arr
                .iter()
                .filter_map(|item| {
                    if item.get("type")?.as_str()? == "text" {
                        item.get("text")?.as_str().map(String::from)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("");
            Some(text.trim().to_string())
        }
        _ => None,
    }
}

/// 去除 <think>...</think> 标签
fn strip_thinking(text: &str) -> String {
    let re = regex::Regex::new(r"(?is)<think>.*?</think>").unwrap_or_else(|_| {
        // fallback: 不做处理
        regex::Regex::new(r"^$").unwrap()
    });
    let cleaned = re.replace_all(text, "");
    let cleaned = cleaned.trim();

    // 如果有"最终答案"标记，取其后面的内容
    if let Some(pos) = cleaned.find("最终答案") {
        let after = &cleaned[pos + "最终答案".len()..];
        let after = after.trim_start_matches(|c: char| c == ':' || c == '：' || c.is_whitespace());
        return after.trim().to_string();
    }

    cleaned.to_string()
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max_chars).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::normalize_base_url;

    #[test]
    fn openrouter_api_gets_v1_not_v3() {
        assert_eq!(
            normalize_base_url("https://openrouter.ai/api"),
            "https://openrouter.ai/api/v1"
        );
        assert_eq!(
            normalize_base_url("https://openrouter.ai/api/"),
            "https://openrouter.ai/api/v1"
        );
        assert_eq!(
            normalize_base_url("https://or.company.com/api"),
            "https://or.company.com/api/v1"
        );
    }

    #[test]
    fn volc_api_still_gets_v3() {
        assert_eq!(
            normalize_base_url("https://ark.cn-beijing.volces.com/api"),
            "https://ark.cn-beijing.volces.com/api/v3"
        );
    }

    #[test]
    fn openai_root_gets_v1() {
        assert_eq!(
            normalize_base_url("https://api.openai.com"),
            "https://api.openai.com/v1"
        );
    }
}
