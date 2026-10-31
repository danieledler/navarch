use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Stamps the binary with the code it was built from, for the status bar (`get_build_info`).
fn main() {
    let env = |k: &str, v: &str| println!("cargo:rustc-env=NAVARCH_{k}={v}");
    env("COMMIT", &git(&["rev-parse", "--short", "HEAD"]).unwrap_or_default());
    // The release worktree is a detached checkout of main: report the branch it sits on.
    let branch = match git(&["rev-parse", "--abbrev-ref", "HEAD"]) {
        Some(b) if b != "HEAD" => b,
        _ => {
            let at = git(&["branch", "--points-at", "HEAD", "--format=%(refname:short)"]).unwrap_or_default();
            let main = at.lines().any(|b| b == "main");
            if main { "main".into() } else { at.lines().next().unwrap_or("detached").to_string() }
        }
    };
    env("BRANCH", &branch);
    env("CHECKOUT", &git(&["rev-parse", "--show-toplevel"]).unwrap_or_default());
    let dirty = git(&["status", "--porcelain", "--untracked-files=no"]).map_or(0, |s| s.lines().count());
    env("DIRTY", &dirty.to_string());
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    env("BUILT_AT", &now.to_string());
    // Re-stamp on source edits, commits, checkouts and staging (worktrees keep their own HEAD log and index).
    println!("cargo:rerun-if-changed=src");
    for p in ["logs/HEAD", "index"] {
        if let Some(path) = git(&["rev-parse", "--path-format=absolute", "--git-path", p]) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
    // Release builds embed the phone UI (http.rs): rebuild when it changes. Debug builds read it from disk.
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        println!("cargo:rerun-if-changed=../../mobile/dist");
    }
    tauri_build::build()
}
