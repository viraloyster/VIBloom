use std::io::Read as _;
use vibloom::cli::{Io, main as run_cli};
use vibloom::hooks::Role;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cwd = std::env::current_dir().unwrap_or_default();
    let role = Role::from_env(std::env::var("VIBLOOM_ROLE").ok().as_deref());
    let mut stdin = || {
        let mut s = String::new();
        let _ = std::io::stdin().read_to_string(&mut s);
        s
    };
    let mut out = |s: &str| println!("{s}");
    let mut err = |s: &str| eprintln!("{s}");
    let mut io = Io {
        cwd,
        role,
        stdin: &mut stdin,
        out: &mut out,
        err: &mut err,
    };
    std::process::exit(run_cli(&args, &mut io));
}
