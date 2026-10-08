//! 官方 llama.cpp webui 内嵌资产（供 fast-27b 同源桥使用）。
//!
//! 资产来自 llama.cpp 发行版 `llama-server-impl.dll` 内嵌的 webui（gzip 流原样打包）：
//! 用 `scripts/pack-llama-webui.mjs` 从本机 llama-server 二进制里抽出来，存成
//! `resources/llama-webui.bin`，编译期由 `include_bytes!` 嵌入 exe。
//!
//! 为什么内嵌而不是用本机内核自带的 webui：fast-27b 引擎没有任何 HTML 页面，官方 webui 又只认
//! 同源相对路径（`./props`、`./v1/chat/completions`），只能在应用侧起一个同源转发层来提供页面 +
//! 抹平协议差异。转发层自己实现契约，因此页面版本与推理内核版本互相独立，内嵌一份固定版本即可。
//!
//! 资产以 **gzip 原样** 提供（与 llama-server 自身行为一致：带 `Content-Encoding: gzip` 返回），
//! 这样既不需要在 Rust 侧解压（无 gzip 依赖），又保持字节完全一致。

/// 所有 webui 资产的 gzip 流拼接（顺序与 [`ASSETS`] 一致）。
pub static WEBUI_BIN: &[u8] = include_bytes!("../../resources/llama-webui.bin");

/// 单个内嵌资产。
pub struct WebuiAsset {
    /// 资产在 webui 里的 URL 路径（不带前导 `/`）。
    pub path: &'static str,
    /// gzip 流在 [`WEBUI_BIN`] 中的偏移。
    pub offset: usize,
    /// gzip 流长度。
    pub gz_len: usize,
    /// 响应 Content-Type。
    pub mime: &'static str,
}

impl WebuiAsset {
    /// gzip 原始字节（原样回给浏览器，`Content-Encoding: gzip`）。
    pub fn gz_bytes(&self) -> &'static [u8] {
        &WEBUI_BIN[self.offset..self.offset + self.gz_len]
    }
}

/// 资产清单：来源构建 `llama.cpp b11860-0ba48c55a`（llama.cpp 发行包）。
///
/// 重新生成：`node scripts/pack-llama-webui.mjs <llama-server 二进制路径>`，
/// 它会把 gzip 流写进 `resources/llama-webui.bin` 并打印本表。
pub const ASSETS: &[WebuiAsset] = &[
    WebuiAsset { path: "_app/immutable/assets/bundle.oAmIsIaD.css", offset: 0, gz_len: 294651, mime: "text/css; charset=utf-8" },
    WebuiAsset { path: "_app/immutable/bundle.Cvb_ispa.js", offset: 294651, gz_len: 2600305, mime: "application/javascript; charset=utf-8" },
    WebuiAsset { path: "_app/version.json", offset: 2894956, gz_len: 47, mime: "application/json; charset=utf-8" },
    WebuiAsset { path: "apple-splash-landscape-1136x640.png", offset: 2895003, gz_len: 662, mime: "image/png" },
    WebuiAsset { path: "apple-splash-landscape-1334x750.png", offset: 2895665, gz_len: 710, mime: "image/png" },
    WebuiAsset { path: "apple-splash-landscape-2266x1488.png", offset: 2896375, gz_len: 1008, mime: "image/png" },
    WebuiAsset { path: "apple-splash-landscape-2360x1640.png", offset: 2897383, gz_len: 965, mime: "image/png" },
    WebuiAsset { path: "apple-splash-landscape-2388x1668.png", offset: 2898348, gz_len: 1062, mime: "image/png" },
    WebuiAsset { path: "apple-splash-landscape-2532x1170.png", offset: 2899410, gz_len: 922, mime: "image/png" },
    WebuiAsset { path: "apple-splash-landscape-2556x1179.png", offset: 2900332, gz_len: 866, mime: "image/png" },
    WebuiAsset { path: "apple-splash-landscape-2622x1206.png", offset: 2901198, gz_len: 858, mime: "image/png" },
    WebuiAsset { path: "apple-splash-landscape-2732x2048.png", offset: 2902056, gz_len: 1191, mime: "image/png" },
    WebuiAsset { path: "apple-splash-landscape-2778x1284.png", offset: 2903247, gz_len: 1031, mime: "image/png" },
    WebuiAsset { path: "apple-splash-landscape-2796x1290.png", offset: 2904278, gz_len: 904, mime: "image/png" },
    WebuiAsset { path: "apple-splash-landscape-2868x1320.png", offset: 2905182, gz_len: 983, mime: "image/png" },
    WebuiAsset { path: "apple-splash-landscape-dark-1136x640.png", offset: 2906165, gz_len: 661, mime: "image/png" },
    WebuiAsset { path: "apple-splash-landscape-dark-1334x750.png", offset: 2906826, gz_len: 727, mime: "image/png" },
    WebuiAsset { path: "apple-splash-landscape-dark-2266x1488.png", offset: 2907553, gz_len: 949, mime: "image/png" },
    WebuiAsset { path: "apple-splash-landscape-dark-2360x1640.png", offset: 2908502, gz_len: 933, mime: "image/png" },
    WebuiAsset { path: "apple-splash-landscape-dark-2388x1668.png", offset: 2909435, gz_len: 1012, mime: "image/png" },
    WebuiAsset { path: "apple-splash-landscape-dark-2532x1170.png", offset: 2910447, gz_len: 907, mime: "image/png" },
    WebuiAsset { path: "apple-splash-landscape-dark-2556x1179.png", offset: 2911354, gz_len: 889, mime: "image/png" },
    WebuiAsset { path: "apple-splash-landscape-dark-2622x1206.png", offset: 2912243, gz_len: 846, mime: "image/png" },
    WebuiAsset { path: "apple-splash-landscape-dark-2732x2048.png", offset: 2913089, gz_len: 1193, mime: "image/png" },
    WebuiAsset { path: "apple-splash-landscape-dark-2778x1284.png", offset: 2914282, gz_len: 967, mime: "image/png" },
    WebuiAsset { path: "apple-splash-landscape-dark-2796x1290.png", offset: 2915249, gz_len: 982, mime: "image/png" },
    WebuiAsset { path: "apple-splash-landscape-dark-2868x1320.png", offset: 2916231, gz_len: 968, mime: "image/png" },
    WebuiAsset { path: "apple-splash-portrait-1170x2532.png", offset: 2917199, gz_len: 749, mime: "image/png" },
    WebuiAsset { path: "apple-splash-portrait-1179x2556.png", offset: 2917948, gz_len: 808, mime: "image/png" },
    WebuiAsset { path: "apple-splash-portrait-1206x2622.png", offset: 2918756, gz_len: 832, mime: "image/png" },
    WebuiAsset { path: "apple-splash-portrait-1284x2778.png", offset: 2919588, gz_len: 760, mime: "image/png" },
    WebuiAsset { path: "apple-splash-portrait-1290x2796.png", offset: 2920348, gz_len: 553, mime: "image/png" },
    WebuiAsset { path: "apple-splash-portrait-1320x2868.png", offset: 2920901, gz_len: 848, mime: "image/png" },
    WebuiAsset { path: "apple-splash-portrait-1488x2266.png", offset: 2921749, gz_len: 1010, mime: "image/png" },
    WebuiAsset { path: "apple-splash-portrait-1640x2360.png", offset: 2922759, gz_len: 1038, mime: "image/png" },
    WebuiAsset { path: "apple-splash-portrait-1668x2388.png", offset: 2923797, gz_len: 1039, mime: "image/png" },
    WebuiAsset { path: "apple-splash-portrait-2048x2732.png", offset: 2924836, gz_len: 1023, mime: "image/png" },
    WebuiAsset { path: "apple-splash-portrait-640x1136.png", offset: 2925859, gz_len: 593, mime: "image/png" },
    WebuiAsset { path: "apple-splash-portrait-750x1334.png", offset: 2926452, gz_len: 658, mime: "image/png" },
    WebuiAsset { path: "apple-splash-portrait-dark-1170x2532.png", offset: 2927110, gz_len: 776, mime: "image/png" },
    WebuiAsset { path: "apple-splash-portrait-dark-1179x2556.png", offset: 2927886, gz_len: 847, mime: "image/png" },
    WebuiAsset { path: "apple-splash-portrait-dark-1206x2622.png", offset: 2928733, gz_len: 835, mime: "image/png" },
    WebuiAsset { path: "apple-splash-portrait-dark-1284x2778.png", offset: 2929568, gz_len: 739, mime: "image/png" },
    WebuiAsset { path: "apple-splash-portrait-dark-1290x2796.png", offset: 2930307, gz_len: 557, mime: "image/png" },
    WebuiAsset { path: "apple-splash-portrait-dark-1320x2868.png", offset: 2930864, gz_len: 855, mime: "image/png" },
    WebuiAsset { path: "apple-splash-portrait-dark-1488x2266.png", offset: 2931719, gz_len: 994, mime: "image/png" },
    WebuiAsset { path: "apple-splash-portrait-dark-1640x2360.png", offset: 2932713, gz_len: 980, mime: "image/png" },
    WebuiAsset { path: "apple-splash-portrait-dark-1668x2388.png", offset: 2933693, gz_len: 1010, mime: "image/png" },
    WebuiAsset { path: "apple-splash-portrait-dark-2048x2732.png", offset: 2934703, gz_len: 983, mime: "image/png" },
    WebuiAsset { path: "apple-splash-portrait-dark-640x1136.png", offset: 2935686, gz_len: 602, mime: "image/png" },
    WebuiAsset { path: "apple-splash-portrait-dark-750x1334.png", offset: 2936288, gz_len: 677, mime: "image/png" },
    WebuiAsset { path: "apple-touch-icon-180x180.png", offset: 2936965, gz_len: 815, mime: "image/png" },
    WebuiAsset { path: "favicon-dark.ico", offset: 2937780, gz_len: 516, mime: "image/x-icon" },
    WebuiAsset { path: "favicon-dark.svg", offset: 2938296, gz_len: 431, mime: "image/svg+xml" },
    WebuiAsset { path: "favicon.ico", offset: 2938727, gz_len: 509, mime: "image/x-icon" },
    WebuiAsset { path: "favicon.svg", offset: 2939236, gz_len: 429, mime: "image/svg+xml" },
    WebuiAsset { path: "index.html", offset: 2939665, gz_len: 1287, mime: "text/html; charset=utf-8" },
    WebuiAsset { path: "manifest.webmanifest", offset: 2940952, gz_len: 262, mime: "application/manifest+json" },
    WebuiAsset { path: "maskable-icon-512x512.png", offset: 2941214, gz_len: 1204, mime: "image/png" },
    WebuiAsset { path: "pwa-192x192.png", offset: 2942418, gz_len: 3754, mime: "image/png" },
    WebuiAsset { path: "pwa-512x512.png", offset: 2946172, gz_len: 12279, mime: "image/png" },
    WebuiAsset { path: "pwa-64x64.png", offset: 2958451, gz_len: 1276, mime: "image/png" },
    WebuiAsset { path: "recommended-mcp/context7.png", offset: 2959727, gz_len: 1508, mime: "image/png" },
    WebuiAsset { path: "recommended-mcp/exa.ico", offset: 2961235, gz_len: 14390, mime: "image/x-icon" },
    WebuiAsset { path: "recommended-mcp/github-dark.png", offset: 2975625, gz_len: 607, mime: "image/png" },
    WebuiAsset { path: "recommended-mcp/github-light.png", offset: 2976232, gz_len: 981, mime: "image/png" },
    WebuiAsset { path: "recommended-mcp/huggingface.ico", offset: 2977213, gz_len: 93550, mime: "image/x-icon" },
    WebuiAsset { path: "sw.js", offset: 3070763, gz_len: 2667, mime: "application/javascript; charset=utf-8" },
    WebuiAsset { path: "workbox-b3c04f83.js", offset: 3073430, gz_len: 7391, mime: "application/javascript; charset=utf-8" },
];

/// 官方 webui 里的 Service Worker：同源桥上不需要离线缓存（反而会缓存住旧页面），
/// 改为返回一个自我注销的桩。
pub const SERVICE_WORKER_STUB: &str = r#"// 由 Agent LLM 的同源桥提供：不缓存页面，注册后立即注销自己。
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    try { await self.registration.unregister(); } catch (err) {}
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  })());
});
"#;

/// 按 URL 路径查资产（精确匹配）。
pub fn find(url_path: &str) -> Option<&'static WebuiAsset> {
    let trimmed = url_path.trim_start_matches('/');
    ASSETS.iter().find(|asset| asset.path == trimmed)
}

/// 精确匹配失败时的兜底：官方 webui 的 JS/CSS/workbox 文件名带内容 hash（随版本变化），
/// 用「类型 + 位置」识别，避免内核或 webui 版本更新后 404。
pub fn find_fallback(url_path: &str) -> Option<&'static WebuiAsset> {
    let trimmed = url_path.trim_start_matches('/');
    if trimmed == "sw.js" {
        return None; // sw.js 由 SERVICE_WORKER_STUB 提供
    }
    if trimmed.ends_with(".js") {
        if trimmed.contains("workbox") {
            return ASSETS.iter().find(|asset| asset.path.contains("workbox"));
        }
        return ASSETS.iter().find(|asset| asset.path.ends_with(".js") && !asset.path.contains("workbox"));
    }
    if trimmed.ends_with(".css") {
        return ASSETS.iter().find(|asset| asset.path.ends_with(".css"));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_covers_bin_without_gaps() {
        let mut cursor = 0usize;
        for asset in ASSETS {
            assert_eq!(asset.offset, cursor, "资产 {} 偏移不连续", asset.path);
            cursor += asset.gz_len;
        }
        assert_eq!(cursor, WEBUI_BIN.len(), "清单长度与内嵌数据不一致");
    }

    #[test]
    fn every_asset_is_gzip() {
        for asset in ASSETS {
            let bytes = asset.gz_bytes();
            assert!(bytes.len() > 8, "资产 {} 太短", asset.path);
            assert_eq!(&bytes[..3], &[0x1f, 0x8b, 0x08], "资产 {} 不是 gzip 流", asset.path);
        }
    }

    #[test]
    fn find_handles_root_and_hashed_names() {
        assert_eq!(find("index.html").unwrap().mime, "text/html; charset=utf-8");
        assert!(find("/index.html").is_some());
        assert!(find("favicon.ico").is_some());
        // 版本不同的 hashed 名字走类型兜底
        let js = find_fallback("/_app/immutable/bundle.deadbeef.js").unwrap();
        assert!(js.path.ends_with(".js"));
        let css = find_fallback("/_app/immutable/assets/bundle.deadbeef.css").unwrap();
        assert_eq!(css.mime, "text/css; charset=utf-8");
    }
}