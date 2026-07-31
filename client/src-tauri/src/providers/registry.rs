// 供应商注册表 — Tauri commands 入口

use super::types::*;
use super::{
    ai_openai_compat, ai_ollama, asr_doubao, asr_doubao_stream, asr_mimo, asr_openai_compat,
    asr_qwen, asr_qwen_omni,
};

/// 云端 AI 校对（Tauri command）— 主路径，短输出
#[tauri::command]
pub async fn cloud_polish(request: CloudPolishRequest) -> Result<AiResult, String> {
    let config = &request.ai_config;
    match config.provider.as_str() {
        "openai_compat" | "deepseek" | "doubao" | "qwen" | "mimo" => {
            ai_openai_compat::polish(
                &request.text,
                config,
                request.system_prompt.as_deref(),
            )
            .await
        }
        "ollama" => {
            ai_ollama::polish(
                &request.text,
                config,
                request.system_prompt.as_deref(),
            )
            .await
        }
        other => Err(format!("未知的 AI 供应商: {}", other)),
    }
}

/// 历史「学习」讲解（Tauri command）— 与 polish 隔离，可要求 JSON / 更高 token
#[tauri::command]
pub async fn cloud_learning(request: CloudLearningRequest) -> Result<AiResult, String> {
    let config = &request.ai_config;
    let system = request
        .system_prompt
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "learning system_prompt 不能为空".to_string())?;
    let max_tokens = request.max_tokens.unwrap_or(2048);
    let prefer_json = request.prefer_json.unwrap_or(true);

    match config.provider.as_str() {
        "openai_compat" | "deepseek" | "doubao" | "qwen" | "mimo" => {
            ai_openai_compat::learning_complete(
                &request.text,
                config,
                system,
                max_tokens,
                prefer_json,
            )
            .await
        }
        // Ollama 走本地 /api/generate，无 response_format；靠 prompt 约束 JSON
        "ollama" => {
            let _ = (max_tokens, prefer_json);
            ai_ollama::learning_complete(&request.text, config, system).await
        }
        other => Err(format!("未知的 AI 供应商: {}", other)),
    }
}

/// 测试 AI 连接（Tauri command）
#[tauri::command]
pub async fn test_ai_connection(config: AiProviderConfig) -> Result<TestResult, String> {
    match config.provider.as_str() {
        "openai_compat" | "deepseek" | "doubao" | "qwen" | "mimo" => {
            Ok(ai_openai_compat::test_connection(&config).await)
        }
        "ollama" => {
            Ok(ai_ollama::test_connection(&config).await)
        }
        other => Err(format!("未知的 AI 供应商: {}", other)),
    }
}

/// 云端 ASR 转写（Tauri command）
#[tauri::command]
pub async fn cloud_transcribe(request: CloudTranscribeRequest) -> Result<AsrResult, String> {
    let config = &request.asr_config;
    match config.provider.as_str() {
        "doubao" => {
            asr_doubao::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        "doubao_v2" => {
            asr_doubao_stream::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        "qwen" | "aliyun" | "qwen_realtime" => {
            asr_qwen::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        "qwen_omni" => {
            asr_qwen_omni::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        "mimo" => {
            asr_mimo::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        "openai_compat" => {
            asr_openai_compat::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        // TODO: "aliyun" => 阿里云 Paraformer（需要文件 URL + 异步轮询，暂未实现）
        other => Err(format!("ASR 供应商 \"{}\" 尚未实现", other)),
    }
}

/// 测试 ASR 连接（Tauri command）
#[tauri::command]
pub async fn test_asr_connection(config: AsrProviderConfig) -> Result<TestResult, String> {
    match config.provider.as_str() {
        "doubao" => Ok(asr_doubao::test_connection(&config).await),
        "doubao_v2" => Ok(asr_doubao_stream::test_connection(&config).await),
        "qwen" | "aliyun" | "qwen_realtime" => Ok(asr_qwen::test_connection(&config).await),
        "qwen_omni" => Ok(asr_qwen_omni::test_connection(&config).await),
        "mimo" => Ok(asr_mimo::test_connection(&config).await),
        "openai_compat" => Ok(asr_openai_compat::test_connection(&config).await),
        other => Err(format!("ASR 供应商 \"{}\" 尚未实现", other)),
    }
}
