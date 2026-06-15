//! CFR+ engine with suit isomorphism, O(n) showdown sweeps and a buffer pool
//! to keep the hot traversal allocation-free.

use crate::cards::Card;
use crate::combos::{combo_index, permute_combo, HandList};
use crate::eval::evaluate7;
use crate::iso::{compose, permute_card, IDENTITY};
use crate::tree::{build_tree, Node, Partition, Tree, TreeConfig};
use std::cell::RefCell;
use std::collections::HashMap;

pub struct RiverInfo {
    /// per player: (rank, hand_idx) sorted ascending by rank
    pub sorted: [Vec<(u32, u16)>; 2],
}

/// Quantized storage: regrets and cumulative strategy are kept as u16 with a
/// per-node f32 scale (value = raw * scale / 65535). Strategy computations
/// normalize per hand, so the scale cancels and raw u16 values can be used
/// directly; only the CFR update needs decode/encode.
pub struct Store {
    pub regrets: [Vec<u16>; 2],
    pub strat_sum: [Vec<u16>; 2],
    /// per action-node scales, indexed by scale_idx
    pub reg_scale: Vec<f32>,
    pub ss_scale: Vec<f32>,
}

pub(crate) const Q: f32 = 65535.0;

/// Reusable f32 buffer pool: traversal allocates once, reuses forever.
pub struct BufPool {
    bufs: RefCell<Vec<Vec<f32>>>,
}

impl BufPool {
    pub fn new() -> Self {
        BufPool {
            bufs: RefCell::new(Vec::new()),
        }
    }
    #[inline]
    pub(crate) fn get(&self, n: usize) -> Vec<f32> {
        let mut v = self.bufs.borrow_mut().pop().unwrap_or_default();
        v.clear();
        v.resize(n, 0.0);
        v
    }
    #[inline]
    pub(crate) fn put(&self, v: Vec<f32>) {
        self.bufs.borrow_mut().push(v);
    }
}

impl Default for BufPool {
    fn default() -> Self {
        Self::new()
    }
}

pub struct Game {
    pub tree: Tree,
    pub hands: [HandList; 2],
    /// my hand idx -> opp hand idx holding the identical combo (u16::MAX if none)
    pub same_combo: [Vec<u16>; 2],
    pub river_infos: Vec<RiverInfo>,
    pub store: Store,
    pub iterations: u32,
    /// (player, perm) -> hand index remap
    pub(crate) perm_maps: HashMap<(u8, [u8; 4]), Vec<u16>>,
    pub(crate) pool: BufPool,
}

pub(crate) struct Ctx<'a> {
    pub(crate) tree: &'a Tree,
    pub(crate) hands: &'a [HandList; 2],
    pub(crate) same_combo: &'a [Vec<u16>; 2],
    pub(crate) river_infos: &'a [RiverInfo],
    pub(crate) perm_maps: &'a HashMap<(u8, [u8; 4]), Vec<u16>>,
    pub(crate) dead: f32,
    pub(crate) pool: &'a BufPool,
}

#[inline]
pub(crate) fn hand_conflicts(hands: &HandList, h: usize, card: Card) -> bool {
    let (c1, c2) = hands.cards[h];
    c1 == card || c2 == card
}

/// Compatible opponent reach total for each of my hands (card-removal
/// adjusted), written into `out`.
fn compat_sums_into(
    my: &HandList,
    opp: &HandList,
    same_combo: &[u16],
    opp_reach: &[f32],
    out: &mut [f32],
) {
    let mut t_all = 0f32;
    let mut card_t = [0f32; 52];
    for o in 0..opp.len() {
        let w = opp_reach[o];
        if w != 0.0 {
            let (c1, c2) = opp.cards[o];
            t_all += w;
            card_t[c1 as usize] += w;
            card_t[c2 as usize] += w;
        }
    }
    for h in 0..my.len() {
        let (c1, c2) = my.cards[h];
        let sc = same_combo[h];
        let self_w = if sc != u16::MAX {
            opp_reach[sc as usize]
        } else {
            0.0
        };
        out[h] = t_all - card_t[c1 as usize] - card_t[c2 as usize] + self_w;
    }
}

pub(crate) fn compat_sums(my: &HandList, opp: &HandList, same_combo: &[u16], opp_reach: &[f32]) -> Vec<f32> {
    let mut out = vec![0f32; my.len()];
    compat_sums_into(my, opp, same_combo, opp_reach, &mut out);
    out
}

pub(crate) fn showdown_values(
    ctx: &Ctx,
    river_idx: u32,
    trav: usize,
    opp_reach: &[f32],
    contrib: f32,
) -> Vec<f32> {
    let info = &ctx.river_infos[river_idx as usize];
    let s_my = &info.sorted[trav];
    let s_opp = &info.sorted[1 - trav];
    let my = &ctx.hands[trav];
    let opp = &ctx.hands[1 - trav];
    let nh = my.len();
    let half_dead = ctx.dead * 0.5;
    let stake = half_dead + contrib;

    let mut win = ctx.pool.get(nh);
    // ascending: weight of strictly worse opp hands
    {
        let mut cum = 0f32;
        let mut card_cum = [0f32; 52];
        let mut j = 0usize;
        for &(rank, hi) in s_my.iter() {
            while j < s_opp.len() && s_opp[j].0 < rank {
                let oi = s_opp[j].1 as usize;
                let w = opp_reach[oi];
                if w != 0.0 {
                    let (c1, c2) = opp.cards[oi];
                    cum += w;
                    card_cum[c1 as usize] += w;
                    card_cum[c2 as usize] += w;
                }
                j += 1;
            }
            let (c1, c2) = my.cards[hi as usize];
            win[hi as usize] = cum - card_cum[c1 as usize] - card_cum[c2 as usize];
        }
    }
    let mut compat = ctx.pool.get(nh);
    compat_sums_into(my, opp, &ctx.same_combo[trav], opp_reach, &mut compat);
    let mut out = ctx.pool.get(nh);
    // descending: weight of strictly better opp hands
    {
        let mut cum = 0f32;
        let mut card_cum = [0f32; 52];
        let mut j = s_opp.len();
        for &(rank, hi) in s_my.iter().rev() {
            while j > 0 && s_opp[j - 1].0 > rank {
                let oi = s_opp[j - 1].1 as usize;
                let w = opp_reach[oi];
                if w != 0.0 {
                    let (c1, c2) = opp.cards[oi];
                    cum += w;
                    card_cum[c1 as usize] += w;
                    card_cum[c2 as usize] += w;
                }
                j -= 1;
            }
            let h = hi as usize;
            let (c1, c2) = my.cards[h];
            let lose = cum - card_cum[c1 as usize] - card_cum[c2 as usize];
            out[h] = stake * (win[h] - lose) + half_dead * compat[h];
        }
    }
    ctx.pool.put(win);
    ctx.pool.put(compat);
    out
}

pub(crate) fn fold_values(
    ctx: &Ctx,
    trav: usize,
    folder: u8,
    folder_add: f32,
    opp_reach: &[f32],
) -> Vec<f32> {
    let my = &ctx.hands[trav];
    let opp = &ctx.hands[1 - trav];
    let mut out = ctx.pool.get(my.len());
    compat_sums_into(my, opp, &ctx.same_combo[trav], opp_reach, &mut out);
    let factor = if trav == folder as usize {
        -folder_add
    } else {
        ctx.dead + folder_add
    };
    for v in out.iter_mut() {
        *v *= factor;
    }
    out
}

/// Normalize raw u16 rows per hand (uniform fallback). The per-node scale
/// cancels, so this serves both regret-matching(+) and average strategy.
pub(crate) fn normalize_into(raw: &[u16], na: usize, nh: usize, strat: &mut [f32]) {
    for h in 0..nh {
        let mut s = 0u32;
        for a in 0..na {
            s += raw[a * nh + h] as u32;
        }
        if s > 0 {
            let inv = 1.0 / s as f32;
            for a in 0..na {
                strat[a * nh + h] = raw[a * nh + h] as f32 * inv;
            }
        } else {
            let u = 1.0 / na as f32;
            for a in 0..na {
                strat[a * nh + h] = u;
            }
        }
    }
}

/// Average strategy at a node (normalized strat_sum, uniform fallback).
pub fn average_strategy(strat_sum: &[u16], na: usize, nh: usize) -> Vec<f32> {
    let mut strat = vec![0f32; na * nh];
    normalize_into(strat_sum, na, nh, &mut strat);
    strat
}

pub(crate) fn chance_accumulate(
    ctx: &Ctx,
    trav: usize,
    out: &mut [f32],
    v: &[f32],
    card: Card,
    perm: &[u8; 4],
) {
    let my = &ctx.hands[trav];
    if *perm == IDENTITY {
        for h in 0..my.len() {
            if !hand_conflicts(my, h, card) {
                out[h] += v[h];
            }
        }
    } else {
        let map = &ctx.perm_maps[&(trav as u8, *perm)];
        for h in 0..my.len() {
            let m = map[h];
            if m != u16::MAX && !hand_conflicts(my, h, card) {
                out[h] += v[m as usize];
            }
        }
    }
}

/// Shared chance-node traversal: recurse into canonical children with
/// conflict-zeroed reaches, accumulate orbit members, scale by deal prob.
fn chance_traverse(
    ctx: &Ctx,
    trav: usize,
    norm: f32,
    children: &[crate::tree::ChanceChild],
    my_reach: Option<&[f32]>,
    opp_reach: &[f32],
    mut recurse: impl FnMut(&Ctx, u32, Option<&[f32]>, &[f32]) -> Vec<f32>,
) -> Vec<f32> {
    let nh = ctx.hands[trav].len();
    let nh_opp = ctx.hands[1 - trav].len();
    let mut out = ctx.pool.get(nh);
    for cc in children {
        let c_my = my_reach.map(|mr| {
            let mut b = ctx.pool.get(nh);
            b.copy_from_slice(mr);
            for h in 0..nh {
                if hand_conflicts(&ctx.hands[trav], h, cc.rep) {
                    b[h] = 0.0;
                }
            }
            b
        });
        let mut c_opp = ctx.pool.get(nh_opp);
        c_opp.copy_from_slice(opp_reach);
        for o in 0..nh_opp {
            if hand_conflicts(&ctx.hands[1 - trav], o, cc.rep) {
                c_opp[o] = 0.0;
            }
        }
        let v = recurse(ctx, cc.child, c_my.as_deref(), &c_opp);
        for (card, perm) in &cc.orbit {
            chance_accumulate(ctx, trav, &mut out, &v, *card, perm);
        }
        ctx.pool.put(v);
        ctx.pool.put(c_opp);
        if let Some(b) = c_my {
            ctx.pool.put(b);
        }
    }
    for x in out.iter_mut() {
        *x *= norm;
    }
    out
}

pub(crate) fn cfr(
    ctx: &Ctx,
    store: &mut Store,
    node: u32,
    trav: usize,
    my_reach: &[f32],
    opp_reach: &[f32],
    weight: f32,
) -> Vec<f32> {
    match &ctx.tree.nodes[node as usize] {
        Node::Fold { folder, folder_add } => fold_values(ctx, trav, *folder, *folder_add, opp_reach),
        Node::Showdown { contrib, river_idx } => {
            showdown_values(ctx, *river_idx, trav, opp_reach, *contrib)
        }
        Node::Chance { norm, children } => {
            // manual traversal (closure can't borrow store mutably twice)
            let nh = ctx.hands[trav].len();
            let nh_opp = ctx.hands[1 - trav].len();
            let mut out = ctx.pool.get(nh);
            for cc in children {
                let mut c_my = ctx.pool.get(nh);
                c_my.copy_from_slice(my_reach);
                for h in 0..nh {
                    if hand_conflicts(&ctx.hands[trav], h, cc.rep) {
                        c_my[h] = 0.0;
                    }
                }
                let mut c_opp = ctx.pool.get(nh_opp);
                c_opp.copy_from_slice(opp_reach);
                for o in 0..nh_opp {
                    if hand_conflicts(&ctx.hands[1 - trav], o, cc.rep) {
                        c_opp[o] = 0.0;
                    }
                }
                let v = cfr(ctx, store, cc.child, trav, &c_my, &c_opp, weight);
                for (card, perm) in &cc.orbit {
                    chance_accumulate(ctx, trav, &mut out, &v, *card, perm);
                }
                ctx.pool.put(v);
                ctx.pool.put(c_opp);
                ctx.pool.put(c_my);
            }
            for x in out.iter_mut() {
                *x *= norm;
            }
            out
        }
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
                    vals.push(cfr(ctx, store, child, trav, &c_my, opp_reach, weight));
                    ctx.pool.put(c_my);
                }
                let mut v = ctx.pool.get(nh);
                for a in 0..na {
                    let va = &vals[a];
                    for h in 0..nh {
                        v[h] += strat[a * nh + h] * va[h];
                    }
                }
                // CFR+ regret update: decode u16 -> add -> floor at 0 -> re-encode
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
                // cumulative strategy: decode -> accumulate -> re-encode
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
                    let va = cfr(ctx, store, child, trav, my_reach, &c_opp, weight);
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

/// Best response values for `trav` against the opponent's average strategy.
pub(crate) fn best_response(ctx: &Ctx, store: &Store, node: u32, trav: usize, opp_reach: &[f32]) -> Vec<f32> {
    match &ctx.tree.nodes[node as usize] {
        Node::Fold { folder, folder_add } => fold_values(ctx, trav, *folder, *folder_add, opp_reach),
        Node::Showdown { contrib, river_idx } => {
            showdown_values(ctx, *river_idx, trav, opp_reach, *contrib)
        }
        Node::Chance { norm, children } => chance_traverse(
            ctx,
            trav,
            *norm,
            children,
            None,
            opp_reach,
            |ctx, child, _, c_opp| best_response(ctx, store, child, trav, c_opp),
        ),
        Node::Action {
            player,
            children,
            store_off,
            actions,
            ..
        } => {
            let p = *player as usize;
            let na = actions.len();
            if p == trav {
                let nh = ctx.hands[p].len();
                let mut v = ctx.pool.get(nh);
                v.iter_mut().for_each(|x| *x = f32::NEG_INFINITY);
                for &child in children.iter() {
                    let va = best_response(ctx, store, child, trav, opp_reach);
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
                    let va = best_response(ctx, store, child, trav, &c_opp);
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

/// Expectimax values under the average strategy profile for `trav`.
pub(crate) fn ev_walk(ctx: &Ctx, store: &Store, node: u32, trav: usize, opp_reach: &[f32]) -> Vec<f32> {
    match &ctx.tree.nodes[node as usize] {
        Node::Fold { folder, folder_add } => fold_values(ctx, trav, *folder, *folder_add, opp_reach),
        Node::Showdown { contrib, river_idx } => {
            showdown_values(ctx, *river_idx, trav, opp_reach, *contrib)
        }
        Node::Chance { norm, children } => chance_traverse(
            ctx,
            trav,
            *norm,
            children,
            None,
            opp_reach,
            |ctx, child, _, c_opp| ev_walk(ctx, store, child, trav, c_opp),
        ),
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
                let nh = nh_p;
                let mut v = ctx.pool.get(nh);
                for (a, &child) in children.iter().enumerate() {
                    let va = ev_walk(ctx, store, child, trav, opp_reach);
                    for h in 0..nh {
                        v[h] += strat[a * nh + h] * va[h];
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
                    let va = ev_walk(ctx, store, child, trav, &c_opp);
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
    pub fn new(cfg: TreeConfig, weights0: &[f32], weights1: &[f32]) -> Result<Game, String> {
        let hands = [
            HandList::from_weights(weights0),
            HandList::from_weights(weights1),
        ];
        if hands[0].is_empty() || hands[1].is_empty() {
            return Err("empty range".into());
        }
        let tree = build_tree(cfg, [hands[0].len(), hands[1].len()]);

        // inverse combo lookup per player
        let mut inv = [vec![u16::MAX; 1326], vec![u16::MAX; 1326]];
        for p in 0..2 {
            for (h, &ci) in hands[p].combo_idx.iter().enumerate() {
                inv[p][ci] = h as u16;
            }
        }
        let same_combo = [
            hands[0].combo_idx.iter().map(|&ci| inv[1][ci]).collect::<Vec<u16>>(),
            hands[1].combo_idx.iter().map(|&ci| inv[0][ci]).collect::<Vec<u16>>(),
        ];

        // River infos for every distinct river board. These MUST be complete in
        // every instance that reaches showdowns: river_boards are deduplicated by
        // sorted card set, so the same 5-card board is shared between turn/river
        // orderings dealt under different first-level (turn) cards — a worker can
        // therefore reach a board whose stored turn card belongs to another
        // worker. Skipping any here silently zeros those showdowns (the cluster
        // flop bug). The cost is small (~MBs) vs the strategy storage.
        let mut river_infos = Vec::with_capacity(tree.river_boards.len());
        for board in &tree.river_boards {
            let mut sorted: [Vec<(u32, u16)>; 2] = [Vec::new(), Vec::new()];
            for p in 0..2 {
                let mut v: Vec<(u32, u16)> = (0..hands[p].len())
                    .map(|h| {
                        let (c1, c2) = hands[p].cards[h];
                        let cards = [board[0], board[1], board[2], board[3], board[4], c1, c2];
                        (evaluate7(&cards), h as u16)
                    })
                    .collect();
                v.sort_unstable();
                sorted[p] = v;
            }
            river_infos.push(RiverInfo { sorted });
        }

        // perm maps for every non-identity perm appearing in the tree
        let mut perm_maps: HashMap<(u8, [u8; 4]), Vec<u16>> = HashMap::new();
        for n in &tree.nodes {
            if let Node::Chance { children, .. } = n {
                for cc in children {
                    for (_, perm) in &cc.orbit {
                        if *perm == IDENTITY {
                            continue;
                        }
                        for p in 0..2u8 {
                            perm_maps.entry((p, *perm)).or_insert_with(|| {
                                let hp = &hands[p as usize];
                                (0..hp.len())
                                    .map(|h| {
                                        let (c1, c2) = hp.cards[h];
                                        let (a, b) = permute_combo(c1, c2, perm);
                                        // u16::MAX is legitimate: the perm may move a hand
                                        // onto the board (e.g. a hand holding the turn card
                                        // when the perm swaps the turn with a flop card).
                                        // Such hands have zero reach in that subtree.
                                        inv[p as usize][combo_index(a, b)]
                                    })
                                    .collect()
                            });
                        }
                    }
                }
            }
        }

        let store = Store {
            regrets: [vec![0u16; tree.store_len[0]], vec![0u16; tree.store_len[1]]],
            strat_sum: [vec![0u16; tree.store_len[0]], vec![0u16; tree.store_len[1]]],
            reg_scale: vec![0f32; tree.num_action_nodes],
            ss_scale: vec![0f32; tree.num_action_nodes],
        };

        Ok(Game {
            tree,
            hands,
            same_combo,
            river_infos,
            store,
            iterations: 0,
            perm_maps,
            pool: BufPool::new(),
        })
    }

    pub(crate) fn ctx(&self) -> Ctx<'_> {
        Ctx {
            tree: &self.tree,
            hands: &self.hands,
            same_combo: &self.same_combo,
            river_infos: &self.river_infos,
            perm_maps: &self.perm_maps,
            dead: self.tree.dead,
            pool: &self.pool,
        }
    }

    pub fn run_iterations(&mut self, n: u32) {
        for _ in 0..n {
            let weight = (self.iterations + 1) as f32;
            for p in 0..2usize {
                let my_reach = self.hands[p].weights.clone();
                let opp_reach = self.hands[1 - p].weights.clone();
                let ctx = Ctx {
                    tree: &self.tree,
                    hands: &self.hands,
                    same_combo: &self.same_combo,
                    river_infos: &self.river_infos,
                    perm_maps: &self.perm_maps,
                    dead: self.tree.dead,
                    pool: &self.pool,
                };
                let v = cfr(
                    &ctx,
                    &mut self.store,
                    self.tree.root,
                    p,
                    &my_reach,
                    &opp_reach,
                    weight,
                );
                self.pool.put(v);
            }
            self.iterations += 1;
        }
    }

    /// Exploitability in bb (average of both players' best-response gains).
    pub fn exploitability(&self) -> f32 {
        let ctx = self.ctx();
        let mut pair_weight = 0f64;
        {
            let compat = compat_sums(
                &self.hands[0],
                &self.hands[1],
                &self.same_combo[0],
                &self.hands[1].weights,
            );
            for h in 0..self.hands[0].len() {
                pair_weight += (self.hands[0].weights[h] * compat[h]) as f64;
            }
        }
        if pair_weight <= 0.0 {
            return 0.0;
        }
        let mut br_total = 0f64;
        for p in 0..2usize {
            let v = best_response(
                &ctx,
                &self.store,
                self.tree.root,
                p,
                &self.hands[1 - p].weights,
            );
            for h in 0..self.hands[p].len() {
                br_total += (self.hands[p].weights[h] as f64) * (v[h] as f64);
            }
            self.pool.put(v);
        }
        (((br_total / pair_weight) - self.tree.dead as f64) / 2.0) as f32
    }

    /// Per-action expectimax EVs at an action node (counterfactual sums).
    pub fn action_evs(&self, node: u32, opp_reach: &[f32]) -> (Vec<Vec<f32>>, Vec<f32>) {
        let ctx = self.ctx();
        if let Node::Action {
            player, children, ..
        } = &self.tree.nodes[node as usize]
        {
            let p = *player as usize;
            let evs: Vec<Vec<f32>> = children
                .iter()
                .map(|&c| ev_walk(&ctx, &self.store, c, p, opp_reach))
                .collect();
            let compat = compat_sums(
                &self.hands[p],
                &self.hands[1 - p],
                &self.same_combo[p],
                opp_reach,
            );
            (evs, compat)
        } else {
            (Vec::new(), Vec::new())
        }
    }

    /// Equity (win + tie/2) / compat for `trav`'s hands given reaches, rolling
    /// out the remaining board with no further betting. `board` must be the
    /// canonical-frame board at the node.
    pub fn equity(&self, board: &[Card], trav: usize, opp_reach: &[f32]) -> Vec<f32> {
        let my = &self.hands[trav];
        let opp = &self.hands[1 - trav];
        let nh = my.len();
        let mut used = [false; 52];
        for &c in board {
            used[c as usize] = true;
        }
        let remaining: Vec<Card> = (0..52u8).filter(|&c| !used[c as usize]).collect();
        let mut completions: Vec<Vec<Card>> = Vec::new();
        match board.len() {
            5 => completions.push(Vec::new()),
            4 => {
                for &c in &remaining {
                    completions.push(vec![c]);
                }
            }
            3 => {
                for i in 0..remaining.len() {
                    for j in (i + 1)..remaining.len() {
                        completions.push(vec![remaining[i], remaining[j]]);
                    }
                }
            }
            _ => return vec![0.5; nh],
        }

        let mut num = vec![0f64; nh];
        let mut den = vec![0f64; nh];
        let mut full = [0u8; 5];
        for (i, &c) in board.iter().enumerate() {
            full[i] = c;
        }
        for comp in &completions {
            for (i, &c) in comp.iter().enumerate() {
                full[board.len() + i] = c;
            }
            let mut reach = opp_reach.to_vec();
            for o in 0..opp.len() {
                if comp.iter().any(|&c| hand_conflicts(opp, o, c)) {
                    reach[o] = 0.0;
                }
            }
            let mut sorted: [Vec<(u32, u16)>; 2] = [Vec::new(), Vec::new()];
            for (p, hl) in [my, opp].iter().enumerate() {
                let mut v: Vec<(u32, u16)> = (0..hl.len())
                    .map(|h| {
                        let (c1, c2) = hl.cards[h];
                        let cards = [full[0], full[1], full[2], full[3], full[4], c1, c2];
                        (evaluate7(&cards), h as u16)
                    })
                    .collect();
                v.sort_unstable();
                sorted[p] = v;
            }
            // ascending sweep: wins
            let mut win = vec![0f32; nh];
            {
                let mut cum = 0f32;
                let mut card_cum = [0f32; 52];
                let mut j = 0usize;
                for &(rank, hi) in sorted[0].iter() {
                    while j < sorted[1].len() && sorted[1][j].0 < rank {
                        let oi = sorted[1][j].1 as usize;
                        let w = reach[oi];
                        if w != 0.0 {
                            let (c1, c2) = opp.cards[oi];
                            cum += w;
                            card_cum[c1 as usize] += w;
                            card_cum[c2 as usize] += w;
                        }
                        j += 1;
                    }
                    let (c1, c2) = my.cards[hi as usize];
                    win[hi as usize] = cum - card_cum[c1 as usize] - card_cum[c2 as usize];
                }
            }
            // descending sweep: losses
            let mut lose = vec![0f32; nh];
            {
                let mut cum = 0f32;
                let mut card_cum = [0f32; 52];
                let mut j = sorted[1].len();
                for &(rank, hi) in sorted[0].iter().rev() {
                    while j > 0 && sorted[1][j - 1].0 > rank {
                        let oi = sorted[1][j - 1].1 as usize;
                        let w = reach[oi];
                        if w != 0.0 {
                            let (c1, c2) = opp.cards[oi];
                            cum += w;
                            card_cum[c1 as usize] += w;
                            card_cum[c2 as usize] += w;
                        }
                        j -= 1;
                    }
                    let (c1, c2) = my.cards[hi as usize];
                    lose[hi as usize] = cum - card_cum[c1 as usize] - card_cum[c2 as usize];
                }
            }
            let compat = compat_sums(my, opp, &self.same_combo[trav], &reach);
            for h in 0..nh {
                if comp.iter().any(|&c| hand_conflicts(my, h, c)) {
                    continue;
                }
                let tie = compat[h] - win[h] - lose[h];
                num[h] += (win[h] + 0.5 * tie) as f64;
                den[h] += compat[h] as f64;
            }
        }
        (0..nh)
            .map(|h| {
                if den[h] > 0.0 {
                    (num[h] / den[h]) as f32
                } else {
                    0.0
                }
            })
            .collect()
    }
}

/// Result of walking a path from the root.
pub struct PathResult {
    pub node: u32,
    /// suit perm mapping the actual world onto the canonical (stored) world
    pub perm: [u8; 4],
    /// actual-world board
    pub board: Vec<Card>,
    /// canonical-frame board
    pub canon_board: Vec<Card>,
    /// canonical-frame reach (average strategy) per player
    pub reach: [Vec<f32>; 2],
    /// chips each player has committed along the path (postflop adds)
    pub adds: [f32; 2],
}

impl Game {
    /// Path steps: at action nodes the action index; at chance nodes the
    /// actual card id (0..51).
    pub fn walk(&self, path: &[u32]) -> Result<PathResult, String> {
        let mut node = self.tree.root;
        let mut perm = IDENTITY;
        let mut board = self.tree.cfg.board.clone();
        let mut canon_board = board.clone();
        let mut reach = [self.hands[0].weights.clone(), self.hands[1].weights.clone()];
        let mut adds = [0f32; 2];
        for &step in path {
            match &self.tree.nodes[node as usize] {
                Node::Action {
                    player,
                    actions,
                    children,
                    store_off,
                    ..
                } => {
                    let a = step as usize;
                    if a >= actions.len() {
                        return Err("invalid action index".into());
                    }
                    let p = *player as usize;
                    if *store_off == crate::tree::UNOWNED {
                        return Err("node not owned by this instance".into());
                    }
                    let nh = self.hands[p].len();
                    let strat = average_strategy(
                        &self.store.strat_sum[p][*store_off..*store_off + actions.len() * nh],
                        actions.len(),
                        nh,
                    );
                    for h in 0..nh {
                        reach[p][h] *= strat[a * nh + h];
                    }
                    adds[p] += actions[a].chips;
                    node = children[a];
                }
                Node::Chance { children, .. } => {
                    if step > 51 {
                        return Err("invalid card".into());
                    }
                    let actual = step as Card;
                    if board.contains(&actual) {
                        return Err("card already on board".into());
                    }
                    let canon_card = permute_card(actual, &perm);
                    let mut found = None;
                    'outer: for cc in children {
                        for (card, p2) in &cc.orbit {
                            if *card == canon_card {
                                found = Some((cc, *p2));
                                break 'outer;
                            }
                        }
                    }
                    let (cc, p2) = found.ok_or_else(|| "card not dealable".to_string())?;
                    perm = compose(&p2, &perm);
                    for p in 0..2 {
                        for h in 0..self.hands[p].len() {
                            if hand_conflicts(&self.hands[p], h, cc.rep) {
                                reach[p][h] = 0.0;
                            }
                        }
                    }
                    board.push(actual);
                    canon_board.push(cc.rep);
                    node = cc.child;
                }
                _ => return Err("path descends past a terminal".into()),
            }
        }
        Ok(PathResult {
            node,
            perm,
            board,
            canon_board,
            reach,
            adds,
        })
    }

    /// hand index remap for presenting canonical-frame data in the actual
    /// world: out[h_actual] = h_canonical (u16::MAX if blocked)
    pub fn hand_remap(&self, player: usize, perm: &[u8; 4]) -> Vec<u16> {
        let hl = &self.hands[player];
        (0..hl.len())
            .map(|h| {
                let (c1, c2) = hl.cards[h];
                let (a, b) = permute_combo(c1, c2, perm);
                let ci = combo_index(a, b);
                hl.combo_idx
                    .binary_search(&ci)
                    .map(|i| i as u16)
                    .unwrap_or(u16::MAX)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cards::parse_board;
    use crate::combos::expand_grid_weights;

    fn uniform_grid() -> [f32; 169] {
        [1.0; 169]
    }

    fn make_game(
        board: &str,
        grid0: &[f32; 169],
        grid1: &[f32; 169],
        cfg_mod: impl Fn(&mut TreeConfig),
    ) -> Game {
        let board = parse_board(board).unwrap();
        let mut cfg = TreeConfig {
            board: board.clone(),
            pot: 10.0,
            stack: 95.0,
            bet_sizes: [vec![0.66], vec![0.75], vec![0.75]],
            raise_sizes: [vec![0.6], vec![0.6], vec![0.6]],
            max_bets: 2,
            allin_threshold: 0.0,
            partition: Partition::None,
        };
        cfg_mod(&mut cfg);
        let w0 = expand_grid_weights(grid0, &board);
        let w1 = expand_grid_weights(grid1, &board);
        Game::new(cfg, &w0, &w1).unwrap()
    }

    #[test]
    fn exploitability_decreases_river() {
        let mut g = make_game("AhKd2c7s9d", &uniform_grid(), &uniform_grid(), |_| {});
        let e0 = g.exploitability();
        g.run_iterations(30);
        let e1 = g.exploitability();
        g.run_iterations(70);
        let e2 = g.exploitability();
        assert!(e1 < e0, "expl should drop: {} -> {}", e0, e1);
        assert!(e2 < e1, "expl should keep dropping: {} -> {}", e1, e2);
        assert!(e2 < 0.05 * 10.0, "river expl too high: {}", e2);
    }

    #[test]
    fn exploitability_decreases_turn() {
        let mut g = make_game("AhKd2c7s", &uniform_grid(), &uniform_grid(), |_| {});
        let e0 = g.exploitability();
        g.run_iterations(40);
        let e1 = g.exploitability();
        assert!(e1 < e0);
        assert!(e1 < 0.08 * 10.0, "turn expl too high: {}", e1);
    }

    /// Classic polarized-river toy game. OOP holds nuts (AA) + air (QJs),
    /// IP holds bluff-catchers (88). With pot 10 and a 7.5 bet:
    /// - AA always bets (strictly profitable)
    /// - QJs bluffs so that bluffs make up B/(P+2B) = 30% of the betting
    ///   range: 3 * 0.3/0.7 = 1.29 combos of 4, i.e. ~32% frequency
    /// - 88 calls 1 - B/(P+B) = ~57% to make bluffs indifferent
    #[test]
    fn polarized_river_equilibrium() {
        let mut g0 = [0f32; 169];
        g0[0] = 1.0; // AA
        g0[2 * 13 + 3] = 1.0; // QJs
        let mut g1 = [0f32; 169];
        g1[6 * 13 + 6] = 1.0; // 88
        let mut g = make_game("Ah7d2c9s3d", &g0, &g1, |cfg| {
            cfg.max_bets = 1; // bet, then call/fold only
        });
        g.run_iterations(400);
        let labels = |p: usize| -> Vec<String> {
            g.hands[p]
                .cards
                .iter()
                .map(|&(c1, c2)| crate::combos::grid_label(crate::combos::grid_index(c1, c2)))
                .collect()
        };
        // root: OOP check (0) / bet (1)
        let (bet_node, root_strat, nh0) = match &g.tree.nodes[g.tree.root as usize] {
            Node::Action {
                actions,
                children,
                store_off,
                ..
            } => {
                let nh = g.hands[0].len();
                let s = average_strategy(
                    &g.store.strat_sum[0][*store_off..*store_off + actions.len() * nh],
                    actions.len(),
                    nh,
                );
                (children[1], s, nh)
            }
            _ => panic!(),
        };
        let l0 = labels(0);
        let mut aa_bet = (0.0, 0);
        let mut qj_bet = (0.0, 0);
        for h in 0..nh0 {
            let bet = root_strat[nh0 + h];
            if l0[h] == "AA" {
                aa_bet = (aa_bet.0 + bet, aa_bet.1 + 1);
            } else {
                qj_bet = (qj_bet.0 + bet, qj_bet.1 + 1);
            }
        }
        let aa_freq = aa_bet.0 / aa_bet.1 as f32;
        let qj_freq = qj_bet.0 / qj_bet.1 as f32;
        assert_eq!(aa_bet.1, 3); // Ah blocked
        assert!(aa_freq > 0.85, "AA should bet ~always, got {}", aa_freq);
        assert!(
            qj_freq > 0.1 && qj_freq < 0.55,
            "QJs should bluff ~32%, got {}",
            qj_freq
        );
        // IP facing the bet: fold (0) / call (1)
        match &g.tree.nodes[bet_node as usize] {
            Node::Action {
                actions, store_off, ..
            } => {
                let nh = g.hands[1].len();
                let s = average_strategy(
                    &g.store.strat_sum[1][*store_off..*store_off + actions.len() * nh],
                    actions.len(),
                    nh,
                );
                let call: f32 = (0..nh).map(|h| s[nh + h]).sum::<f32>() / nh as f32;
                assert!(call > 0.4 && call < 0.75, "88 should call ~57%, got {}", call);
            }
            _ => panic!("bet child should be IP action node"),
        }
    }

    /// EV output must match the analytic equilibrium values of the polarized
    /// river game (pot 10, bet 7.5):
    /// - AA bet EV = fold% * pot + call% * (pot + bet) = 0.4286*10 + 0.5714*17.5 = 14.29
    /// - QJs (pure bluff) is indifferent: check EV = bet EV = 0
    /// - 88 facing the bet is indifferent: call EV = fold EV = 0
    #[test]
    fn ev_matches_theory_polarized_river() {
        let mut g0 = [0f32; 169];
        g0[0] = 1.0; // AA
        g0[2 * 13 + 3] = 1.0; // QJs
        let mut g1 = [0f32; 169];
        g1[6 * 13 + 6] = 1.0; // 88
        let mut g = make_game("Ah7d2c9s3d", &g0, &g1, |cfg| {
            cfg.max_bets = 1;
        });
        g.run_iterations(800);
        let label = |p: usize, h: usize| -> String {
            let (c1, c2) = g.hands[p].cards[h];
            crate::combos::grid_label(crate::combos::grid_index(c1, c2))
        };
        // root (OOP): action 0 = check, 1 = bet
        let r = g.walk(&[]).unwrap();
        let (evs, compat) = g.action_evs(r.node, &r.reach[1]);
        for h in 0..g.hands[0].len() {
            let ev_check = evs[0][h] / compat[h];
            let ev_bet = evs[1][h] / compat[h];
            if label(0, h) == "AA" {
                assert!(
                    (ev_bet - 14.29).abs() < 0.5,
                    "AA bet EV should be ~14.29, got {}",
                    ev_bet
                );
            } else {
                assert!(ev_check.abs() < 0.25, "QJs check EV ~0, got {}", ev_check);
                assert!(ev_bet.abs() < 0.4, "QJs bet EV ~0, got {}", ev_bet);
            }
        }
        // after the bet (IP): action 0 = fold, 1 = call
        let r2 = g.walk(&[1]).unwrap();
        assert_eq!(r2.adds[0], 7.5); // bettor committed 7.5
        assert_eq!(r2.adds[1], 0.0);
        let (evs2, compat2) = g.action_evs(r2.node, &r2.reach[0]);
        for h in 0..g.hands[1].len() {
            let ev_fold = evs2[0][h] / compat2[h];
            let ev_call = evs2[1][h] / compat2[h];
            assert!(ev_fold.abs() < 1e-6, "fold EV must be 0, got {}", ev_fold);
            assert!(ev_call.abs() < 0.4, "88 call EV ~0, got {}", ev_call);
        }
    }

    #[test]
    fn walk_and_remap() {
        let g = make_game("AhKh2h7s", &uniform_grid(), &uniform_grid(), |_| {});
        let r = g.walk(&[0, 0, 8]).unwrap(); // card 8 = 4c
        assert_eq!(r.board.len(), 5);
        let map = g.hand_remap(0, &r.perm);
        assert!(map.iter().any(|&m| m != u16::MAX));
    }

    #[test]
    fn equity_sane() {
        let mut g0 = [0f32; 169];
        g0[0] = 1.0; // AA only
        let g = make_game("Kh7d2c", &g0, &uniform_grid(), |_| {});
        let eq = g.equity(&parse_board("Kh7d2c").unwrap(), 0, &g.hands[1].weights);
        let avg: f32 = eq.iter().sum::<f32>() / eq.len() as f32;
        assert!(avg > 0.78 && avg < 0.93, "AA equity vs random: {}", avg);
    }

    #[test]
    fn ev_zero_sum_at_root() {
        let mut g = make_game("AhKd2c7s9d", &uniform_grid(), &uniform_grid(), |_| {});
        g.run_iterations(100);
        let dead = g.tree.dead as f64;
        let mut totals = [0f64; 2];
        let mut pair_weight = 0f64;
        {
            let compat = compat_sums(&g.hands[0], &g.hands[1], &g.same_combo[0], &g.hands[1].weights);
            for h in 0..g.hands[0].len() {
                pair_weight += (g.hands[0].weights[h] * compat[h]) as f64;
            }
        }
        for p in 0..2usize {
            let ctx = g.ctx();
            let v = ev_walk(&ctx, &g.store, g.tree.root, p, &g.hands[1 - p].weights);
            for h in 0..g.hands[p].len() {
                totals[p] += (g.hands[p].weights[h] as f64) * (v[h] as f64);
            }
        }
        let sum = (totals[0] + totals[1]) / pair_weight;
        assert!(
            (sum - dead).abs() < 0.02 * dead,
            "EV sum {} vs dead {}",
            sum,
            dead
        );
    }
}
