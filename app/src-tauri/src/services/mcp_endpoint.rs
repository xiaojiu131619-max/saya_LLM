//! MCP 网络传输的 URL 校验。
//!
//! 这里是「用户填的地址会被应用发请求」的安全边界，按验收条件实现：
//! - 只允许 http / https；
//! - 发请求前解析 host，拒绝 localhost、环回、私有与保留地址；
//! - 额外收紧：拒绝带用户名/密码的 URL（凭据应走 headers，避免出现在日志里）。
//!
//! 注意：这里**不做** DNS 之后的二次校验，因此理论上仍存在
//! DNS rebinding 窗口（校验用的解析结果与真正连接时的可能不同）。
//! 对「用户自己填写远端 MCP 端点」这一场景，本校验的目标是防止把地址
//! 指向内网/本机服务，而非抵御恶意 DNS 服务器。

use std::net::IpAddr;

use crate::models::mcp_types::McpServerConfig;

/// 校验并规范化 MCP 端点 URL。返回可直接用于请求的 URL 字符串。
pub fn validate_endpoint(url: &str) -> Result<String, String> {
    validate_endpoint_with(url, false)
}

/// 与 `validate_endpoint` 相同，但允许测试放开本机/内网限制。
///
/// `allow_local` 仅供集成测试使用：测试要连本地 fixture 服务器验证协议实现，
/// 而生产路径永远走 `validate_endpoint`（即 `allow_local = false`）。
pub fn validate_endpoint_with(url: &str, allow_local: bool) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("请填写 MCP 端点地址。".to_string());
    }

    let parsed = reqwest::Url::parse(trimmed)
        .map_err(|error| format!("MCP 端点地址无法解析：{error}"))?;

    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!(
            "只支持 http / https 地址，当前协议是 `{scheme}`。"
        ));
    }

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(
            "地址里不要带用户名或密码。需要鉴权请改用请求头（例如 Authorization）。".to_string(),
        );
    }

    if allow_local {
        return Ok(parsed.to_string());
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "MCP 端点地址缺少主机名。".to_string())?;
    ensure_host_is_public(host, parsed.port_or_known_default())?;

    Ok(parsed.to_string())
}

/// 拒绝指向本机 / 内网 / 保留地址的主机名。
pub fn ensure_host_is_public(host: &str, port: Option<u16>) -> Result<(), String> {
    let normalized = host.trim().trim_start_matches('[').trim_end_matches(']');

    // 主机名形态：localhost 及其子域一律拒绝。
    let lower = normalized.to_ascii_lowercase();
    if lower == "localhost" || lower.ends_with(".localhost") {
        return Err("出于安全考虑，不允许把 MCP 端点指向本机（localhost）。".to_string());
    }

    // 直接是 IP 字面量时做地址段判定。
    if let Ok(address) = normalized.parse::<IpAddr>() {
        return ensure_address_is_public(address);
    }

    // 域名形态：解析一次，确认没有任何一条结果落在受限网段。
    // 解析失败时直接报错——宁可不连，也不要放过一个说不清指向的域名。
    let resolved = (normalized, port.unwrap_or(443))
        .to_socket_addrs()
        .map_err(|error| format!("无法解析 MCP 端点主机 `{normalized}`：{error}"))?;
    for address in resolved {
        ensure_address_is_public(address.ip())?;
    }
    Ok(())
}

fn ensure_address_is_public(address: IpAddr) -> Result<(), String> {
    let blocked = match address {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
                // 100.64.0.0/10 运营商级 NAT（is_shared 在稳定版还未提供，手工判定）
                || (v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1]))
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // fc00::/7 唯一本地地址
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                // fe80::/10 链路本地
                || (v6.segments()[0] & 0xffc0) == 0xfe80
        }
    };
    if blocked {
        return Err(format!(
            "出于安全考虑，不允许把 MCP 端点指向本机或内网地址（{address}）。"
        ));
    }
    Ok(())
}

/// 校验一份 MCP 服务器配置里与传输相关的部分。
pub fn validate_server_transport(config: &McpServerConfig) -> Result<(), String> {
    if config.transport.is_network() {
        validate_endpoint(&config.command)?;
        for header in &config.headers {
            if header.key.trim().is_empty() {
                return Err("请求头名称不能为空。".to_string());
            }
            // 换行符会让请求头被注入额外字段，必须拒绝。
            if header.key.contains(['\r', '\n']) || header.value.contains(['\r', '\n']) {
                return Err(format!(
                    "请求头 `{}` 含有非法换行符。",
                    header.key.trim()
                ));
            }
        }
    } else if config.command.trim().is_empty() {
        return Err("请填写启动命令（例如 npx）。".to_string());
    }
    Ok(())
}

use std::net::ToSocketAddrs;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_http_schemes() {
        assert!(validate_endpoint("file:///etc/passwd").is_err());
        assert!(validate_endpoint("ftp://example.com/mcp").is_err());
        assert!(validate_endpoint("javascript:alert(1)").is_err());
    }

    #[test]
    fn rejects_loopback_and_private_hosts() {
        for url in [
            "http://localhost:8080/mcp",
            "http://127.0.0.1/mcp",
            "http://127.1.2.3/mcp",
            "http://[::1]/mcp",
            "http://192.168.1.10/mcp",
            "http://10.0.0.5/mcp",
            "http://172.16.0.9/mcp",
            "http://169.254.1.1/mcp",
            "http://0.0.0.0/mcp",
            "http://100.64.0.1/mcp",
            "http://app.localhost/mcp",
        ] {
            let error = validate_endpoint(url).expect_err(&format!("{url} 应被拒绝"));
            assert!(
                error.contains("不允许") || error.contains("无法解析"),
                "{url} 的报错应说明原因，实际：{error}"
            );
        }
    }

    #[test]
    fn rejects_credentials_in_url() {
        let error = validate_endpoint("https://user:pass@example.com/mcp")
            .expect_err("带凭据的 URL 应被拒绝");
        assert!(error.contains("请求头"), "应引导用户改用请求头：{error}");
    }

    #[test]
    fn accepts_public_https_endpoint() {
        let ok = validate_endpoint("https://mcp.exa.ai/mcp?tools=web_search_exa")
            .expect("公网 https 端点应通过");
        assert!(ok.starts_with("https://mcp.exa.ai/"));
    }

    #[test]
    fn rejects_empty_and_schemeless() {
        assert!(validate_endpoint("   ").is_err());
        assert!(validate_endpoint("mcp.exa.ai/mcp").is_err());
    }

    #[test]
    fn rejects_header_injection_in_transport_validation() {
        let config = McpServerConfig {
            id: "t".into(),
            name: "T".into(),
            enabled: true,
            transport: crate::models::mcp_types::McpTransport::Http,
            command: "https://mcp.exa.ai/mcp".into(),
            args: Vec::new(),
            env: Vec::new(),
            cwd: None,
            headers: vec![crate::models::mcp_types::McpEnvVar {
                key: "X-Test".into(),
                value: "a\r\nEvil: 1".into(),
            }],
            timeout_ms: 60_000,
        };
        let error = validate_server_transport(&config).expect_err("含换行的请求头应被拒绝");
        assert!(error.contains("换行"), "报错应说明换行问题：{error}");
    }
}
