fn main() {
    let cfg = load_config();
    println!("hello {}", cfg);
}

fn load_config() -> &'static str {
    "default"
}
