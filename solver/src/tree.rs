//! Postflop game tree construction.
//!
//! Heads-up, OOP = player 0, IP = player 1. All chip amounts are in big
//! blinds. `dead` is the starting pot; `a[p]` tracks chips added postflop.

use crate::cards::Card;
use crate::iso::{group_chance_cards, IDENTITY};
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct TreeConfig {
    pub board: Vec<Card>,
    /// starting pot in bb
    pub pot: f32,
    /// effective remaining stack per player in bb
    pub stack: f32,
    /// bet sizes (fraction of pot) per street: [flop, turn, river]
    pub bet_sizes: [Vec<f32>; 3],
    /// raise sizes (fraction of pot-after-call) per street
    pub raise_sizes: [Vec<f32>; 3],
    /// max bets+raises per street (1 = bet only, 2 = bet+raise, ...)
    pub max_bets: u8,
    /// if remaining stack <= threshold * pot, an explicit all-in is added (0 = off)
    pub allin_threshold: f32,
    /// distributed-solve partition of the tree
    pub partition: Partition,
}

/// How this instance partitions the game for distributed solving. Subtrees
/// hang off the first-level chance nodes (e.g. turn cards for a flop spot);
/// the subtree under canonical card `c` belongs to worker `c % k`.
/// All instances allocate storage for the starting street (workers keep a
/// mirror of it for query serving).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Partition {
    /// own everything (single-instance solve)
    None,
    /// own only the starting street
    Main { workers: u8 },
    /// own the starting street mirror + subtrees with rep % k == idx
    Worker { workers: u8, idx: u8 },
}

impl Partition {
    pub fn owns_subtree(&self, first_rep: Card) -> bool {
        match self {
            Partition::None => true,
            Partition::Main { .. } => false,
            Partition::Worker { workers, idx } => first_rep % workers == *idx,
        }
    }
}

/// sentinel offset for action nodes whose storage lives in another instance
pub const UNOWNED: usize = usize::MAX;

pub const KIND_FOLD: u8 = 0;
pub const KIND_CHECK: u8 = 1;
pub const KIND_CALL: u8 = 2;
pub const KIND_BET: u8 = 3;
pub const KIND_RAISE: u8 = 4;
pub const KIND_ALLIN: u8 = 5;

#[derive(Clone, Debug)]
pub struct ActionDesc {
    pub kind: u8,
    /// additional chips committed by the actor
    pub chips: f32,
}

#[derive(Clone)]
pub struct ChanceChild {
    pub child: u32,
    pub rep: Card,
    /// all orbit members (including rep) with the suit permutation mapping
    /// that member's world onto the rep's world
    pub orbit: Vec<(Card, [u8; 4])>,
}

pub enum Node {
    Action {
        player: u8,
        street: u8,
        /// total pot (dead + both adds) when acting
        pot: f32,
        to_call: f32,
        actions: Vec<ActionDesc>,
        children: Vec<u32>,
        /// offset into the per-player storage arena
        store_off: usize,
        /// ordinal of this action node (for per-node scale arrays)
        scale_idx: u32,
    },
    Chance {
        /// 1 / (unseen cards - 2), the true per-card deal probability
        norm: f32,
        children: Vec<ChanceChild>,
    },
    Fold {
        folder: u8,
        /// folder's postflop contribution
        folder_add: f32,
    },
    Showdown {
        /// each player's postflop contribution (equal)
        contrib: f32,
        /// index into the river info table
        river_idx: u32,
    },
}

pub struct Tree {
    pub cfg: TreeConfig,
    pub nodes: Vec<Node>,
    pub root: u32,
    /// dead money = starting pot
    pub dead: f32,
    /// distinct river boards reached by showdowns
    pub river_boards: Vec<[Card; 5]>,
    /// storage arena sizes (f32 count) per player
    pub store_len: [usize; 2],
    pub num_action_nodes: usize,
}

#[derive(Clone)]
struct BuildState {
    board: Vec<Card>,
    a: [f32; 2],
    to_call: f32,
    street_bets: u8,
    to_act: u8,
    last_inc: f32,
    /// canonical card of the first-level chance child we are under, if any
    first_rep: Option<Card>,
}

struct Builder {
    cfg: TreeConfig,
    n_hands: [usize; 2],
    nodes: Vec<Node>,
    river_map: HashMap<u64, u32>,
    river_boards: Vec<[Card; 5]>,
    store_len: [usize; 2],
    num_action_nodes: usize,
}

fn board_key(board: &[Card]) -> u64 {
    let mut sorted: Vec<Card> = board.to_vec();
    sorted.sort_unstable();
    let mut k = 0u64;
    for &c in &sorted {
        k = (k << 6) | (c as u64);
    }
    k
}

impl Builder {
    fn street(&self, board: &[Card]) -> usize {
        board.len() - 3
    }

    fn push(&mut self, n: Node) -> u32 {
        self.nodes.push(n);
        (self.nodes.len() - 1) as u32
    }

    fn showdown(&mut self, st: &BuildState) -> u32 {
        debug_assert!((st.a[0] - st.a[1]).abs() < 1e-4);
        debug_assert_eq!(st.board.len(), 5);
        let key = board_key(&st.board);
        let river_idx = if let Some(&i) = self.river_map.get(&key) {
            i
        } else {
            let i = self.river_boards.len() as u32;
            let arr: [Card; 5] = st.board.clone().try_into().unwrap();
            self.river_boards.push(arr);
            self.river_map.insert(key, i);
            i
        };
        self.push(Node::Showdown {
            contrib: st.a[0],
            river_idx,
        })
    }

    /// Deal the next street card; `next` builds each child subtree.
    fn chance(&mut self, st: &BuildState, locked: bool) -> u32 {
        let norm = 1.0 / (52 - st.board.len() - 4) as f32;
        let grouping = group_chance_cards(&st.board);
        let mut children = Vec::with_capacity(grouping.reps.len());
        // collect orbits
        let mut orbits: Vec<Vec<(Card, [u8; 4])>> = vec![Vec::new(); grouping.reps.len()];
        for c in 0..52u8 {
            let ri = grouping.rep_of[c as usize];
            if ri != u8::MAX {
                let perm = if grouping.reps[ri as usize] == c {
                    IDENTITY
                } else {
                    grouping.perm_to_rep[c as usize]
                };
                orbits[ri as usize].push((c, perm));
            }
        }
        let is_first_level = st.first_rep.is_none();
        for (i, &rep) in grouping.reps.iter().enumerate() {
            let mut child_st = st.clone();
            child_st.board.push(rep);
            child_st.to_call = 0.0;
            child_st.street_bets = 0;
            child_st.last_inc = 0.0;
            child_st.to_act = 0;
            if is_first_level {
                child_st.first_rep = Some(rep);
            }
            let child = if locked {
                // betting is closed (all-in): keep dealing or show down
                if child_st.board.len() == 5 {
                    self.showdown(&child_st)
                } else {
                    self.chance(&child_st, true)
                }
            } else {
                self.action(&child_st)
            };
            children.push(ChanceChild {
                child,
                rep,
                orbit: std::mem::take(&mut orbits[i]),
            });
        }
        self.push(Node::Chance { norm, children })
    }

    /// Street is complete with equal contributions: advance or show down.
    fn street_done(&mut self, st: &BuildState) -> u32 {
        let remaining = self.cfg.stack - st.a[0];
        if remaining <= 1e-6 && st.board.len() < 5 {
            return self.chance(st, true);
        }
        if st.board.len() == 5 {
            self.showdown(st)
        } else {
            self.chance(st, false)
        }
    }

    fn action(&mut self, st: &BuildState) -> u32 {
        let street = self.street(&st.board);
        let p = st.to_act as usize;
        let opp = 1 - p;
        let pot_now = self.cfg.dead_pot() + st.a[0] + st.a[1];
        let remaining = self.cfg.stack - st.a[p];

        let mut actions: Vec<ActionDesc> = Vec::new();
        let mut child_states: Vec<(BuildState, u8)> = Vec::new(); // (state, transition)
        // transition: 0 = next action node, 1 = street done, 2 = fold, 3 = deal-out (both allin)

        let add_bet = |actions: &mut Vec<ActionDesc>,
                           child_states: &mut Vec<(BuildState, u8)>,
                           chips: f32,
                           kind: u8| {
            // dedupe by amount
            if actions
                .iter()
                .any(|a| a.kind >= KIND_BET && (a.chips - chips).abs() < 0.01)
            {
                return;
            }
            let mut ns = st.clone();
            ns.a[p] += chips;
            ns.to_call = chips - st.to_call;
            ns.street_bets += 1;
            ns.last_inc = chips - st.to_call;
            ns.to_act = opp as u8;
            actions.push(ActionDesc { kind, chips });
            child_states.push((ns, 0));
        };

        if st.to_call <= 1e-6 {
            // check
            let mut ns = st.clone();
            if p == 1 {
                actions.push(ActionDesc {
                    kind: KIND_CHECK,
                    chips: 0.0,
                });
                child_states.push((ns, 1)); // both checked -> street done
            } else {
                ns.to_act = 1;
                actions.push(ActionDesc {
                    kind: KIND_CHECK,
                    chips: 0.0,
                });
                child_states.push((ns, 0));
            }
            // bets
            if remaining > 1e-6 && st.street_bets < self.cfg.max_bets {
                for &f in &self.cfg.bet_sizes[street].clone() {
                    let amt = (f * pot_now).max(1.0).min(remaining);
                    let kind = if (amt - remaining).abs() < 1e-6 {
                        KIND_ALLIN
                    } else {
                        KIND_BET
                    };
                    add_bet(&mut actions, &mut child_states, amt, kind);
                }
                if self.cfg.allin_threshold > 0.0 && remaining <= self.cfg.allin_threshold * pot_now
                {
                    add_bet(&mut actions, &mut child_states, remaining, KIND_ALLIN);
                }
            }
        } else {
            // fold
            actions.push(ActionDesc {
                kind: KIND_FOLD,
                chips: 0.0,
            });
            child_states.push((st.clone(), 2));
            // call
            {
                let mut ns = st.clone();
                ns.a[p] += st.to_call;
                ns.to_call = 0.0;
                actions.push(ActionDesc {
                    kind: KIND_CALL,
                    chips: st.to_call,
                });
                let both_allin = self.cfg.stack - ns.a[p] <= 1e-6;
                if both_allin && ns.board.len() < 5 {
                    child_states.push((ns, 3));
                } else {
                    child_states.push((ns, 1));
                }
            }
            // raises
            if remaining > st.to_call + 1e-6 && st.street_bets < self.cfg.max_bets {
                let pot_after_call = pot_now + st.to_call;
                for &f in &self.cfg.raise_sizes[street].clone() {
                    let beyond = (f * pot_after_call).max(st.last_inc).max(1.0);
                    let total = (st.to_call + beyond).min(remaining);
                    let kind = if (total - remaining).abs() < 1e-6 {
                        KIND_ALLIN
                    } else {
                        KIND_RAISE
                    };
                    add_bet(&mut actions, &mut child_states, total, kind);
                }
                if self.cfg.allin_threshold > 0.0 && remaining <= self.cfg.allin_threshold * pot_now
                {
                    add_bet(&mut actions, &mut child_states, remaining, KIND_ALLIN);
                }
            }
        }

        let n_actions = actions.len();
        let owned = match st.first_rep {
            None => true, // starting street: every instance allocates it
            Some(rep) => self.cfg.partition.owns_subtree(rep),
        };
        let store_off = if owned {
            let off = self.store_len[p];
            self.store_len[p] += n_actions * self.n_hands[p];
            off
        } else {
            UNOWNED
        };
        let scale_idx = self.num_action_nodes as u32;
        self.num_action_nodes += 1;

        let mut children = Vec::with_capacity(n_actions);
        for (ns, trans) in child_states {
            let child = match trans {
                0 => self.action(&ns),
                1 => self.street_done(&ns),
                2 => self.push(Node::Fold {
                    folder: p as u8,
                    folder_add: ns.a[p],
                }),
                3 => self.chance(&ns, true),
                _ => unreachable!(),
            };
            children.push(child);
        }

        self.push(Node::Action {
            player: p as u8,
            street: street as u8,
            pot: pot_now,
            to_call: st.to_call,
            actions,
            children,
            store_off,
            scale_idx,
        })
    }
}

impl TreeConfig {
    fn dead_pot(&self) -> f32 {
        self.pot
    }
}

pub fn build_tree(cfg: TreeConfig, n_hands: [usize; 2]) -> Tree {
    assert!(cfg.board.len() >= 3 && cfg.board.len() <= 5);
    let dead = cfg.pot;
    let mut b = Builder {
        cfg: cfg.clone(),
        n_hands,
        nodes: Vec::new(),
        river_map: HashMap::new(),
        river_boards: Vec::new(),
        store_len: [0, 0],
        num_action_nodes: 0,
    };
    let st = BuildState {
        board: cfg.board.clone(),
        a: [0.0, 0.0],
        to_call: 0.0,
        street_bets: 0,
        to_act: 0,
        last_inc: 0.0,
        first_rep: None,
    };
    let root = b.action(&st);
    Tree {
        cfg,
        nodes: b.nodes,
        root,
        dead,
        river_boards: b.river_boards,
        store_len: b.store_len,
        num_action_nodes: b.num_action_nodes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cards::parse_board;

    fn basic_cfg(board: &str) -> TreeConfig {
        TreeConfig {
            board: parse_board(board).unwrap(),
            pot: 5.5,
            stack: 97.5,
            bet_sizes: [vec![0.66], vec![0.75], vec![0.75]],
            raise_sizes: [vec![0.6], vec![0.6], vec![0.6]],
            max_bets: 3,
            allin_threshold: 1.5,
            partition: Partition::None,
        }
    }

    #[test]
    fn river_tree_builds() {
        let t = build_tree(basic_cfg("AhKd2c7s9d"), [100, 100]);
        assert!(t.num_action_nodes > 0);
        assert_eq!(t.river_boards.len(), 1);
        // root is OOP with check + bet available
        match &t.nodes[t.root as usize] {
            Node::Action {
                player, actions, ..
            } => {
                assert_eq!(*player, 0);
                assert!(actions.len() >= 2);
                assert_eq!(actions[0].kind, KIND_CHECK);
            }
            _ => panic!("root must be an action node"),
        }
    }

    #[test]
    fn turn_tree_has_chance() {
        let t = build_tree(basic_cfg("AhKd2c7s"), [50, 50]);
        let has_chance = t.nodes.iter().any(|n| matches!(n, Node::Chance { .. }));
        assert!(has_chance);
        assert!(t.river_boards.len() > 1);
    }

    #[test]
    fn chance_orbits_cover_deck() {
        let t = build_tree(basic_cfg("AhKh2h7s"), [50, 50]);
        for n in &t.nodes {
            if let Node::Chance { children, .. } = n {
                let total: usize = children.iter().map(|c| c.orbit.len()).sum();
                assert_eq!(total, 52 - 4); // all dealable cards covered
            }
        }
    }

    #[test]
    fn allin_lines_lock_betting() {
        // tiny stack: bet sizes clamp to all-in quickly
        let mut cfg = basic_cfg("AhKd2c7s9d");
        cfg.stack = 3.0;
        let t = build_tree(cfg, [10, 10]);
        // every showdown has equal contributions <= stack
        for n in &t.nodes {
            if let Node::Showdown { contrib, .. } = n {
                assert!(*contrib <= 3.0 + 1e-6);
            }
        }
    }

    #[test]
    fn fold_amounts_consistent() {
        let t = build_tree(basic_cfg("AhKd2c7s9d"), [10, 10]);
        for n in &t.nodes {
            if let Node::Fold { folder_add, .. } = n {
                assert!(*folder_add >= 0.0 && *folder_add <= 97.5 + 1e-6);
            }
        }
    }
}
