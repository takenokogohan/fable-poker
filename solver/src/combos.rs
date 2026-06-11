//! Hole-card combo enumeration (1326 combos) and the 13x13 grid mapping.

use crate::cards::{make_card, rank, suit, Card};

pub const NUM_COMBOS: usize = 1326;

/// All 1326 combos as (hi, lo) with hi > lo (card index order).
pub fn all_combos() -> Vec<(Card, Card)> {
    let mut v = Vec::with_capacity(NUM_COMBOS);
    for hi in 1..52u8 {
        for lo in 0..hi {
            v.push((hi, lo));
        }
    }
    v
}

#[inline]
pub fn combo_index(hi: Card, lo: Card) -> usize {
    debug_assert!(hi > lo);
    (hi as usize * (hi as usize - 1)) / 2 + lo as usize
}

/// Index into the 169-cell grid for a combo.
/// Grid convention: cell = row * 13 + col with row/col indexed by rank DESCENDING
/// (0 = ace). row < col (upper-right) = suited, row > col = offsuit, diag = pair.
pub fn grid_index(hi: Card, lo: Card) -> usize {
    let (rh, rl) = (rank(hi), rank(lo));
    let (big, small) = if rh >= rl { (rh, rl) } else { (rl, rh) };
    let big_i = (12 - big) as usize; // ace -> 0
    let small_i = (12 - small) as usize;
    if rh == rl {
        big_i * 13 + big_i
    } else if suit(hi) == suit(lo) {
        big_i * 13 + small_i // suited: upper-right
    } else {
        small_i * 13 + big_i // offsuit: lower-left
    }
}

/// Human label for a grid cell, e.g. "AKs", "QQ", "T9o".
pub fn grid_label(cell: usize) -> String {
    let row = cell / 13;
    let col = cell % 13;
    let r1 = crate::cards::RANK_CHARS[12 - row.min(col)];
    let r2 = crate::cards::RANK_CHARS[12 - row.max(col)];
    if row == col {
        format!("{}{}", r1, r2)
    } else if row < col {
        format!("{}{}s", r1, r2)
    } else {
        format!("{}{}o", r1, r2)
    }
}

/// Expand 169 grid weights into 1326 combo weights (uniform within a cell),
/// zeroing combos that conflict with the given board.
pub fn expand_grid_weights(grid: &[f32; 169], board: &[Card]) -> Vec<f32> {
    let mut out = vec![0f32; NUM_COMBOS];
    let mut blocked = [false; 52];
    for &c in board {
        blocked[c as usize] = true;
    }
    for hi in 1..52u8 {
        for lo in 0..hi {
            if blocked[hi as usize] || blocked[lo as usize] {
                continue;
            }
            let w = grid[grid_index(hi, lo)];
            if w > 0.0 {
                out[combo_index(hi, lo)] = w;
            }
        }
    }
    out
}

/// A compact per-player hand list: the combos with positive weight.
#[derive(Clone)]
pub struct HandList {
    /// (hi, lo) cards of each hand
    pub cards: Vec<(Card, Card)>,
    /// initial weight of each hand
    pub weights: Vec<f32>,
    /// index into 1326-space for each hand
    pub combo_idx: Vec<usize>,
}

impl HandList {
    pub fn from_weights(weights1326: &[f32]) -> HandList {
        let mut cards = Vec::new();
        let mut weights = Vec::new();
        let mut combo_idx = Vec::new();
        for hi in 1..52u8 {
            for lo in 0..hi {
                let idx = combo_index(hi, lo);
                let w = weights1326[idx];
                if w > 0.0 {
                    cards.push((hi, lo));
                    weights.push(w);
                    combo_idx.push(idx);
                }
            }
        }
        HandList {
            cards,
            weights,
            combo_idx,
        }
    }

    pub fn len(&self) -> usize {
        self.cards.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cards.is_empty()
    }
}

/// Remap a combo through a suit permutation. perm[s] = new suit for old suit s.
pub fn permute_combo(hi: Card, lo: Card, perm: &[u8; 4]) -> (Card, Card) {
    let a = make_card(rank(hi), perm[suit(hi) as usize]);
    let b = make_card(rank(lo), perm[suit(lo) as usize]);
    if a > b {
        (a, b)
    } else {
        (b, a)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cards::parse_card;

    #[test]
    fn combo_index_is_dense() {
        let combos = all_combos();
        assert_eq!(combos.len(), NUM_COMBOS);
        for (i, &(hi, lo)) in combos.iter().enumerate() {
            assert_eq!(combo_index(hi, lo), i);
        }
    }

    #[test]
    fn grid_mapping() {
        let aa = (parse_card("As").unwrap(), parse_card("Ah").unwrap());
        assert_eq!(grid_label(grid_index(aa.0, aa.1)), "AA");
        let aks = (parse_card("As").unwrap(), parse_card("Ks").unwrap());
        assert_eq!(grid_label(grid_index(aks.0, aks.1)), "AKs");
        let ako = (parse_card("Ks").unwrap(), parse_card("Ah").unwrap());
        assert_eq!(grid_label(grid_index(ako.0, ako.1)), "AKo");
        let t9o = (parse_card("Td").unwrap(), parse_card("9c").unwrap());
        assert_eq!(grid_label(grid_index(t9o.0, t9o.1)), "T9o");
        let v72 = (parse_card("7d").unwrap(), parse_card("2d").unwrap());
        assert_eq!(grid_label(grid_index(v72.0, v72.1)), "72s");
    }

    #[test]
    fn cell_combo_counts() {
        // pairs: 6 combos, suited: 4, offsuit: 12
        let mut counts = [0u32; 169];
        for (hi, lo) in all_combos() {
            counts[grid_index(hi, lo)] += 1;
        }
        for cell in 0..169 {
            let row = cell / 13;
            let col = cell % 13;
            let expected = if row == col {
                6
            } else if row < col {
                4
            } else {
                12
            };
            assert_eq!(counts[cell], expected, "cell {}", grid_label(cell));
        }
    }

    #[test]
    fn expand_respects_board() {
        let mut grid = [0f32; 169];
        grid[0] = 1.0; // AA
        let board = vec![parse_card("As").unwrap()];
        let w = expand_grid_weights(&grid, &board);
        let total: f32 = w.iter().sum();
        assert_eq!(total, 3.0); // AhAd, AhAc, AdAc remain
    }
}
