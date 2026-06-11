//! Text config parsing and JSON serialization for the JS boundary.

use crate::cards::{card_to_string, parse_board};
use crate::combos::expand_grid_weights;
use crate::engine::{average_strategy, Game};
use crate::tree::{Node, TreeConfig};

pub struct JsonBuf {
    s: String,
}

impl JsonBuf {
    pub fn new() -> Self {
        JsonBuf {
            s: String::with_capacity(4096),
        }
    }
    pub fn raw(&mut self, t: &str) -> &mut Self {
        self.s.push_str(t);
        self
    }
    pub fn string(&mut self, v: &str) -> &mut Self {
        self.s.push('"');
        for c in v.chars() {
            match c {
                '"' => self.s.push_str("\\\""),
                '\\' => self.s.push_str("\\\\"),
                '\n' => self.s.push_str("\\n"),
                c if (c as u32) < 0x20 => {
                    self.s.push_str(&format!("\\u{:04x}", c as u32));
                }
                c => self.s.push(c),
            }
        }
        self.s.push('"');
        self
    }
    pub fn num(&mut self, v: f64) -> &mut Self {
        if v.is_finite() {
            // 4 decimal places, trimmed
            let t = format!("{:.4}", v);
            let t = t.trim_end_matches('0').trim_end_matches('.');
            self.s.push_str(if t.is_empty() || t == "-" { "0" } else { t });
        } else {
            self.s.push('0');
        }
        self
    }
    pub fn int(&mut self, v: i64) -> &mut Self {
        self.s.push_str(&v.to_string());
        self
    }
    pub fn floats(&mut self, vals: impl Iterator<Item = f32>) -> &mut Self {
        self.s.push('[');
        let mut first = true;
        for v in vals {
            if !first {
                self.s.push(',');
            }
            first = false;
            self.num(v as f64);
        }
        self.s.push(']');
        self
    }
    pub fn finish(self) -> String {
        self.s
    }
}

pub fn error_json(msg: &str) -> String {
    let mut j = JsonBuf::new();
    j.raw("{\"ok\":false,\"error\":");
    j.string(msg);
    j.raw("}");
    j.finish()
}

/// Parse the line-based `key=value` config.
pub fn parse_config(text: &str) -> Result<(TreeConfig, Vec<f32>, Vec<f32>), String> {
    let mut board = None;
    let mut pot = 0f32;
    let mut stack = 0f32;
    let mut bet_sizes: [Vec<f32>; 3] = [vec![], vec![], vec![]];
    let mut raise_sizes: [Vec<f32>; 3] = [vec![], vec![], vec![]];
    let mut max_bets = 3u8;
    let mut allin_threshold = 0f32;
    let mut partition_kind = "none".to_string();
    let mut workers = 0u8;
    let mut worker_idx = 0u8;
    let mut grid0 = [0f32; 169];
    let mut grid1 = [0f32; 169];
    let mut got0 = false;
    let mut got1 = false;

    let parse_floats = |v: &str| -> Result<Vec<f32>, String> {
        v.split(',')
            .filter(|t| !t.trim().is_empty())
            .map(|t| t.trim().parse::<f32>().map_err(|_| format!("bad number: {}", t)))
            .collect()
    };

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (k, v) = line.split_once('=').ok_or_else(|| format!("bad line: {}", line))?;
        let (k, v) = (k.trim(), v.trim());
        match k {
            "board" => board = Some(parse_board(v).ok_or("bad board")?),
            "pot" => pot = v.parse().map_err(|_| "bad pot")?,
            "stack" => stack = v.parse().map_err(|_| "bad stack")?,
            "bets_flop" => bet_sizes[0] = parse_floats(v)?.iter().map(|x| x / 100.0).collect(),
            "bets_turn" => bet_sizes[1] = parse_floats(v)?.iter().map(|x| x / 100.0).collect(),
            "bets_river" => bet_sizes[2] = parse_floats(v)?.iter().map(|x| x / 100.0).collect(),
            "raises_flop" => raise_sizes[0] = parse_floats(v)?.iter().map(|x| x / 100.0).collect(),
            "raises_turn" => raise_sizes[1] = parse_floats(v)?.iter().map(|x| x / 100.0).collect(),
            "raises_river" => raise_sizes[2] = parse_floats(v)?.iter().map(|x| x / 100.0).collect(),
            "max_bets" => max_bets = v.parse().map_err(|_| "bad max_bets")?,
            "allin_threshold" => allin_threshold = v.parse().map_err(|_| "bad allin_threshold")?,
            "partition" => partition_kind = v.to_string(),
            "workers" => workers = v.parse().map_err(|_| "bad workers")?,
            "worker_idx" => worker_idx = v.parse().map_err(|_| "bad worker_idx")?,
            "range_oop" => {
                let f = parse_floats(v)?;
                if f.len() != 169 {
                    return Err(format!("range_oop needs 169 values, got {}", f.len()));
                }
                grid0.copy_from_slice(&f);
                got0 = true;
            }
            "range_ip" => {
                let f = parse_floats(v)?;
                if f.len() != 169 {
                    return Err(format!("range_ip needs 169 values, got {}", f.len()));
                }
                grid1.copy_from_slice(&f);
                got1 = true;
            }
            _ => return Err(format!("unknown key: {}", k)),
        }
    }
    let board = board.ok_or("missing board")?;
    if !(3..=5).contains(&board.len()) {
        return Err("board must have 3-5 cards".into());
    }
    if !got0 || !got1 {
        return Err("missing ranges".into());
    }
    if pot <= 0.0 || stack <= 0.0 {
        return Err("pot and stack must be positive".into());
    }
    let partition = match partition_kind.as_str() {
        "none" => crate::tree::Partition::None,
        // river spots have no chance nodes to partition over
        _ if board.len() >= 5 => crate::tree::Partition::None,
        "main" => crate::tree::Partition::Main { workers },
        "worker" => crate::tree::Partition::Worker {
            workers,
            idx: worker_idx,
        },
        _ => return Err(format!("unknown partition: {}", partition_kind)),
    };
    let w0 = expand_grid_weights(&grid0, &board);
    let w1 = expand_grid_weights(&grid1, &board);
    let cfg = TreeConfig {
        board,
        pot,
        stack,
        bet_sizes,
        raise_sizes,
        max_bets,
        allin_threshold,
        partition,
    };
    Ok((cfg, w0, w1))
}

pub fn meta_json(g: &Game) -> String {
    let mut j = JsonBuf::new();
    j.raw("{\"ok\":true");
    for p in 0..2 {
        j.raw(&format!(",\"hands{}\":[", p));
        for (i, &(c1, c2)) in g.hands[p].cards.iter().enumerate() {
            if i > 0 {
                j.raw(",");
            }
            j.string(&format!("{}{}", card_to_string(c1), card_to_string(c2)));
        }
        j.raw("]");
        j.raw(&format!(",\"grid{}\":[", p));
        for (i, &(c1, c2)) in g.hands[p].cards.iter().enumerate() {
            if i > 0 {
                j.raw(",");
            }
            j.int(crate::combos::grid_index(c1, c2) as i64);
        }
        j.raw("]");
        j.raw(&format!(",\"weights{}\":", p));
        j.floats(g.hands[p].weights.iter().copied());
    }
    let storage_bytes = (g.tree.store_len[0] + g.tree.store_len[1]) * 4;
    j.raw(",\"actionNodes\":").int(g.tree.num_action_nodes as i64);
    j.raw(",\"storageMB\":").num(storage_bytes as f64 / 1e6);
    j.raw(",\"board\":").string(
        &g.tree
            .cfg
            .board
            .iter()
            .map(|&c| card_to_string(c))
            .collect::<String>(),
    );
    j.raw(",\"pot\":").num(g.tree.cfg.pot as f64);
    j.raw(",\"stack\":").num(g.tree.cfg.stack as f64);
    j.raw("}");
    j.finish()
}

pub fn run_json(g: &Game, expl: f32) -> String {
    let mut j = JsonBuf::new();
    j.raw("{\"ok\":true,\"iterations\":")
        .int(g.iterations as i64)
        .raw(",\"exploitability\":")
        .num(expl as f64)
        .raw(",\"exploitabilityPctPot\":")
        .num((expl / g.tree.cfg.pot * 100.0) as f64)
        .raw("}");
    j.finish()
}

/// Query a node. `path_text` = "0,1,8|ev,eq" (path steps | flags).
pub fn query_json(g: &Game, path_text: &str) -> String {
    let (path_part, flags_part) = match path_text.split_once('|') {
        Some((a, b)) => (a, b),
        None => (path_text, ""),
    };
    let path: Result<Vec<u32>, _> = path_part
        .split(',')
        .filter(|t| !t.trim().is_empty())
        .map(|t| t.trim().parse::<u32>())
        .collect();
    let path = match path {
        Ok(p) => p,
        Err(_) => return error_json("bad path"),
    };
    let want_ev = flags_part.contains("ev");
    let want_eq = flags_part.contains("eq");

    let res = match g.walk(&path) {
        Ok(r) => r,
        Err(e) => return error_json(&e),
    };
    let maps = [g.hand_remap(0, &res.perm), g.hand_remap(1, &res.perm)];

    let mut j = JsonBuf::new();
    j.raw("{\"ok\":true");
    j.raw(",\"board\":").string(
        &res.board
            .iter()
            .map(|&c| card_to_string(c))
            .collect::<String>(),
    );
    // reaches in actual frame; hands blocked in the actual world map to MAX -> 0
    let lookup = |arr: &[f32], m: u16| -> f32 {
        if m == u16::MAX {
            0.0
        } else {
            arr[m as usize]
        }
    };
    for p in 0..2 {
        j.raw(&format!(",\"reach{}\":", p));
        j.floats((0..g.hands[p].len()).map(|h| lookup(&res.reach[p], maps[p][h])));
    }
    if want_eq {
        for p in 0..2 {
            let eq = g.equity(&res.canon_board, p, &res.reach[1 - p]);
            j.raw(&format!(",\"equity{}\":", p));
            j.floats((0..g.hands[p].len()).map(|h| lookup(&eq, maps[p][h])));
        }
    }

    match &g.tree.nodes[res.node as usize] {
        Node::Action {
            player,
            street,
            pot,
            to_call,
            actions,
            store_off,
            ..
        } => {
            let p = *player as usize;
            let na = actions.len();
            let nh = g.hands[p].len();
            j.raw(",\"type\":\"action\"");
            j.raw(",\"player\":").int(p as i64);
            j.raw(",\"street\":").int(*street as i64);
            j.raw(",\"pot\":").num(*pot as f64);
            j.raw(",\"toCall\":").num(*to_call as f64);
            j.raw(",\"actions\":[");
            for (i, a) in actions.iter().enumerate() {
                if i > 0 {
                    j.raw(",");
                }
                j.raw("{\"kind\":")
                    .int(a.kind as i64)
                    .raw(",\"chips\":")
                    .num(a.chips as f64)
                    .raw("}");
            }
            j.raw("]");
            let strat = average_strategy(
                &g.store.strat_sum[p][*store_off..*store_off + na * nh],
                na,
                nh,
            );
            j.raw(",\"strategy\":");
            j.floats((0..na).flat_map(|a| {
                let strat = &strat;
                let maps = &maps;
                (0..nh).map(move |h| {
                    let m = maps[p][h];
                    if m == u16::MAX {
                        0.0
                    } else {
                        strat[a * nh + m as usize]
                    }
                })
            }));
            if want_ev {
                let (evs, compat) = g.action_evs(res.node, &res.reach[1 - p]);
                // GTO Wizard convention: EV from this decision point, with the
                // hero's own prior commitments treated as sunk (fold = 0 EV).
                // Raw utilities are anchored at the spot start, so add back
                // what the hero already put in along the path.
                let sunk = res.adds[p];
                j.raw(",\"evs\":");
                j.floats((0..na).flat_map(|a| {
                    let evs = &evs;
                    let compat = &compat;
                    let maps = &maps;
                    (0..nh).map(move |h| {
                        let m = maps[p][h];
                        if m == u16::MAX {
                            return 0.0;
                        }
                        let hc = m as usize;
                        if compat[hc] > 1e-9 {
                            evs[a][hc] / compat[hc] + sunk
                        } else {
                            0.0
                        }
                    })
                }));
            }
        }
        Node::Chance { children, .. } => {
            j.raw(",\"type\":\"chance\"");
            // dealable actual cards: anything not on the actual board
            let mut used = [false; 52];
            for &c in &res.board {
                used[c as usize] = true;
            }
            j.raw(",\"cards\":[");
            let mut first = true;
            for c in 0..52u8 {
                if !used[c as usize] {
                    if !first {
                        j.raw(",");
                    }
                    first = false;
                    j.int(c as i64);
                }
            }
            j.raw("]");
            let _ = children;
        }
        Node::Fold { folder, folder_add } => {
            j.raw(",\"type\":\"terminal\",\"terminal\":\"fold\"");
            j.raw(",\"folder\":").int(*folder as i64);
            j.raw(",\"pot\":")
                .num((g.tree.dead + 2.0 * folder_add) as f64);
        }
        Node::Showdown { contrib, .. } => {
            j.raw(",\"type\":\"terminal\",\"terminal\":\"showdown\"");
            j.raw(",\"pot\":").num((g.tree.dead + 2.0 * contrib) as f64);
        }
    }
    j.raw("}");
    j.finish()
}

// ---- binary task/value serialization for distributed solving ----

pub fn parse_path(text: &str) -> Result<Vec<u32>, String> {
    text.split(',')
        .filter(|t| !t.trim().is_empty())
        .map(|t| t.trim().parse::<u32>().map_err(|_| "bad path".to_string()))
        .collect()
}

fn push_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn push_f32(out: &mut Vec<u8>, v: f32) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn rd_u32(b: &[u8], o: &mut usize) -> u32 {
    let v = u32::from_le_bytes(b[*o..*o + 4].try_into().unwrap());
    *o += 4;
    v
}
fn rd_f32(b: &[u8], o: &mut usize) -> f32 {
    let v = f32::from_le_bytes(b[*o..*o + 4].try_into().unwrap());
    *o += 4;
    v
}
fn rd_f32s(b: &[u8], o: &mut usize, n: usize) -> Vec<f32> {
    let mut v = Vec::with_capacity(n);
    for _ in 0..n {
        v.push(rd_f32(b, o));
    }
    v
}

/// [trav][weight][n][(id, nh_my, my.., nh_opp, opp..)*]
pub fn encode_tasks(trav: u32, weight: f32, tasks: &[crate::cluster::Task]) -> Vec<u8> {
    let mut out = Vec::new();
    push_u32(&mut out, trav);
    push_f32(&mut out, weight);
    push_u32(&mut out, tasks.len() as u32);
    for t in tasks {
        push_u32(&mut out, t.node_id);
        push_u32(&mut out, t.my.len() as u32);
        for &v in &t.my {
            push_f32(&mut out, v);
        }
        push_u32(&mut out, t.opp.len() as u32);
        for &v in &t.opp {
            push_f32(&mut out, v);
        }
    }
    out
}

pub fn decode_tasks(b: &[u8]) -> Result<(u32, f32, Vec<crate::cluster::Task>), String> {
    if b.len() < 12 {
        return Err("short task buffer".into());
    }
    let mut o = 0;
    let trav = rd_u32(b, &mut o);
    let weight = rd_f32(b, &mut o);
    let n = rd_u32(b, &mut o) as usize;
    let mut tasks = Vec::with_capacity(n);
    for _ in 0..n {
        if b.len() < o + 8 {
            return Err("truncated task buffer".into());
        }
        let node_id = rd_u32(b, &mut o);
        let nm = rd_u32(b, &mut o) as usize;
        let my = rd_f32s(b, &mut o, nm);
        let no = rd_u32(b, &mut o) as usize;
        let opp = rd_f32s(b, &mut o, no);
        tasks.push(crate::cluster::Task {
            node_id,
            my,
            opp,
        });
    }
    Ok((trav, weight, tasks))
}

/// [trav][n][(id, nh, vals..)*]
pub fn encode_values(trav: u32, values: &[(u32, Vec<f32>)]) -> Vec<u8> {
    let mut out = Vec::new();
    push_u32(&mut out, trav);
    push_u32(&mut out, values.len() as u32);
    for (id, v) in values {
        push_u32(&mut out, *id);
        push_u32(&mut out, v.len() as u32);
        for &x in v {
            push_f32(&mut out, x);
        }
    }
    out
}

pub fn decode_values(b: &[u8]) -> Result<(u32, crate::cluster::ChanceValues), String> {
    if b.len() < 8 {
        return Err("short values buffer".into());
    }
    let mut o = 0;
    let trav = rd_u32(b, &mut o);
    let n = rd_u32(b, &mut o) as usize;
    let mut map = crate::cluster::ChanceValues::new();
    for _ in 0..n {
        let id = rd_u32(b, &mut o);
        let len = rd_u32(b, &mut o) as usize;
        map.insert(id, rd_f32s(b, &mut o, len));
    }
    Ok((trav, map))
}

/// EVs at a starting-street node (fan-out finish), GTO Wizard convention.
pub fn ev_fanout_json(g: &Game, path: &[u32], values: &crate::cluster::ChanceValues) -> String {
    match g.ev_finish(path, values) {
        Ok((evs, compat, sunk)) => {
            let nh = compat.len();
            let mut j = JsonBuf::new();
            j.raw("{\"ok\":true,\"evs\":");
            j.floats((0..evs.len()).flat_map(|a| {
                let evs = &evs;
                let compat = &compat;
                (0..nh).map(move |h| {
                    if compat[h] > 1e-9 {
                        evs[a][h] / compat[h] + sunk
                    } else {
                        0.0
                    }
                })
            }));
            j.raw("}");
            j.finish()
        }
        Err(e) => error_json(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_config() -> String {
        let range: Vec<String> = (0..169).map(|_| "1".to_string()).collect();
        format!(
            "board=AhKd2c7s9d\npot=10\nstack=95\nbets_flop=66\nbets_turn=75\nbets_river=75\nraises_flop=60\nraises_turn=60\nraises_river=60\nmax_bets=2\nallin_threshold=0\nrange_oop={}\nrange_ip={}",
            range.join(","),
            range.join(",")
        )
    }

    #[test]
    fn config_roundtrip() {
        let (cfg, w0, w1) = parse_config(&sample_config()).unwrap();
        assert_eq!(cfg.board.len(), 5);
        assert!(w0.iter().sum::<f32>() > 0.0);
        assert!(w1.iter().sum::<f32>() > 0.0);
        assert_eq!(cfg.bet_sizes[0], vec![0.66]);
    }

    #[test]
    fn query_works() {
        let (cfg, w0, w1) = parse_config(&sample_config()).unwrap();
        let mut g = Game::new(cfg, &w0, &w1).unwrap();
        g.run_iterations(5);
        let meta = meta_json(&g);
        assert!(meta.contains("\"ok\":true"));
        let q = query_json(&g, "|ev,eq");
        assert!(q.contains("\"type\":\"action\""), "{}", &q[..200.min(q.len())]);
        assert!(q.contains("\"strategy\""));
        assert!(q.contains("\"evs\""));
        assert!(q.contains("\"equity0\""));
        // walk into the bet branch
        let q2 = query_json(&g, "1");
        assert!(q2.contains("\"toCall\""));
        // bad path errors cleanly
        let q3 = query_json(&g, "99");
        assert!(q3.contains("\"ok\":false"));
    }
}
