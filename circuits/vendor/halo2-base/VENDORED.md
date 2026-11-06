# Vendored halo2-base 0.5.6

Unmodified source of [halo2-base 0.5.6](https://crates.io/crates/halo2-base/0.5.6) (Axiom, MIT), except
for its `Cargo.toml`:

- the `halo2-axiom` dependency no longer turns on halo2-axiom's default features; it asks for
  `batch` and `circuit-params` only;
- a new `multicore` feature forwards to `halo2-axiom/multicore`.

Why: `halo2-axiom`'s `multicore` feature has a `compile_error!` on wasm32 without atomics, and upstream
halo2-base always enables it, so nothing built on halo2-base can target the browser single-threaded.
`ghost-cli` turns `multicore` back on for native proving; `ghost-wasm` leaves it off.
