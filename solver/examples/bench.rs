//! Rough performance benchmark for a realistic SRP flop solve.

use solver::combos::expand_grid_weights;
use solver::engine::Game;
use solver::tree::{Partition, TreeConfig};
use std::time::Instant;

fn grid_from_cells(cells: &[usize]) -> [f32; 169] {
    let mut g = [0f32; 169];
    for &c in cells {
        g[c] = 1.0;
    }
    g
}

fn main() {
    // crude BTN-open-ish range (~40%) and BB-defend-ish range (~35%)
    let btn: Vec<usize> = (0..169)
        .filter(|&c| {
            let row = c / 13;
            let col = c % 13;
            if row == col {
                true // all pairs
            } else if row < col {
                col <= 9 || row <= 4 // suited
            } else {
                col <= 4 && row <= 8 // offsuit broadways-ish
            }
        })
        .collect();
    let bb: Vec<usize> = (0..169)
        .filter(|&c| {
            let row = c / 13;
            let col = c % 13;
            if row == col {
                row >= 2
            } else if row < col {
                true
            } else {
                col <= 3
            }
        })
        .collect();

    let board = solver::cards::parse_board(&std::env::args().nth(1).unwrap_or("Ks7h2d".into()))
        .expect("bad board");
    let cfg = TreeConfig {
        board: board.clone(),
        pot: 5.5,
        stack: 97.5,
        bet_sizes: [vec![0.33], vec![0.75], vec![0.75]],
        // "light" tree: no raises on turn/river (the UI default for flop solves)
        raise_sizes: [vec![0.6], vec![], vec![]],
        max_bets: 2,
        allin_threshold: 0.0,
        partition: Partition::None,
    };
    let w0 = expand_grid_weights(&grid_from_cells(&bb), &board);
    let w1 = expand_grid_weights(&grid_from_cells(&btn), &board);

    let t0 = Instant::now();
    let mut g = Game::new(cfg, &w0, &w1).unwrap();
    println!(
        "build: {:.2}s, hands: {}/{}, action nodes: {}, storage: {:.0} MB",
        t0.elapsed().as_secs_f64(),
        g.hands[0].len(),
        g.hands[1].len(),
        g.tree.num_action_nodes,
        (g.tree.store_len[0] + g.tree.store_len[1]) as f64 * 4.0 / 1e6
    );

    for chunk in 0..6 {
        let t = Instant::now();
        g.run_iterations(10);
        let it_time = t.elapsed().as_secs_f64();
        let t = Instant::now();
        let e = g.exploitability();
        println!(
            "iter {:>3}: {:.2}s/10it, expl {:.4} bb ({:.2}% pot), br {:.2}s",
            (chunk + 1) * 10,
            it_time,
            e,
            e / 5.5 * 100.0,
            t.elapsed().as_secs_f64()
        );
    }
}
