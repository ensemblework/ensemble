fn main() {
    if std::env::args().any(|arg| arg == "--check") {
        println!("{}", ensemble_capture_lib::chord_label(std::env::consts::OS));
        return;
    }
    ensemble_capture_lib::run();
}
