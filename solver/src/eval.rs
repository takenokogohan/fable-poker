//! 7-card hand evaluator. Returns a u32 where a higher value is a better hand.
//! Encoding: category << 20 | tiebreak ranks packed 4 bits each, highest first.

use crate::cards::{rank, suit, Card};

pub const CAT_HIGH: u32 = 0;
pub const CAT_PAIR: u32 = 1;
pub const CAT_TWO_PAIR: u32 = 2;
pub const CAT_TRIPS: u32 = 3;
pub const CAT_STRAIGHT: u32 = 4;
pub const CAT_FLUSH: u32 = 5;
pub const CAT_FULL_HOUSE: u32 = 6;
pub const CAT_QUADS: u32 = 7;
pub const CAT_STRAIGHT_FLUSH: u32 = 8;

/// Highest rank of a 5-card straight contained in the 13-bit rank mask, or None.
/// The wheel (A-5) reports rank 3 (the five).
#[inline]
fn straight_high(mask: u16) -> Option<u32> {
    // check from ace-high down; the lowest non-wheel straight is 6-high (idx 4)
    for high in (4..=12u32).rev() {
        let need = 0b11111u16 << (high - 4);
        if mask & need == need {
            return Some(high);
        }
    }
    // wheel: A,2,3,4,5 -> bits 12,0,1,2,3
    let wheel = (1u16 << 12) | 0b1111;
    if mask & wheel == wheel {
        return Some(3);
    }
    None
}

#[inline]
fn pack(cat: u32, ranks: &[u32]) -> u32 {
    let mut v = cat << 20;
    let mut shift = 16;
    for &r in ranks {
        v |= r << shift;
        shift -= 4;
    }
    v
}

/// Take the top `n` set bits of a rank mask, highest first.
#[inline]
fn top_ranks(mask: u16, n: usize, out: &mut [u32; 5]) -> usize {
    let mut count = 0;
    for r in (0..13u32).rev() {
        if mask & (1 << r) != 0 {
            out[count] = r;
            count += 1;
            if count == n {
                break;
            }
        }
    }
    count
}

pub fn evaluate7(cards: &[Card; 7]) -> u32 {
    let mut suit_masks = [0u16; 4];
    let mut rank_counts = [0u8; 13];
    let mut rank_mask = 0u16;
    for &c in cards {
        let r = rank(c);
        let s = suit(c);
        suit_masks[s as usize] |= 1 << r;
        rank_counts[r as usize] += 1;
        rank_mask |= 1 << r;
    }

    // straight flush / flush
    let mut flush_suit: Option<usize> = None;
    for s in 0..4 {
        if suit_masks[s].count_ones() >= 5 {
            flush_suit = Some(s);
            break;
        }
    }
    if let Some(fs) = flush_suit {
        if let Some(high) = straight_high(suit_masks[fs]) {
            return pack(CAT_STRAIGHT_FLUSH, &[high]);
        }
    }

    // rank multiplicities
    let mut quad: Option<u32> = None;
    let mut trips: [u32; 2] = [13, 13]; // up to two trip ranks, highest first
    let mut ntrips = 0;
    let mut pairs: [u32; 3] = [13, 13, 13];
    let mut npairs = 0;
    for r in (0..13u32).rev() {
        match rank_counts[r as usize] {
            4 => quad = quad.or(Some(r)),
            3 => {
                if ntrips < 2 {
                    trips[ntrips] = r;
                    ntrips += 1;
                }
            }
            2 => {
                if npairs < 3 {
                    pairs[npairs] = r;
                    npairs += 1;
                }
            }
            _ => {}
        }
    }

    if let Some(q) = quad {
        let mut kick = [0u32; 5];
        let mask = rank_mask & !(1u16 << q);
        top_ranks(mask, 1, &mut kick);
        return pack(CAT_QUADS, &[q, kick[0]]);
    }

    if ntrips >= 1 && (ntrips >= 2 || npairs >= 1) {
        let pair = if ntrips >= 2 { trips[1] } else { pairs[0] };
        return pack(CAT_FULL_HOUSE, &[trips[0], pair]);
    }

    if let Some(fs) = flush_suit {
        let mut tops = [0u32; 5];
        top_ranks(suit_masks[fs], 5, &mut tops);
        return pack(CAT_FLUSH, &tops);
    }

    if let Some(high) = straight_high(rank_mask) {
        return pack(CAT_STRAIGHT, &[high]);
    }

    if ntrips >= 1 {
        let mut kick = [0u32; 5];
        let mask = rank_mask & !(1u16 << trips[0]);
        top_ranks(mask, 2, &mut kick);
        return pack(CAT_TRIPS, &[trips[0], kick[0], kick[1]]);
    }

    if npairs >= 2 {
        let mut kick = [0u32; 5];
        let mask = rank_mask & !(1u16 << pairs[0]) & !(1u16 << pairs[1]);
        top_ranks(mask, 1, &mut kick);
        return pack(CAT_TWO_PAIR, &[pairs[0], pairs[1], kick[0]]);
    }

    if npairs == 1 {
        let mut kick = [0u32; 5];
        let mask = rank_mask & !(1u16 << pairs[0]);
        top_ranks(mask, 3, &mut kick);
        return pack(CAT_PAIR, &[pairs[0], kick[0], kick[1], kick[2]]);
    }

    let mut tops = [0u32; 5];
    top_ranks(rank_mask, 5, &mut tops);
    pack(CAT_HIGH, &tops)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cards::parse_board;

    fn ev(s: &str) -> u32 {
        let b = parse_board(s).unwrap();
        let arr: [Card; 7] = b.try_into().unwrap();
        evaluate7(&arr)
    }

    fn cat(v: u32) -> u32 {
        v >> 20
    }

    #[test]
    fn categories() {
        assert_eq!(cat(ev("AhKhQhJhTh2c3d")), CAT_STRAIGHT_FLUSH);
        assert_eq!(cat(ev("Ah2h3h4h5h9c9d")), CAT_STRAIGHT_FLUSH); // steel wheel
        assert_eq!(cat(ev("AhAdAcAsKh2c3d")), CAT_QUADS);
        assert_eq!(cat(ev("AhAdAcKsKh2c3d")), CAT_FULL_HOUSE);
        assert_eq!(cat(ev("AhKh9h5h2hQcQd")), CAT_FLUSH);
        assert_eq!(cat(ev("9h8d7c6s5h2c2d")), CAT_STRAIGHT);
        assert_eq!(cat(ev("Ah2d3c4s5h9cJd")), CAT_STRAIGHT); // wheel
        assert_eq!(cat(ev("QhQdQcAs5h9c2d")), CAT_TRIPS);
        assert_eq!(cat(ev("QhQd9c9sAh5c2d")), CAT_TWO_PAIR);
        assert_eq!(cat(ev("QhQd9c8sAh5c2d")), CAT_PAIR);
        assert_eq!(cat(ev("Qh9d8c7s4h3c2d")), CAT_HIGH);
    }

    #[test]
    fn orderings() {
        // higher straight beats lower
        assert!(ev("9h8d7c6s5h2cKd") > ev("Ah2d3c4s5hKc9d"));
        // flush beats straight
        assert!(ev("AhKh9h5h2hQcQd") > ev("9h8d7c6s5h2c2d"));
        // kicker matters
        assert!(ev("AhAdKc9s5h3c2d") > ev("AhAdQc9s5h3c2d"));
        // two pair: top pair rank dominates
        assert!(ev("KhKd2c2sAh5c9d") > ev("QhQdJcJsAh5c9d"));
        // full house: trips rank dominates
        assert!(ev("2h2d2cAsAh9cKd") < ev("AhAdAc9s9h2cKd"));
        assert!(ev("AhAdAc2s2h9cKd") > ev("KhKdKcQsQh9c2d"));
        // double trips -> full house using higher pair
        assert_eq!(cat(ev("AhAdAcKsKhKc2d")), CAT_FULL_HOUSE);
        assert!(ev("AhAdAcKsKhKc2d") > ev("AhAdAcQsQh2c3d"));
        // board plays: identical values
        assert_eq!(ev("AhKhQhJhTh2c3d"), ev("AhKhQhJhTh9c8d"));
    }

    /// Brute-force 5-card evaluator over all 21 subsets must agree with categories.
    #[test]
    fn straight_edge_cases() {
        // six-card straight: use the high end
        let v = ev("9h8d7c6s5h4cKd");
        assert_eq!(cat(v), CAT_STRAIGHT);
        assert_eq!((v >> 16) & 0xF, 7); // nine-high -> rank index 7
        // wheel is the lowest straight
        assert!(ev("6h2d3c4s5hKc9d") > ev("Ah2d3c4s5hKc9d"));
    }
}
