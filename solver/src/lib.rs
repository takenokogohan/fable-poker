//! GTO postflop solver. Pure Rust, no dependencies; exposes a plain C ABI for
//! WebAssembly (no wasm-bindgen needed). All buffers crossing the boundary are
//! length-prefixed: 4 bytes LE length followed by UTF-8 JSON.

pub mod api;
pub mod cards;
pub mod cluster;
pub mod combos;
pub mod engine;
pub mod eval;
pub mod iso;
pub mod tree;

use engine::Game;

static mut GAME: Option<Game> = None;

/// wasm is single-threaded; native callers must not use the C ABI concurrently.
#[allow(static_mut_refs)]
unsafe fn game_mut() -> &'static mut Option<Game> {
    &mut GAME
}

fn ret_buf_bytes(bytes: Vec<u8>) -> *mut u8 {
    let len = bytes.len() as u32;
    let mut out = Vec::with_capacity(4 + bytes.len());
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&bytes);
    let ptr = out.as_mut_ptr();
    std::mem::forget(out);
    ptr
}

fn ret_buf(s: String) -> *mut u8 {
    ret_buf_bytes(s.into_bytes())
}

/// # Safety
/// Caller must pass the pointer/length pair previously handed out.
#[no_mangle]
pub extern "C" fn sv_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let ptr = v.as_mut_ptr();
    std::mem::forget(v);
    ptr
}

#[no_mangle]
pub unsafe extern "C" fn sv_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

/// Free a buffer returned by sv_init/sv_run/sv_query (length-prefixed).
#[no_mangle]
pub unsafe extern "C" fn sv_free_result(ptr: *mut u8) {
    let len = u32::from_le_bytes([*ptr, *ptr.add(1), *ptr.add(2), *ptr.add(3)]) as usize;
    drop(Vec::from_raw_parts(ptr, 0, len + 4));
}

unsafe fn read_str<'a>(ptr: *const u8, len: usize) -> Result<&'a str, String> {
    let slice = std::slice::from_raw_parts(ptr, len);
    std::str::from_utf8(slice).map_err(|_| "invalid utf-8".to_string())
}

#[no_mangle]
pub unsafe extern "C" fn sv_init(ptr: *const u8, len: usize) -> *mut u8 {
    let text = match read_str(ptr, len) {
        Ok(t) => t,
        Err(e) => return ret_buf(api::error_json(&e)),
    };
    let (cfg, w0, w1) = match api::parse_config(text) {
        Ok(x) => x,
        Err(e) => return ret_buf(api::error_json(&e)),
    };
    match Game::new(cfg, &w0, &w1) {
        Ok(g) => {
            let json = api::meta_json(&g);
            *game_mut() = Some(g);
            ret_buf(json)
        }
        Err(e) => ret_buf(api::error_json(&e)),
    }
}

#[no_mangle]
pub unsafe extern "C" fn sv_run(iterations: u32) -> *mut u8 {
    match game_mut().as_mut() {
        Some(g) => {
            g.run_iterations(iterations);
            let expl = g.exploitability();
            ret_buf(api::run_json(g, expl))
        }
        None => ret_buf(api::error_json("not initialized")),
    }
}

#[no_mangle]
pub unsafe extern "C" fn sv_query(ptr: *const u8, len: usize) -> *mut u8 {
    let text = match read_str(ptr, len) {
        Ok(t) => t,
        Err(e) => return ret_buf(api::error_json(&e)),
    };
    match game_mut().as_ref() {
        Some(g) => ret_buf(api::query_json(g, text)),
        None => ret_buf(api::error_json("not initialized")),
    }
}

// ---- distributed solving ----

unsafe fn read_bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    std::slice::from_raw_parts(ptr, len)
}

/// Tasks for the workers (current-strategy reaches, no updates).
#[no_mangle]
pub unsafe extern "C" fn sv_iter_begin(traverser: u32) -> *mut u8 {
    match game_mut().as_ref() {
        Some(g) => {
            let tasks = g.iter_begin(traverser as usize);
            ret_buf_bytes(api::encode_tasks(traverser, g.current_weight(), &tasks))
        }
        None => ret_buf(api::error_json("not initialized")),
    }
}

/// Complete the starting-street updates with summed chance values.
#[no_mangle]
pub unsafe extern "C" fn sv_iter_finish(ptr: *const u8, len: usize) -> *mut u8 {
    let g = match game_mut().as_mut() {
        Some(g) => g,
        None => return ret_buf(api::error_json("not initialized")),
    };
    match api::decode_values(read_bytes(ptr, len)) {
        Ok((trav, values)) => {
            g.iter_finish(trav as usize, &values);
            ret_buf(format!(
                "{{\"ok\":true,\"iterations\":{}}}",
                g.iterations
            ))
        }
        Err(e) => ret_buf(api::error_json(&e)),
    }
}

/// Worker phase: mode 0 = CFR (with updates), 1 = best response, 2 = EV.
#[no_mangle]
pub unsafe extern "C" fn sv_subtree_run(mode: u32, ptr: *const u8, len: usize) -> *mut u8 {
    let g = match game_mut().as_mut() {
        Some(g) => g,
        None => return ret_buf(api::error_json("not initialized")),
    };
    match api::decode_tasks(read_bytes(ptr, len)) {
        Ok((trav, weight, tasks)) => {
            let results = g.subtree_run(mode, trav as usize, weight, &tasks);
            ret_buf_bytes(api::encode_values(trav, &results))
        }
        Err(e) => ret_buf(api::error_json(&e)),
    }
}

#[no_mangle]
pub unsafe extern "C" fn sv_br_begin(traverser: u32) -> *mut u8 {
    match game_mut().as_ref() {
        Some(g) => {
            let tasks = g.br_begin(traverser as usize);
            ret_buf_bytes(api::encode_tasks(traverser, 0.0, &tasks))
        }
        None => ret_buf(api::error_json("not initialized")),
    }
}

/// Returns the best-response total for the traverser encoded in the buffer.
#[no_mangle]
pub unsafe extern "C" fn sv_br_finish(ptr: *const u8, len: usize) -> *mut u8 {
    let g = match game_mut().as_ref() {
        Some(g) => g,
        None => return ret_buf(api::error_json("not initialized")),
    };
    match api::decode_values(read_bytes(ptr, len)) {
        Ok((trav, values)) => {
            let total = g.br_finish(trav as usize, &values);
            ret_buf(format!("{{\"ok\":true,\"brTotal\":{}}}", total))
        }
        Err(e) => ret_buf(api::error_json(&e)),
    }
}

#[no_mangle]
pub unsafe extern "C" fn sv_expl_info() -> *mut u8 {
    match game_mut().as_ref() {
        Some(g) => ret_buf(format!(
            "{{\"ok\":true,\"dead\":{},\"pairWeight\":{},\"pot\":{}}}",
            g.tree.dead,
            g.pair_weight(),
            g.tree.cfg.pot
        )),
        None => ret_buf(api::error_json("not initialized")),
    }
}

/// EV fan-out tasks for a starting-street action node (path as text).
#[no_mangle]
pub unsafe extern "C" fn sv_ev_begin(ptr: *const u8, len: usize) -> *mut u8 {
    let g = match game_mut().as_ref() {
        Some(g) => g,
        None => return ret_buf(api::error_json("not initialized")),
    };
    let text = match read_str(ptr, len) {
        Ok(t) => t,
        Err(e) => return ret_buf(api::error_json(&e)),
    };
    let path = match api::parse_path(text) {
        Ok(p) => p,
        Err(e) => return ret_buf(api::error_json(&e)),
    };
    // traverser = acting player at the node
    let trav = match g.walk(&path) {
        Ok(r) => match &g.tree.nodes[r.node as usize] {
            tree::Node::Action { player, .. } => *player as u32,
            _ => return ret_buf(api::error_json("ev: not an action node")),
        },
        Err(e) => return ret_buf(api::error_json(&e)),
    };
    match g.ev_begin(&path) {
        Ok(tasks) => ret_buf_bytes(api::encode_tasks(trav, 0.0, &tasks)),
        Err(e) => ret_buf(api::error_json(&e)),
    }
}

/// EV fan-out finish: input = [u32 path_len][path text][values buffer].
#[no_mangle]
pub unsafe extern "C" fn sv_ev_finish(ptr: *const u8, len: usize) -> *mut u8 {
    let g = match game_mut().as_ref() {
        Some(g) => g,
        None => return ret_buf(api::error_json("not initialized")),
    };
    let bytes = read_bytes(ptr, len);
    if bytes.len() < 4 {
        return ret_buf(api::error_json("short ev buffer"));
    }
    let plen = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
    if bytes.len() < 4 + plen {
        return ret_buf(api::error_json("truncated ev buffer"));
    }
    let path_text = match std::str::from_utf8(&bytes[4..4 + plen]) {
        Ok(t) => t,
        Err(_) => return ret_buf(api::error_json("bad path text")),
    };
    let path = match api::parse_path(path_text) {
        Ok(p) => p,
        Err(e) => return ret_buf(api::error_json(&e)),
    };
    match api::decode_values(&bytes[4 + plen..]) {
        Ok((_, values)) => ret_buf(api::ev_fanout_json(g, &path, &values)),
        Err(e) => ret_buf(api::error_json(&e)),
    }
}

/// Which worker serves queries for this path (-1 = this main instance).
#[no_mangle]
pub unsafe extern "C" fn sv_route(ptr: *const u8, len: usize) -> *mut u8 {
    let g = match game_mut().as_ref() {
        Some(g) => g,
        None => return ret_buf(api::error_json("not initialized")),
    };
    let text = match read_str(ptr, len) {
        Ok(t) => t,
        Err(e) => return ret_buf(api::error_json(&e)),
    };
    let path = match api::parse_path(text) {
        Ok(p) => p,
        Err(e) => return ret_buf(api::error_json(&e)),
    };
    let workers = match g.tree.cfg.partition {
        tree::Partition::Main { workers } => workers,
        _ => 0,
    };
    if workers == 0 {
        return ret_buf("{\"ok\":true,\"owner\":-1}".to_string());
    }
    match g.route_owner(&path, workers) {
        Ok(o) => ret_buf(format!("{{\"ok\":true,\"owner\":{}}}", o)),
        Err(e) => ret_buf(api::error_json(&e)),
    }
}

// ---- state persistence ----

#[no_mangle]
pub unsafe extern "C" fn sv_export_state() -> *mut u8 {
    match game_mut().as_ref() {
        Some(g) => ret_buf_bytes(g.export_state()),
        None => ret_buf(api::error_json("not initialized")),
    }
}

#[no_mangle]
pub unsafe extern "C" fn sv_import_state(ptr: *const u8, len: usize) -> *mut u8 {
    match game_mut().as_mut() {
        Some(g) => match g.import_state(read_bytes(ptr, len)) {
            Ok(()) => ret_buf(format!(
                "{{\"ok\":true,\"iterations\":{}}}",
                g.iterations
            )),
            Err(e) => ret_buf(api::error_json(&e)),
        },
        None => ret_buf(api::error_json("not initialized")),
    }
}

#[no_mangle]
pub unsafe extern "C" fn sv_export_street0() -> *mut u8 {
    match game_mut().as_ref() {
        Some(g) => ret_buf_bytes(g.export_street0()),
        None => ret_buf(api::error_json("not initialized")),
    }
}

#[no_mangle]
pub unsafe extern "C" fn sv_import_street0(ptr: *const u8, len: usize) -> *mut u8 {
    match game_mut().as_mut() {
        Some(g) => match g.import_street0(read_bytes(ptr, len)) {
            Ok(()) => ret_buf("{\"ok\":true}".to_string()),
            Err(e) => ret_buf(api::error_json(&e)),
        },
        None => ret_buf(api::error_json("not initialized")),
    }
}
