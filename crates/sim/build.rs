//! Computes `SIM_VERSION`: a hash of this crate's source. Client and server
//! must run the exact same sim or prediction silently drifts, so the client
//! sends this in its Hello and the server refuses mismatches.
use std::fs;
use std::path::Path;

fn main() {
    println!("cargo:rerun-if-changed=src");
    let mut files = Vec::new();
    collect(Path::new("src"), &mut files);
    files.sort();
    let mut h: u32 = 0x811c_9dc5;
    for f in files {
        for b in f
            .to_string_lossy()
            .bytes()
            .chain(fs::read(&f).expect("read sim source"))
        {
            h ^= u32::from(b);
            h = h.wrapping_mul(0x0100_0193);
        }
    }
    println!("cargo:rustc-env=SIM_SOURCE_HASH={h}");
}

fn collect(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for entry in fs::read_dir(dir).expect("read sim src dir") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            collect(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}
