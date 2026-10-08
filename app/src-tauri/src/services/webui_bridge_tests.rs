//! fast-27b 同源桥的端到端自测（需要本机 fast-27b 引擎已在跑）。
//!
//! 运行：
//! ```text
//! FAST27B_TEST_API_KEY=<引擎 API Key> cargo test --lib webui_bridge -- --ignored --nocapture
//! ```
//! 覆盖官方 webui 真正会用到的契约：内嵌页面（gzip）、合成 `/props`、`/slots`、
//! 带 `X-Conversation-Id` 的流式补全（补 `model`、`top_k` 收敛）、`/v1/stream` 回放与续传、
//! `/v1/streams/lookup`、`DELETE /v1/stream` 取消。

use super::*;
use std::net::TcpStream;

/// 极简 HTTP 客户端（回环自测用）：发一次请求、收完整响应。
fn request(port: u16, raw: &str) -> (u16, String, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("连接桥失败");
    stream.set_read_timeout(Some(Duration::from_secs(120))).ok();
    stream.write_all(raw.as_bytes()).expect("写请求失败");
    stream.flush().ok();
    let mut buffer = Vec::new();
    stream.read_to_end(&mut buffer).ok();
    let text = String::from_utf8_lossy(&buffer).to_string();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((text.as_str(), ""));
    (status, head.to_string(), body.to_string())
}

fn get(port: u16, path: &str) -> (u16, String, String) {
    request(
        port,
        &format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n"
        ),
    )
}

#[test]
#[ignore]
fn e2e_bridge_serves_official_webui_for_fast27b() {
    let key = std::env::var("FAST27B_TEST_API_KEY").unwrap_or_default();
    assert!(!key.is_empty(), "需要 FAST27B_TEST_API_KEY 环境变量");
    let info = ensure(8195, 8084, &key, 65536).expect("起桥失败");
    assert_eq!(info.url, "http://127.0.0.1:8195");

    // 1) 官方页面：gzip 原样回给浏览器
    let (status, head, body) = get(8195, "/");
    assert_eq!(status, 200, "首页应 200：{head}");
    assert!(head.contains("Content-Encoding: gzip"), "首页应 gzip：{head}");
    assert!(!body.is_empty());

    // 2) 合成 /props：webui 靠它拿上下文长度与默认采样参数
    let (status, _, body) = get(8195, "/props?autoload=false");
    assert_eq!(status, 200);
    let props: serde_json::Value = serde_json::from_str(&body).expect("props 必须是 JSON");
    assert!(props["default_generation_settings"]["n_ctx"].as_u64().unwrap_or(0) > 0);
    // n_predict 必须等于引擎真实的 --default-max-tokens（此前写死 -1，界面会显示一个
    // 引擎并不兑现的「无限」上限）。
    assert_eq!(
        props["default_generation_settings"]["n_predict"].as_i64(),
        Some(65536),
        "n_predict 应反映引擎默认输出上限：{body}"
    );

    // 3) 槽位：空数组 = 都空闲（webui 用它决定能否发送）
    let (status, _, body) = get(8195, "/slots");
    assert_eq!(status, 200);
    assert_eq!(body.trim(), "[]");

    // 4) 流式补全：带 X-Conversation-Id；桥要补 model、收敛 top_k≤20，并把流记进账本
    let payload = r#"{"messages":[{"role":"user","content":"say hi"}],"stream":true,"top_k":40}"#;
    let raw = format!(
        "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nX-Conversation-Id: e2e-conv::qwen3.8-27b\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        payload.len(),
        payload
    );
    let (status, head, body) = request(8195, &raw);
    assert_eq!(status, 200, "补全应 200：{head}\n{body}");
    assert!(body.contains("data:"), "应为 SSE：{body}");
    assert!(body.contains("[DONE]"), "SSE 应以 [DONE] 结束：{body}");

    // 5) 流回放：官方界面断流续传走这里（conv_id 里的 :: 会被 URL 编码）
    let (status, head, replay) = get(8195, "/v1/stream?conv_id=e2e-conv%3A%3Aqwen3.8-27b&from=0");
    assert_eq!(status, 200, "回放应 200：{head}");
    assert!(head.contains("text/event-stream"), "回放应是 SSE：{head}");
    assert!(replay.contains("[DONE]"), "回放应含完整流：{replay}");

    // 6) 续传偏移越界：立刻结束（body 只剩 chunked 结束标记；webui 用 bytesReceived 做 from）
    let (status, _, tail) = get(8195, "/v1/stream?conv_id=e2e-conv&from=999999");
    assert_eq!(status, 200);
    assert!(!tail.contains("data:"), "越界偏移不应再吐数据：{tail}");

    // 7) 流查询：页面刷新后判断有无在跑的流
    let lookup = r#"{"conversation_ids":["e2e-conv::qwen3.8-27b"]}"#;
    let raw = format!(
        "POST /v1/streams/lookup HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        lookup.len(),
        lookup
    );
    let (status, _, body) = request(8195, &raw);
    assert_eq!(status, 200);
    let live: serde_json::Value = serde_json::from_str(&body).expect("lookup 必须是 JSON 数组");
    assert!(live.is_array());

    // 8) 取消：DELETE 后流被标记取消（界面「停止生成」走这里）
    let (status, _, _) = request(
        8195,
        "DELETE /v1/stream?conv_id=e2e-conv HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    );
    assert_eq!(status, 200);

    // 9) 无该会话时回放应 404（官方界面据此判定「没有可续传的流」）
    let (status, _, _) = get(8195, "/v1/stream?conv_id=unknown-conv&from=0");
    assert_eq!(status, 404);

    stop();
}