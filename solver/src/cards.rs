//! Card representation: card = rank * 4 + suit.
//! rank: 0 = deuce .. 12 = ace. suit: 0=club, 1=diamond, 2=heart, 3=spade.

pub type Card = u8;

pub const RANK_CHARS: [char; 13] = [
    '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A',
];
pub const SUIT_CHARS: [char; 4] = ['c', 'd', 'h', 's'];

#[inline]
pub fn rank(c: Card) -> u8 {
    c >> 2
}

#[inline]
pub fn suit(c: Card) -> u8 {
    c & 3
}

#[inline]
pub fn make_card(rank: u8, suit: u8) -> Card {
    (rank << 2) | suit
}

pub fn card_to_string(c: Card) -> String {
    let mut s = String::with_capacity(2);
    s.push(RANK_CHARS[rank(c) as usize]);
    s.push(SUIT_CHARS[suit(c) as usize]);
    s
}

pub fn parse_card(s: &str) -> Option<Card> {
    let mut chars = s.chars();
    let rc = chars.next()?.to_ascii_uppercase();
    let sc = chars.next()?.to_ascii_lowercase();
    if chars.next().is_some() {
        return None;
    }
    let r = RANK_CHARS.iter().position(|&c| c == rc)? as u8;
    let su = SUIT_CHARS.iter().position(|&c| c == sc)? as u8;
    Some(make_card(r, su))
}

/// Parse a board string like "AhKd2c" or "Ah Kd 2c".
pub fn parse_board(s: &str) -> Option<Vec<Card>> {
    let cleaned: String = s.chars().filter(|c| !c.is_whitespace() && *c != ',').collect();
    if cleaned.len() % 2 != 0 {
        return None;
    }
    let bytes = cleaned.as_bytes();
    let mut out = Vec::new();
    for i in (0..bytes.len()).step_by(2) {
        let cs = std::str::from_utf8(&bytes[i..i + 2]).ok()?;
        out.push(parse_card(cs)?);
    }
    // reject duplicates
    for i in 0..out.len() {
        for j in (i + 1)..out.len() {
            if out[i] == out[j] {
                return None;
            }
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        for c in 0..52u8 {
            assert_eq!(parse_card(&card_to_string(c)), Some(c));
        }
    }

    #[test]
    fn board_parsing() {
        let b = parse_board("AhKd2c").unwrap();
        assert_eq!(b.len(), 3);
        assert_eq!(card_to_string(b[0]), "Ah");
        assert_eq!(card_to_string(b[2]), "2c");
        assert!(parse_board("AhAh2c").is_none());
    }
}
