// Every colour threshold on the site, in one place.
//
// The boards paint with these numbers and the "How to read" page prints them,
// so the explanation can never fall out of step with the colours. Scales run
// best → worst: each array holds the floor of the first four tiers, and
// anything under the last floor is the fifth. ERA and WHIP have no array of
// their own: they are coloured through their half of FORM.
(function () {
  const S = window.SCALES = {
    TIERS: ['#16a34a', '#b1c882', '#ffc000', '#ff8100', '#ff2200'],
    NAMES: ['Elite', 'Above avg', 'Average', 'Below avg', 'Poor'],
    NO_DATA: '#9ca3af',

    OPS: [.900, .750, .600, .450],
    // Cut where the OPS tiers fall among qualified hitters, so a green average
    // and a green OPS mean the same thing
    AVG: [.300, .255, .205, .160],
    OBP: [.380, .330, .275, .250],
    SLG: [.545, .425, .315, .270],

    FORM: [75, 60, 40, 25],
    // FORM's two halves: 100 at "best", 0 at "worst", a straight line between
    ERA: { best: 1.50, worst: 6.00 },
    WHIP: { best: 0.80, worst: 2.00 },

    SAVE_PCT: [.90, .80, .70, .60],
    STRAND_PCT: [.85, .75, .65, .55],   // inherited runners left on base
    WIN_PCT: [.650, .550, .450, .350],
    HOLDS: [15, 8],                     // two tiers only; fewer is grey

    PERCENTILE: [75, 60, 40, 25],       // profile bars
    MLB_RANK: [10, 30, 75],             // "Nth in MLB" lines: four colours, no red
  };

  // The tier a value falls in, higher being better
  S.tier = (v, cuts) => { const i = cuts.findIndex(c => v >= c); return S.TIERS[i < 0 ? cuts.length : i]; };
  // A league rank in fifths of the field: 1–6, 7–12… of 30
  S.rank = (rank, total) => S.TIERS[Math.min(4, Math.floor((rank - 1) / (total / 5)))];
})();
