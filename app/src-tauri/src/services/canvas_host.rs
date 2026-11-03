//! 无限画布的本地静态托管。
//!
//! 画布是参考项目提供的独立 Web 应用，必须从一个稳定的 origin 打开：
//! - 画布项目（localStorage / IndexedDB）按 origin 隔离，端口变化会表现为“项目全丢”；
//! - 因此这里只接受调用方给定的固定端口，不静默回退。
//!
//! 只监听 `127.0.0.1`，只读托管画布 `dist`，并动态返回 `config.js`
//! 把网关地址注入前端。这样网关端口可以变化，而画布 origin 保持不变。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

/// 静态托管线程的句柄。
pub struct CanvasHostHandle {
    shutdown: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    port: u16,
}

impl CanvasHostHandle {
    pub fn port(&self) -> u16 {
        self.port
    }

    /// 停止托管线程。最多等待一个 200ms 的轮询周期。
    pub fn stop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for CanvasHostHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// 启动画布静态服务。
///
/// `root` 是画布 `dist` 目录（包含 `index.html`），`gateway_port` 写入动态
/// `config.js`。端口被占用时直接报错，由上层给出中文提示。
pub fn start(root: PathBuf, port: u16, gateway_port: u16) -> Result<CanvasHostHandle, String> {
    if !root.join("index.html").is_file() {
        return Err(format!("画布目录缺少 index.html：{}", root.display()));
    }

    let server = Server::http(("127.0.0.1", port)).map_err(|error| {
        format!(
            "无法启动画布静态服务（端口 {port}）：{error}。请关闭占用该端口的程序，或在画布设置里换一个端口。"
        )
    })?;

    let shutdown = Arc::new(AtomicBool::new(false));
    let flag = shutdown.clone();
    let thread = thread::spawn(move || {
        while !flag.load(Ordering::SeqCst) {
            match server.recv_timeout(Duration::from_millis(200)) {
                Ok(Some(request)) => handle_request(request, &root, gateway_port),
                Ok(None) => {}
                Err(error) => {
                    eprintln!("[canvas] 静态服务接收请求失败：{error}");
                    break;
                }
            }
        }
    });

    Ok(CanvasHostHandle {
        shutdown,
        thread: Some(thread),
        port,
    })
}

fn handle_request(request: Request, root: &Path, gateway_port: u16) {
    let method = request.method().clone();
    if method == Method::Options {
        respond_empty(request, StatusCode(204));
        return;
    }
    if method != Method::Get && method != Method::Head {
        respond_text(request, StatusCode(405), "Method Not Allowed");
        return;
    }

    let raw_path = request.url().split('?').next().unwrap_or("/");
    let Some(decoded) = percent_decode(raw_path) else {
        respond_text(request, StatusCode(400), "Bad Request");
        return;
    };

    if decoded == "/config.js" {
        let body = runtime_config_js(gateway_port);
        respond_bytes(
            request,
            StatusCode(200),
            "application/javascript; charset=utf-8",
            body.into_bytes(),
            "no-cache",
        );
        return;
    }

    let relative = decoded.trim_start_matches('/');
    let relative = if relative.is_empty() {
        "index.html"
    } else {
        relative
    };
    let Some(normalized) = normalize_relative(relative) else {
        respond_text(request, StatusCode(400), "Bad Request");
        return;
    };

    let candidate = root.join(&normalized);
    let file = if candidate.is_file() {
        candidate
    } else if Path::new(&normalized).extension().is_none() {
        // 画布使用前端路由，未知的无扩展名路径回到 index.html。
        root.join("index.html")
    } else {
        respond_text(request, StatusCode(404), "Not Found");
        return;
    };

    serve_file(request, &file, method == Method::Head);
}

fn serve_file(request: Request, file: &Path, head_only: bool) {
    let body = match fs::read(file) {
        Ok(body) => body,
        Err(error) => {
            eprintln!("[canvas] 读取静态文件失败 {}：{error}", file.display());
            respond_text(request, StatusCode(404), "Not Found");
            return;
        }
    };
    let mime = mime_for(file);
    let cache = if file.extension().and_then(|value| value.to_str()) == Some("html") {
        "no-cache"
    } else {
        "public, max-age=3600"
    };
    if head_only {
        respond_bytes(request, StatusCode(200), mime, Vec::new(), cache);
    } else {
        respond_bytes(request, StatusCode(200), mime, body, cache);
    }
}

fn respond_text(request: Request, status: StatusCode, text: &str) {
    let _ = request.respond(
        Response::from_string(text)
            .with_status_code(status)
            .with_header(header("Content-Type", "text/plain; charset=utf-8")),
    );
}

fn respond_empty(request: Request, status: StatusCode) {
    let _ = request.respond(Response::empty(status));
}

fn respond_bytes(
    request: Request,
    status: StatusCode,
    content_type: &str,
    body: Vec<u8>,
    cache_control: &str,
) {
    let response = Response::from_data(body)
        .with_status_code(status)
        .with_header(header("Content-Type", content_type))
        .with_header(header("Cache-Control", cache_control))
        .with_header(header("X-Content-Type-Options", "nosniff"))
        .with_header(header("Access-Control-Allow-Origin", "*"))
        .with_header(header("Connection", "close"));
    let _ = request.respond(response);
}

fn header(name: &str, value: &str) -> Header {
    // Header 的 name/value 都来自本文件的常量或 MIME 表，不会包含换行。
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("静态服务响应头必须合法")
}

fn runtime_config_js(gateway_port: u16) -> String {
    format!(
        "window.__RUNTIME_CONFIG__ = Object.assign(window.__RUNTIME_CONFIG__ || {{}}, {{\n  LOCAL_GATEWAY_URL: \"http://127.0.0.1:{gateway_port}/v1\",\n  LOCAL_GATEWAY_HOST: \"127.0.0.1\",\n  LOCAL_GATEWAY_PORT: \"{gateway_port}\"\n}});\n"
    )
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}

/// 把 URL 路径拆成安全的相对路径；含 `..`、盘符、反斜杠或 NUL 一律拒绝。
fn normalize_relative(value: &str) -> Option<PathBuf> {
    let mut result = PathBuf::new();
    for segment in value.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".."
            || segment.contains('\\')
            || segment.contains(':')
            || segment.contains('\0')
        {
            return None;
        }
        result.push(segment);
    }
    if result.as_os_str().is_empty() {
        result.push("index.html");
    }
    Some(result)
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let high = hex_value(bytes[index + 1])?;
            let low = hex_value(bytes[index + 2])?;
            let decoded = (high << 4) | low;
            if decoded == 0 {
                return None;
            }
            output.push(decoded);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).ok()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_relative, percent_decode, runtime_config_js};

    #[test]
    fn rejects_path_traversal() {
        assert!(normalize_relative("../secret").is_none());
        assert!(normalize_relative("assets/../../secret").is_none());
        assert!(normalize_relative("C:/Windows/win.ini").is_none());
        assert!(normalize_relative("assets\\..\\secret").is_none());
    }

    #[test]
    fn keeps_normal_assets() {
        assert_eq!(
            normalize_relative("assets/index-abc.js")
                .unwrap()
                .to_string_lossy(),
            "assets\\index-abc.js"
        );
        assert_eq!(
            normalize_relative("").unwrap().to_string_lossy(),
            "index.html"
        );
    }

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(
            percent_decode("/assets/a%20b.js").as_deref(),
            Some("/assets/a b.js")
        );
        assert!(percent_decode("/assets/%00.js").is_none());
        assert!(percent_decode("/assets/%zz.js").is_none());
    }

    #[test]
    fn config_points_to_gateway() {
        assert!(runtime_config_js(8190).contains("127.0.0.1:8190/v1"));
    }
}
