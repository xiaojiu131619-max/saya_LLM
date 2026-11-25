fn main() {
    // cargo test 的测试二进制拿不到主 exe 那份 comctl32 v6 清单资源
    // （tauri_build 只给 bin 嵌 RT_MANIFEST），rfd 导入的 TaskDialogIndirect
    // 会在加载期绑到 System32 的 comctl32 v5.82（无此导出），
    // 测试 exe 一启动就 STATUS_ENTRYPOINT_NOT_FOUND，整个 cargo test 全废。
    //
    // delayload 把 comctl32 的绑定推迟到首次真正调用：
    // - 测试二进制从不调它 → 加载成功，测试套件恢复可跑；
    // - 主程序首次调用（打开文件对话框）时进程清单已生效（comctl32 v6 可解析），
    //   行为不变。
    println!("cargo:rustc-link-arg=/DELAYLOAD:comctl32.dll");
    println!("cargo:rustc-link-lib=dylib=delayimp");
    tauri_build::build()
}
