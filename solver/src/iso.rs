//! Suit isomorphism for chance (turn/river) cards.
//!
//! When the starting ranges are suit-symmetric (they are: built from a 169
//! grid), deal cards that differ only by a suit permutation fixing the board
//! lead to strategically identical subtrees. We solve only one canonical card
//! per orbit, weighting it by the orbit size, and map queries for
//! non-canonical cards back through the permutation.

use crate::cards::{make_card, rank, suit, Card};

pub const IDENTITY: [u8; 4] = [0, 1, 2, 3];

fn all_suit_perms() -> Vec<[u8; 4]> {
    let mut perms = Vec::with_capacity(24);
    let mut p = [0u8, 1, 2, 3];
    // Heap's algorithm, iterative
    let mut c = [0usize; 4];
    perms.push(p);
    let mut i = 0;
    while i < 4 {
        if c[i] < i {
            if i % 2 == 0 {
                p.swap(0, i);
            } else {
                p.swap(c[i], i);
            }
            perms.push(p);
            c[i] += 1;
            i = 0;
        } else {
            c[i] = 0;
            i += 1;
        }
    }
    perms
}

#[inline]
pub fn permute_card(c: Card, perm: &[u8; 4]) -> Card {
    make_card(rank(c), perm[suit(c) as usize])
}

/// All suit permutations that map the board set onto itself.
pub fn board_fixing_perms(board: &[Card]) -> Vec<[u8; 4]> {
    let mut set = [false; 52];
    for &c in board {
        set[c as usize] = true;
    }
    all_suit_perms()
        .into_iter()
        .filter(|perm| board.iter().all(|&c| set[permute_card(c, perm) as usize]))
        .collect()
}

/// Composition: apply `first`, then `second`.
pub fn compose(second: &[u8; 4], first: &[u8; 4]) -> [u8; 4] {
    [
        second[first[0] as usize],
        second[first[1] as usize],
        second[first[2] as usize],
        second[first[3] as usize],
    ]
}

/// Grouping of candidate deal cards into isomorphism classes.
pub struct ChanceGrouping {
    /// canonical cards, sorted ascending
    pub reps: Vec<Card>,
    /// orbit size (multiplicity) for each rep, same order as `reps`
    pub mult: Vec<u32>,
    /// for every dealable card: (index into reps, perm mapping this card's
    /// world onto the rep's world). Non-dealable cards have rep_of = u8::MAX.
    pub rep_of: [u8; 52],
    pub perm_to_rep: [[u8; 4]; 52],
}

/// Group all cards not in `board` by isomorphism under perms fixing `board`.
pub fn group_chance_cards(board: &[Card]) -> ChanceGrouping {
    let perms = board_fixing_perms(board);
    let mut in_board = [false; 52];
    for &c in board {
        in_board[c as usize] = true;
    }
    let mut reps: Vec<Card> = Vec::new();
    let mut mult: Vec<u32> = Vec::new();
    let mut rep_of = [u8::MAX; 52];
    let mut perm_to_rep = [IDENTITY; 52];

    for c in 0..52u8 {
        if in_board[c as usize] {
            continue;
        }
        // canonical card = min over orbit
        let mut best = c;
        let mut best_perm = IDENTITY;
        for perm in &perms {
            let pc = permute_card(c, perm);
            if pc < best {
                best = pc;
                best_perm = *perm;
            }
        }
        if best == c {
            rep_of[c as usize] = reps.len() as u8;
            perm_to_rep[c as usize] = best_perm; // identity-equivalent on c
            reps.push(c);
            mult.push(1);
        } else {
            // best was visited earlier (cards scanned ascending)
            let ri = rep_of[best as usize];
            debug_assert!(ri != u8::MAX);
            rep_of[c as usize] = ri;
            perm_to_rep[c as usize] = best_perm;
            mult[ri as usize] += 1;
        }
    }
    ChanceGrouping {
        reps,
        mult,
        rep_of,
        perm_to_rep,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cards::parse_board;

    #[test]
    fn perm_count() {
        assert_eq!(all_suit_perms().len(), 24);
    }

    #[test]
    fn rainbow_flop_grouping() {
        // Ah Kd 2c: suits h,d,c each appear once; spade is free.
        // Perms fixing the board must fix h, d, c individually -> only identity
        // (s has nowhere else to go). So every turn card is its own class.
        let board = parse_board("AhKd2c").unwrap();
        let g = group_chance_cards(&board);
        assert_eq!(g.reps.len(), 49);
    }

    #[test]
    fn monotone_flop_grouping() {
        // Ah Kh 2h: three free suits c, d, s can permute freely.
        // Turn cards: 10 hearts remain distinct; other 39 cards group by rank
        // into 13 classes of 3.
        let board = parse_board("AhKh2h").unwrap();
        let g = group_chance_cards(&board);
        assert_eq!(g.reps.len(), 10 + 13);
        let total: u32 = g.mult.iter().sum();
        assert_eq!(total, 49);
    }

    #[test]
    fn two_tone_flop_grouping() {
        // Ah Kh 2c: c fixed, h fixed, d<->s swappable.
        // Hearts: 11 left, distinct. Clubs: 12 left, distinct.
        // Diamonds+spades: 26 cards in 13 classes of 2.
        let board = parse_board("AhKh2c").unwrap();
        let g = group_chance_cards(&board);
        assert_eq!(g.reps.len(), 11 + 12 + 13);
        let total: u32 = g.mult.iter().sum();
        assert_eq!(total, 49);
    }

    #[test]
    fn perm_maps_to_rep() {
        let board = parse_board("AhKh2c").unwrap();
        let g = group_chance_cards(&board);
        for c in 0..52u8 {
            if g.rep_of[c as usize] == u8::MAX {
                continue;
            }
            let rep = g.reps[g.rep_of[c as usize] as usize];
            assert_eq!(permute_card(c, &g.perm_to_rep[c as usize]), rep);
            // the perm must fix the board
            let mut set = [false; 52];
            for &b in &board {
                set[b as usize] = true;
            }
            for &b in &board {
                assert!(set[permute_card(b, &g.perm_to_rep[c as usize]) as usize]);
            }
        }
    }
}
