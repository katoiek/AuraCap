fn main() {
    // screencapturekit（録画用のScreenCaptureKitバインディング）が埋め込むSwiftブリッジは
    // libswift_Concurrency.dylib等のSwiftランタイムを要求するが、依存クレート側のbuild.rsが
    // 出すrustc-link-arg（rpath指定）はこの最終バイナリのリンクには伝播しない。
    // そのため同じrpathをここで明示的に追加し、"Library not loaded" クラッシュを防ぐ。
    // screencapturekit's embedded Swift bridge (used for recording) needs the Swift runtime
    // (libswift_Concurrency.dylib etc.), but rustc-link-arg (rpath) emitted by a dependency's
    // build.rs doesn't propagate to this final binary's link step. Add the same rpath here
    // explicitly to avoid a "Library not loaded" crash at launch.
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-arg-bins=-Wl,-rpath,/usr/lib/swift");
        if let Ok(output) = std::process::Command::new("xcode-select").arg("-p").output() {
            if output.status.success() {
                let xcode_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                println!(
                    "cargo:rustc-link-arg-bins=-Wl,-rpath,{xcode_path}/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx"
                );
                println!(
                    "cargo:rustc-link-arg-bins=-Wl,-rpath,{xcode_path}/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/macosx"
                );
            }
        }
    }
    tauri_build::build()
}
