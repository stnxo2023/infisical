# CLAUDE.md

WASM decoder for the PAM RDP replay player. Consumed by `frontend/src/pages/pam/PamSessionsByIDPage/components/RdpReplayView/` through generated bindings in `frontend/src/lib/ironrdp-decoder/`.

## When editing this crate

After any change to `src/lib.rs` or `Cargo.toml` (including IronRDP version bumps), regenerate the bindings before committing:

```sh
cd wasm/ironrdp-decoder
wasm-pack build --target web --release --out-dir ../../frontend/src/lib/ironrdp-decoder --out-name infisical_rdp_decoder
```

The bindings under `frontend/src/lib/ironrdp-decoder/` are committed so the frontend builds without a Rust toolchain. Skipping the rebuild leaves source and bindings out of sync and the frontend keeps running the old WASM.

See [README.md](./README.md) for prerequisites and full context.
