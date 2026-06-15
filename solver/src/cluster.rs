//! Distributed solving: the tree is partitioned at the first-level chance
//! nodes (turn cards for a flop spot). A "main" instance owns the starting
//! street; "worker" instances own disjoint sets of subtrees. One iteration is
//! a fork-join:
//!
//! 1. main `iter_begin`: walk the starting street with current strategies,
//!    emit (chance node, reach pair) tasks — no updates yet
//! 2. each worker `subtree_run`: full CFR on its owned subtrees (with regret
//!    updates), returning orbit-accumulated partial value vectors
//! 3. main `iter_finish`: re-walk with the summed chance values and complete
//!    the starting-street regret/strategy updates
//!
//! Best-response and EV queries use the same three phases without updates.
//! All instances build the identical tree, so node ids are shared.

use crate::engine::{
    best_response, cfr, chance_accumulate, compat_sums, ev_walk, fold_values, hand_conflicts,
    normalize_into, showdown_values, Ctx, Game, Q,
};
use crate::tree::{Node, UNOWNED};
use std::collections::HashMap;

pub struct Task {
    pub node_id: u32,
    /// traverser reach (empty for br/ev tasks)
    pub my: Vec<f32>,
    pub opp: Vec<f32>,
}

pub const MODE_CFR: u32 = 0;
pub const MODE_BR: u32 = 1;
pub const MODE_EV: u32 = 2;

/// Collect (chance node, reaches) tasks from the starting street.
/// `current`: scale reaches by the current (regret-matching) strategy;
/// otherwise by the average strategy. In avg mode `my` is not tracked.
fn collect(
    ctx: &Ctx,
    store: &crate::engine::Store,
    node: u32,
    trav: usize,
    my: &[f32],
    opp: &[f32],
    current: bool,
    out: &mut Vec<Task>,
) {
    match &ctx.tree.nodes[node as usize] {
        Node::Fold { .. } | Node::Showdown { .. } => {}
        Node::Chance { .. } => {
            out.push(Task {
                node_id: node,
                my: my.to_vec(),
                opp: opp.to_vec(),
            });
        }
        Node::Action {
            player,
            actions,
            children,
            store_off,
            ..
        } => {
            let p = *player as usize;
            let na = actions.len();
            let nh = ctx.hands[p].len();
            assert!(*store_off != UNOWNED, "collect crossed into unowned node");
            let raw = if current {
                &store.regrets[p][*store_off..*store_off + na * nh]
            } else {
                &store.strat_sum[p][*store_off..*store_off + na * nh]
            };
            let mut strat = vec![0f32; na * nh];
            normalize_into(raw, na, nh, &mut strat);
            for (a, &child) in children.iter().enumerate() {
                if p == trav {
                    if current {
                        let mut c_my = vec![0f32; nh];
                        for h in 0..nh {
                            c_my[h] = my[h] * strat[a * nh + h];
                        }
                        collect(ctx, store, child, trav, &c_my, opp, current, out);
                    } else {
                        collect(ctx, store, child, trav, my, opp, current, out);
                    }
                } else {
                    let mut c_opp = vec![0f32; nh];
                    for o in 0..nh {
                        c_opp[o] = opp[o] * strat[a * nh + o];
                    }
                    collect(ctx, store, child, trav, my, &c_opp, current, out);
                }
            }
        }
    }
}

/// Provided chance values: node_id -> summed pre-norm partials for traverser.
pub type ChanceValues = HashMap<u32, Vec<f32>>;

fn provided(ctx: &Ctx, values: &ChanceValues, node: u32, norm: f32, nh: usize) -> Vec<f32> {
    let v = values
        .get(&node)
        .unwrap_or_else(|| panic!("missing chance values for node {}", node));
    let mut out = ctx.pool.get(nh);
    for h in 0..nh {
        out[h] = v[h] * norm;
    }
    out
}

/// Starting-street CFR with chance values provided (the finish phase).
fn s0_cfr(
    ctx: &Ctx,
    store: &mut crate::engine::Store,
    node: u32,
    trav: usize,
    my_reach: &[f32],
    opp_reach: &[f32],
    weight: f32,
    values: &ChanceValues,
) -> Vec<f32> {
    match &ctx.tree.nodes[node as usize] {
        Node::Fold { folder, folder_add } => fold_values(ctx, trav, *folder, *folder_add, opp_reach),
        Node::Showdown { contrib, river_idx } => {
            showdown_values(ctx, *river_idx, trav, opp_reach, *contrib)
        }
        Node::Chance { norm, .. } => provided(ctx, values, node, *norm, ctx.hands[trav].len()),
        Node::Action {
            player,
            actions,
            children,
            store_off,
            scale_idx,
            ..
        } => {
            let p = *player as usize;
            let na = actions.len();
            let si = *scale_idx as usize;
            if p == trav {
                let nh = ctx.hands[p].len();
                let mut strat = ctx.pool.get(na * nh);
                normalize_into(
                    &store.regrets[p][*store_off..*store_off + na * nh],
                    na,
                    nh,
                    &mut strat,
                );
                let mut vals: Vec<Vec<f32>> = Vec::with_capacity(na);
                for (a, &child) in children.iter().enumerate() {
                    let mut c_my = ctx.pool.get(nh);
                    for h in 0..nh {
                        c_my[h] = my_reach[h] * strat[a * nh + h];
                    }
                    vals.push(s0_cfr(ctx, store, child, trav, &c_my, opp_reach, weight, values));
                    ctx.pool.put(c_my);
                }
                let mut v = ctx.pool.get(nh);
                for a in 0..na {
                    let va = &vals[a];
                    for h in 0..nh {
                        v[h] += strat[a * nh + h] * va[h];
                    }
                }
                {
                    let k = store.reg_scale[si] / Q;
                    let mut buf = ctx.pool.get(na * nh);
                    let reg = &mut store.regrets[p][*store_off..*store_off + na * nh];
                    let mut new_max = 0f32;
                    for a in 0..na {
                        let va = &vals[a];
                        for h in 0..nh {
                            let i = a * nh + h;
                            let r = reg[i] as f32 * k + va[h] - v[h];
                            let r = if r > 0.0 { r } else { 0.0 };
                            buf[i] = r;
                            if r > new_max {
                                new_max = r;
                            }
                        }
                    }
                    if new_max > 0.0 {
                        let enc = Q / new_max;
                        for i in 0..na * nh {
                            reg[i] = (buf[i] * enc) as u16;
                        }
                    } else {
                        reg.fill(0);
                    }
                    store.reg_scale[si] = new_max;
                    ctx.pool.put(buf);
                }
                {
                    let k = store.ss_scale[si] / Q;
                    let mut buf = ctx.pool.get(na * nh);
                    let ss = &mut store.strat_sum[p][*store_off..*store_off + na * nh];
                    let mut new_max = 0f32;
                    for a in 0..na {
                        for h in 0..nh {
                            let i = a * nh + h;
                            let s = ss[i] as f32 * k + weight * my_reach[h] * strat[i];
                            buf[i] = s;
                            if s > new_max {
                                new_max = s;
                            }
                        }
                    }
                    if new_max > 0.0 {
                        let enc = Q / new_max;
                        for i in 0..na * nh {
                            ss[i] = (buf[i] * enc) as u16;
                        }
                    } else {
                        ss.fill(0);
                    }
                    store.ss_scale[si] = new_max;
                    ctx.pool.put(buf);
                }
                for va in vals {
                    ctx.pool.put(va);
                }
                ctx.pool.put(strat);
                v
            } else {
                let nh_opp = ctx.hands[p].len();
                let nh = ctx.hands[trav].len();
                let mut strat = ctx.pool.get(na * nh_opp);
                normalize_into(
                    &store.regrets[p][*store_off..*store_off + na * nh_opp],
                    na,
                    nh_opp,
                    &mut strat,
                );
                let mut v = ctx.pool.get(nh);
                for (a, &child) in children.iter().enumerate() {
                    let mut c_opp = ctx.pool.get(nh_opp);
                    for o in 0..nh_opp {
                        c_opp[o] = opp_reach[o] * strat[a * nh_opp + o];
                    }
                    let va = s0_cfr(ctx, store, child, trav, my_reach, &c_opp, weight, values);
                    for h in 0..nh {
                        v[h] += va[h];
                    }
                    ctx.pool.put(va);
                    ctx.pool.put(c_opp);
                }
                ctx.pool.put(strat);
                v
            }
        }
    }
}

/// Starting-street best response with chance values provided.
fn s0_br(
    ctx: &Ctx,
    store: &crate::engine::Store,
    node: u32,
    trav: usize,
    opp_reach: &[f32],
    values: &ChanceValues,
) -> Vec<f32> {
    match &ctx.tree.nodes[node as usize] {
        Node::Fold { folder, folder_add } => fold_values(ctx, trav, *folder, *folder_add, opp_reach),
        Node::Showdown { contrib, river_idx } => {
            showdown_values(ctx, *river_idx, trav, opp_reach, *contrib)
        }
        Node::Chance { norm, .. } => provided(ctx, values, node, *norm, ctx.hands[trav].len()),
        Node::Action {
            player,
            actions,
            children,
            store_off,
            ..
        } => {
            let p = *player as usize;
            let na = actions.len();
            if p == trav {
                let nh = ctx.hands[p].len();
                let mut v = ctx.pool.get(nh);
                v.iter_mut().for_each(|x| *x = f32::NEG_INFINITY);
                for &child in children.iter() {
                    let va = s0_br(ctx, store, child, trav, opp_reach, values);
                    for h in 0..nh {
                        if va[h] > v[h] {
                            v[h] = va[h];
                        }
                    }
                    ctx.pool.put(va);
                }
                v
            } else {
                let nh_opp = ctx.hands[p].len();
                let nh = ctx.hands[trav].len();
                let mut strat = ctx.pool.get(na * nh_opp);
                normalize_into(
                    &store.strat_sum[p][*store_off..*store_off + na * nh_opp],
                    na,
                    nh_opp,
                    &mut strat,
                );
                let mut v = ctx.pool.get(nh);
                for (a, &child) in children.iter().enumerate() {
                    let mut c_opp = ctx.pool.get(nh_opp);
                    for o in 0..nh_opp {
                        c_opp[o] = opp_reach[o] * strat[a * nh_opp + o];
                    }
                    let va = s0_br(ctx, store, child, trav, &c_opp, values);
                    for h in 0..nh {
                        v[h] += va[h];
                    }
                    ctx.pool.put(va);
                    ctx.pool.put(c_opp);
                }
                ctx.pool.put(strat);
                v
            }
        }
    }
}

/// Starting-street expectimax under the average profile with chance values.
fn s0_ev(
    ctx: &Ctx,
    store: &crate::engine::Store,
    node: u32,
    trav: usize,
    opp_reach: &[f32],
    values: &ChanceValues,
) -> Vec<f32> {
    match &ctx.tree.nodes[node as usize] {
        Node::Fold { folder, folder_add } => fold_values(ctx, trav, *folder, *folder_add, opp_reach),
        Node::Showdown { contrib, river_idx } => {
            showdown_values(ctx, *river_idx, trav, opp_reach, *contrib)
        }
        Node::Chance { norm, .. } => provided(ctx, values, node, *norm, ctx.hands[trav].len()),
        Node::Action {
            player,
            actions,
            children,
            store_off,
            ..
        } => {
            let p = *player as usize;
            let na = actions.len();
            let nh_p = ctx.hands[p].len();
            let mut strat = ctx.pool.get(na * nh_p);
            normalize_into(
                &store.strat_sum[p][*store_off..*store_off + na * nh_p],
                na,
                nh_p,
                &mut strat,
            );
            let out = if p == trav {
                let mut v = ctx.pool.get(nh_p);
                for (a, &child) in children.iter().enumerate() {
                    let va = s0_ev(ctx, store, child, trav, opp_reach, values);
                    for h in 0..nh_p {
                        v[h] += strat[a * nh_p + h] * va[h];
                    }
                    ctx.pool.put(va);
                }
                v
            } else {
                let nh = ctx.hands[trav].len();
                let mut v = ctx.pool.get(nh);
                for (a, &child) in children.iter().enumerate() {
                    let mut c_opp = ctx.pool.get(nh_p);
                    for o in 0..nh_p {
                        c_opp[o] = opp_reach[o] * strat[a * nh_p + o];
                    }
                    let va = s0_ev(ctx, store, child, trav, &c_opp, values);
                    for h in 0..nh {
                        v[h] += va[h];
                    }
                    ctx.pool.put(va);
                    ctx.pool.put(c_opp);
                }
                v
            };
            ctx.pool.put(strat);
            out
        }
    }
}

impl Game {
    /// Phase 1 of a distributed iteration: tasks for the workers.
    pub fn iter_begin(&self, trav: usize) -> Vec<Task> {
        let ctx = self.ctx();
        let mut out = Vec::new();
        collect(
            &ctx,
            &self.store,
            self.tree.root,
            trav,
            &self.hands[trav].weights.clone(),
            &self.hands[1 - trav].weights.clone(),
            true,
            &mut out,
        );
        out
    }

    /// Phase 3: complete the starting-street updates with summed values.
    pub fn iter_finish(&mut self, trav: usize, values: &ChanceValues) {
        let weight = (self.iterations + 1) as f32;
        let my = self.hands[trav].weights.clone();
        let opp = self.hands[1 - trav].weights.clone();
        let ctx = Ctx {
            tree: &self.tree,
            hands: &self.hands,
            same_combo: &self.same_combo,
            river_infos: &self.river_infos,
            perm_maps: &self.perm_maps,
            dead: self.tree.dead,
            pool: &self.pool,
        };
        let v = s0_cfr(
            &ctx,
            &mut self.store,
            self.tree.root,
            trav,
            &my,
            &opp,
            weight,
            values,
        );
        self.pool.put(v);
        if trav == 1 {
            self.iterations += 1;
        }
    }

    /// The iteration weight workers must use for the current iteration.
    pub fn current_weight(&self) -> f32 {
        (self.iterations + 1) as f32
    }

    /// Worker phase: run owned subtrees for each task, returning
    /// orbit-accumulated pre-norm partial values per chance node.
    pub fn subtree_run(
        &mut self,
        mode: u32,
        trav: usize,
        weight: f32,
        tasks: &[Task],
    ) -> Vec<(u32, Vec<f32>)> {
        let nh = self.hands[trav].len();
        let nh_opp = self.hands[1 - trav].len();
        let mut results = Vec::with_capacity(tasks.len());
        for task in tasks {
            let mut out = vec![0f32; nh];
            // children list copied to satisfy the borrow checker (cfr needs &mut store)
            let children: Vec<(u32, crate::cards::Card)> =
                match &self.tree.nodes[task.node_id as usize] {
                    Node::Chance { children, .. } => children
                        .iter()
                        .enumerate()
                        .filter(|(_, cc)| self.tree.cfg.partition.owns_subtree(cc.rep))
                        .map(|(i, cc)| (i as u32, cc.rep))
                        .collect(),
                    _ => panic!("task node is not a chance node"),
                };
            for (child_i, rep) in children {
                let mut c_my = task.my.clone();
                for h in 0..c_my.len() {
                    if hand_conflicts(&self.hands[trav], h, rep) {
                        c_my[h] = 0.0;
                    }
                }
                let mut c_opp = task.opp.clone();
                for o in 0..nh_opp {
                    if hand_conflicts(&self.hands[1 - trav], o, rep) {
                        c_opp[o] = 0.0;
                    }
                }
                let child_node = match &self.tree.nodes[task.node_id as usize] {
                    Node::Chance { children, .. } => children[child_i as usize].child,
                    _ => unreachable!(),
                };
                let ctx = Ctx {
                    tree: &self.tree,
                    hands: &self.hands,
                    same_combo: &self.same_combo,
                    river_infos: &self.river_infos,
                    perm_maps: &self.perm_maps,
                    dead: self.tree.dead,
                    pool: &self.pool,
                };
                let v = match mode {
                    MODE_CFR => cfr(&ctx, &mut self.store, child_node, trav, &c_my, &c_opp, weight),
                    MODE_BR => best_response(&ctx, &self.store, child_node, trav, &c_opp),
                    MODE_EV => ev_walk(&ctx, &self.store, child_node, trav, &c_opp),
                    _ => panic!("bad mode"),
                };
                let orbit: Vec<(crate::cards::Card, [u8; 4])> =
                    match &self.tree.nodes[task.node_id as usize] {
                        Node::Chance { children, .. } => children[child_i as usize].orbit.clone(),
                        _ => unreachable!(),
                    };
                let ctx2 = self.ctx();
                for (card, perm) in &orbit {
                    chance_accumulate(&ctx2, trav, &mut out, &v, *card, perm);
                }
                self.pool.put(v);
            }
            results.push((task.node_id, out));
        }
        results
    }

    /// BR phase 1: tasks (avg-strategy opp reaches).
    pub fn br_begin(&self, trav: usize) -> Vec<Task> {
        let ctx = self.ctx();
        let mut out = Vec::new();
        collect(
            &ctx,
            &self.store,
            self.tree.root,
            trav,
            &[],
            &self.hands[1 - trav].weights.clone(),
            false,
            &mut out,
        );
        out
    }

    /// BR phase 3: best-response total (reach-weighted root sum).
    pub fn br_finish(&self, trav: usize, values: &ChanceValues) -> f64 {
        let ctx = self.ctx();
        let v = s0_br(
            &ctx,
            &self.store,
            self.tree.root,
            trav,
            &self.hands[1 - trav].weights,
            values,
        );
        let mut total = 0f64;
        for h in 0..self.hands[trav].len() {
            total += (self.hands[trav].weights[h] as f64) * (v[h] as f64);
        }
        self.pool.put(v);
        total
    }

    /// Normalization constant for exploitability.
    pub fn pair_weight(&self) -> f64 {
        let compat = compat_sums(
            &self.hands[0],
            &self.hands[1],
            &self.same_combo[0],
            &self.hands[1].weights,
        );
        let mut w = 0f64;
        for h in 0..self.hands[0].len() {
            w += (self.hands[0].weights[h] * compat[h]) as f64;
        }
        w
    }

    /// EV fan-out phase 1: tasks for EVs at a starting-street action node.
    pub fn ev_begin(&self, path: &[u32]) -> Result<Vec<Task>, String> {
        let res = self.walk(path)?;
        let ctx = self.ctx();
        match &self.tree.nodes[res.node as usize] {
            Node::Action {
                player, children, ..
            } => {
                let p = *player as usize;
                let mut out = Vec::new();
                for &child in children.iter() {
                    collect(
                        &ctx,
                        &self.store,
                        child,
                        p,
                        &[],
                        &res.reach[1 - p],
                        false,
                        &mut out,
                    );
                }
                Ok(out)
            }
            _ => Err("ev_begin: not an action node".into()),
        }
    }

    /// EV fan-out phase 3: per-action EVs (counterfactual sums) and compat.
    pub fn ev_finish(
        &self,
        path: &[u32],
        values: &ChanceValues,
    ) -> Result<(Vec<Vec<f32>>, Vec<f32>, f32), String> {
        let res = self.walk(path)?;
        let ctx = self.ctx();
        match &self.tree.nodes[res.node as usize] {
            Node::Action {
                player, children, ..
            } => {
                let p = *player as usize;
                let evs: Vec<Vec<f32>> = children
                    .iter()
                    .map(|&c| s0_ev(&ctx, &self.store, c, p, &res.reach[1 - p], values))
                    .collect();
                let compat = compat_sums(
                    &self.hands[p],
                    &self.hands[1 - p],
                    &self.same_combo[p],
                    &res.reach[1 - p],
                );
                Ok((evs, compat, res.adds[p]))
            }
            _ => Err("ev_finish: not an action node".into()),
        }
    }

    /// Which worker owns the subtree a path descends into.
    /// -1 = the path stays on the starting street (main serves it).
    pub fn route_owner(&self, path: &[u32], workers: u8) -> Result<i32, String> {
        let mut node = self.tree.root;
        let mut perm = crate::iso::IDENTITY;
        for &step in path {
            match &self.tree.nodes[node as usize] {
                Node::Action { children, .. } => {
                    if step as usize >= children.len() {
                        return Err("invalid action index".into());
                    }
                    node = children[step as usize];
                }
                Node::Chance { children, .. } => {
                    let canon = crate::iso::permute_card(step as u8, &perm);
                    for cc in children {
                        for (card, p2) in &cc.orbit {
                            if *card == canon {
                                let _ = p2;
                                let _ = &mut perm;
                                return Ok((cc.rep % workers) as i32);
                            }
                        }
                    }
                    return Err("card not dealable".into());
                }
                _ => return Err("path descends past a terminal".into()),
            }
        }
        Ok(-1)
    }

    // ---- state serialization ----

    pub fn export_state(&self) -> Vec<u8> {
        let s = &self.store;
        let mut out = Vec::with_capacity(
            20 + (s.regrets[0].len() + s.regrets[1].len()) * 4 + s.reg_scale.len() * 8,
        );
        out.extend_from_slice(&0x4650_5331u32.to_le_bytes()); // "FPS1"
        out.extend_from_slice(&self.iterations.to_le_bytes());
        out.extend_from_slice(&(s.regrets[0].len() as u32).to_le_bytes());
        out.extend_from_slice(&(s.regrets[1].len() as u32).to_le_bytes());
        out.extend_from_slice(&(s.reg_scale.len() as u32).to_le_bytes());
        for arr in [&s.regrets[0], &s.regrets[1], &s.strat_sum[0], &s.strat_sum[1]] {
            for &v in arr.iter() {
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
        for arr in [&s.reg_scale, &s.ss_scale] {
            for &v in arr.iter() {
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
        out
    }

    pub fn import_state(&mut self, bytes: &[u8]) -> Result<(), String> {
        let rd_u32 = |b: &[u8], o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
        if bytes.len() < 20 || rd_u32(bytes, 0) != 0x4650_5331 {
            return Err("bad state header".into());
        }
        let iterations = rd_u32(bytes, 4);
        let l0 = rd_u32(bytes, 8) as usize;
        let l1 = rd_u32(bytes, 12) as usize;
        let ns = rd_u32(bytes, 16) as usize;
        let s = &mut self.store;
        if l0 != s.regrets[0].len() || l1 != s.regrets[1].len() || ns != s.reg_scale.len() {
            return Err("state does not match this game".into());
        }
        let expect = 20 + (l0 + l1) * 4 + ns * 8;
        if bytes.len() != expect {
            return Err("truncated state".into());
        }
        let mut o = 20;
        for arr_idx in 0..4 {
            let (arr, len) = match arr_idx {
                0 => (&mut s.regrets[0], l0),
                1 => (&mut s.regrets[1], l1),
                2 => (&mut s.strat_sum[0], l0),
                _ => (&mut s.strat_sum[1], l1),
            };
            for i in 0..len {
                arr[i] = u16::from_le_bytes(bytes[o..o + 2].try_into().unwrap());
                o += 2;
            }
        }
        for arr_idx in 0..2 {
            let arr = if arr_idx == 0 {
                &mut s.reg_scale
            } else {
                &mut s.ss_scale
            };
            for i in 0..ns {
                arr[i] = f32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
                o += 4;
            }
        }
        self.iterations = iterations;
        Ok(())
    }

    /// Export the starting-street cumulative strategy (the worker mirror).
    pub fn export_street0(&self) -> Vec<u8> {
        let start_street = (self.tree.cfg.board.len() - 3) as u8;
        let mut blocks: Vec<(u32, usize, usize, usize)> = Vec::new(); // (id, p, off, len)
        for (id, n) in self.tree.nodes.iter().enumerate() {
            if let Node::Action {
                player,
                street,
                actions,
                store_off,
                ..
            } = n
            {
                if *street == start_street && *store_off != UNOWNED {
                    let p = *player as usize;
                    let len = actions.len() * self.hands[p].len();
                    blocks.push((id as u32, p, *store_off, len));
                }
            }
        }
        let mut out = Vec::new();
        out.extend_from_slice(&(blocks.len() as u32).to_le_bytes());
        for (id, p, off, len) in blocks {
            out.extend_from_slice(&id.to_le_bytes());
            out.extend_from_slice(&(len as u32).to_le_bytes());
            for &v in &self.store.strat_sum[p][off..off + len] {
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
        out
    }

    pub fn import_street0(&mut self, bytes: &[u8]) -> Result<(), String> {
        let rd_u32 = |b: &[u8], o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
        if bytes.len() < 4 {
            return Err("bad street0 blob".into());
        }
        let n = rd_u32(bytes, 0) as usize;
        let mut o = 4;
        for _ in 0..n {
            if bytes.len() < o + 8 {
                return Err("truncated street0 blob".into());
            }
            let id = rd_u32(bytes, o) as usize;
            let len = rd_u32(bytes, o + 4) as usize;
            o += 8;
            if bytes.len() < o + len * 2 {
                return Err("truncated street0 blob".into());
            }
            match self.tree.nodes.get(id) {
                Some(Node::Action {
                    player,
                    actions,
                    store_off,
                    ..
                }) => {
                    let p = *player as usize;
                    let expect = actions.len() * self.hands[p].len();
                    if expect != len || *store_off == UNOWNED {
                        return Err("street0 block mismatch".into());
                    }
                    let dst = &mut self.store.strat_sum[p][*store_off..*store_off + len];
                    for (i, slot) in dst.iter_mut().enumerate() {
                        *slot = u16::from_le_bytes(
                            bytes[o + i * 2..o + i * 2 + 2].try_into().unwrap(),
                        );
                    }
                    o += len * 2;
                }
                _ => return Err("street0 block points at non-action node".into()),
            }
        }
        Ok(())
    }
}

/// Sum worker partials elementwise into a ChanceValues map.
pub fn sum_partials(into: &mut ChanceValues, partials: Vec<(u32, Vec<f32>)>) {
    for (id, v) in partials {
        match into.get_mut(&id) {
            Some(acc) => {
                for (a, b) in acc.iter_mut().zip(v.iter()) {
                    *a += b;
                }
            }
            None => {
                into.insert(id, v);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cards::parse_board;
    use crate::combos::expand_grid_weights;
    use crate::engine::{average_strategy, Game};
    use crate::tree::{Partition, TreeConfig};

    fn cfg(board: &str, partition: Partition) -> TreeConfig {
        TreeConfig {
            board: parse_board(board).unwrap(),
            pot: 10.0,
            stack: 95.0,
            bet_sizes: [vec![0.66], vec![0.75], vec![0.75]],
            raise_sizes: [vec![0.6], vec![0.6], vec![0.6]],
            max_bets: 2,
            allin_threshold: 0.0,
            partition,
        }
    }

    fn ranges(board: &str) -> (Vec<f32>, Vec<f32>) {
        // moderately sized asymmetric ranges
        let mut g0 = [0f32; 169];
        let mut g1 = [0f32; 169];
        for c in 0..169 {
            let row = c / 13;
            let col = c % 13;
            if row == col || row + col < 12 {
                g0[c] = 1.0;
            }
            if row == col || (row < col && col < 9) || (row > col && row < 5) {
                g1[c] = 1.0;
            }
        }
        let b = parse_board(board).unwrap();
        (
            expand_grid_weights(&g0, &b),
            expand_grid_weights(&g1, &b),
        )
    }

    /// Run a simulated 2-worker cluster and compare against the monolithic
    /// solver: exploitability must converge equally and the starting-street
    /// strategies must agree.
    #[test]
    fn cluster_matches_monolithic() {
        let board = "Ks7h2d8c"; // turn spot keeps the test fast
        let (w0, w1) = ranges(board);
        let k = 2u8;
        let mut mono = Game::new(cfg(board, Partition::None), &w0, &w1).unwrap();
        let mut main = Game::new(cfg(board, Partition::Main { workers: k }), &w0, &w1).unwrap();
        let mut workers: Vec<Game> = (0..k)
            .map(|i| {
                Game::new(
                    cfg(board, Partition::Worker { workers: k, idx: i }),
                    &w0,
                    &w1,
                )
                .unwrap()
            })
            .collect();

        let iters = 60;
        mono.run_iterations(iters);
        for _ in 0..iters {
            for p in 0..2usize {
                let weight = main.current_weight();
                let tasks = main.iter_begin(p);
                let mut values = ChanceValues::new();
                for w in workers.iter_mut() {
                    let partials = w.subtree_run(MODE_CFR, p, weight, &tasks);
                    sum_partials(&mut values, partials);
                }
                main.iter_finish(p, &values);
            }
        }
        assert_eq!(main.iterations, iters);

        // distributed exploitability
        let mut br_total = 0f64;
        for p in 0..2usize {
            let tasks = main.br_begin(p);
            let mut values = ChanceValues::new();
            for w in workers.iter_mut() {
                let partials = w.subtree_run(MODE_BR, p, 0.0, &tasks);
                sum_partials(&mut values, partials);
            }
            br_total += main.br_finish(p, &values);
        }
        let expl_cluster =
            ((br_total / main.pair_weight()) - main.tree.dead as f64) / 2.0;
        let expl_mono = mono.exploitability() as f64;
        assert!(
            expl_cluster < 0.05 * 10.0,
            "cluster did not converge: {}",
            expl_cluster
        );
        assert!(
            (expl_cluster - expl_mono).abs() < 0.02 * 10.0,
            "cluster {} vs mono {}",
            expl_cluster,
            expl_mono
        );

        // root strategies agree
        let root_strat = |g: &Game| -> Vec<f32> {
            match &g.tree.nodes[g.tree.root as usize] {
                crate::tree::Node::Action {
                    actions, store_off, ..
                } => {
                    let nh = g.hands[0].len();
                    average_strategy(
                        &g.store.strat_sum[0][*store_off..*store_off + actions.len() * nh],
                        actions.len(),
                        nh,
                    )
                }
                _ => panic!(),
            }
        };
        let s_mono = root_strat(&mono);
        let s_clu = root_strat(&main);
        let mut max_diff = 0f32;
        let mut total_diff = 0f64;
        for (a, b) in s_mono.iter().zip(s_clu.iter()) {
            max_diff = max_diff.max((a - b).abs());
            total_diff += (a - b).abs() as f64;
        }
        let avg_diff = total_diff / s_mono.len() as f64;
        assert!(
            avg_diff < 0.03,
            "avg strategy diff too large: {} (max {})",
            avg_diff,
            max_diff
        );

        // state roundtrip on a worker
        let blob = workers[0].export_state();
        let before = workers[0].iterations;
        workers[0].import_state(&blob).unwrap();
        assert_eq!(workers[0].iterations, before);

        // street0 mirror: workers can serve queries below a crossing
        let mirror = main.export_street0();
        for w in workers.iter_mut() {
            w.import_street0(&mirror).unwrap();
        }
        // route: a path through check/check then a card goes to a worker
        let owner = main.route_owner(&[0, 0, 8], k).unwrap();
        assert!(owner >= 0 && owner < k as i32);
        // that worker can walk the path if it owns the canonical rep
        let card_owner = owner as usize;
        let r = workers[card_owner].walk(&[0, 0, 8]);
        assert!(r.is_ok(), "owning worker must serve the query: {:?}", r.err());
        // EV fan-out at the root matches monolithic EVs
        let tasks = main.ev_begin(&[]).unwrap();
        let mut values = ChanceValues::new();
        for w in workers.iter_mut() {
            let partials = w.subtree_run(MODE_EV, 0, 0.0, &tasks);
            sum_partials(&mut values, partials);
        }
        let (evs_c, compat_c, sunk) = main.ev_finish(&[], &values).unwrap();
        assert_eq!(sunk, 0.0);
        let (evs_m, compat_m) = mono.action_evs(mono.tree.root, &mono.hands[1].weights);
        for a in 0..evs_m.len() {
            for h in 0..compat_m.len() {
                let em = evs_m[a][h] / compat_m[h].max(1e-9);
                let ec = evs_c[a][h] / compat_c[h].max(1e-9);
                assert!(
                    (em - ec).abs() < 0.5,
                    "EV mismatch a={} h={}: mono {} vs cluster {}",
                    a,
                    h,
                    em,
                    ec
                );
            }
        }
    }

    /// Tiny flop spot, fast — localize the distributed-BR bug by worker count.
    #[test]
    fn cluster_br_flop_tiny() {
        let board = "Ks7h2d";
        let b = parse_board(board).unwrap();
        let mut g0 = [0f32; 169];
        g0[0] = 1.0; // AA
        g0[28] = 1.0; // QQ
        let mut g1 = [0f32; 169];
        g1[14] = 1.0; // KK
        g1[42] = 1.0; // JJ
        let w0 = expand_grid_weights(&g0, &b);
        let w1 = expand_grid_weights(&g1, &b);
        // No CFR — uniform avg strategy. The distributed best-response total
        // must be identical across worker counts (same strategy, just a
        // different partition). Catches the shared-river-board ownership bug.
        let distributed_br = |k: u8| -> f64 {
            let main = Game::new(cfg(board, Partition::Main { workers: k }), &w0, &w1).unwrap();
            let mut workers: Vec<Game> = (0..k)
                .map(|i| Game::new(cfg(board, Partition::Worker { workers: k, idx: i }), &w0, &w1).unwrap())
                .collect();
            let mut br = 0f64;
            for p in 0..2usize {
                let tasks = main.br_begin(p);
                let mut values = ChanceValues::new();
                for w in workers.iter_mut() {
                    sum_partials(&mut values, w.subtree_run(MODE_BR, p, 0.0, &tasks));
                }
                br += main.br_finish(p, &values);
            }
            br
        };
        let br1 = distributed_br(1);
        let br2 = distributed_br(2);
        let br3 = distributed_br(3);
        println!("uniform-strategy distributed BR: k1={:.4} k2={:.4} k3={:.4}", br1, br2, br3);
        assert!((br1 - br2).abs() < 1e-2, "k1 {} vs k2 {}", br1, br2);
        assert!((br1 - br3).abs() < 1e-2, "k1 {} vs k3 {}", br1, br3);
    }

    /// Flop spot (two chance levels: turn + river). The original test only
    /// covered a turn spot; the distributed best-response must still match the
    /// monolithic one — and exploitability must never be negative.
    #[test]
    fn cluster_exploitability_flop() {
        let board = "Ks7h2d"; // flop → turn & river dealt inside the tree
        let (w0, w1) = ranges(board);
        let k = 3u8;
        let mut mono = Game::new(cfg(board, Partition::None), &w0, &w1).unwrap();
        let mut main = Game::new(cfg(board, Partition::Main { workers: k }), &w0, &w1).unwrap();
        let mut workers: Vec<Game> = (0..k)
            .map(|i| Game::new(cfg(board, Partition::Worker { workers: k, idx: i }), &w0, &w1).unwrap())
            .collect();

        let iters = 30;
        mono.run_iterations(iters);
        for _ in 0..iters {
            for p in 0..2usize {
                let weight = main.current_weight();
                let tasks = main.iter_begin(p);
                let mut values = ChanceValues::new();
                for w in workers.iter_mut() {
                    sum_partials(&mut values, w.subtree_run(MODE_CFR, p, weight, &tasks));
                }
                main.iter_finish(p, &values);
            }
        }

        let mut br_total = 0f64;
        for p in 0..2usize {
            let tasks = main.br_begin(p);
            let mut values = ChanceValues::new();
            for w in workers.iter_mut() {
                sum_partials(&mut values, w.subtree_run(MODE_BR, p, 0.0, &tasks));
            }
            br_total += main.br_finish(p, &values);
        }
        let expl_cluster = ((br_total / main.pair_weight()) - main.tree.dead as f64) / 2.0;
        let expl_mono = mono.exploitability() as f64;
        println!("flop: cluster {} vs mono {}", expl_cluster, expl_mono);
        assert!(expl_cluster >= -1e-3, "negative exploitability: {}", expl_cluster);
        assert!(
            (expl_cluster - expl_mono).abs() < 0.03 * 10.0,
            "cluster {} vs mono {}",
            expl_cluster,
            expl_mono
        );
    }
}
