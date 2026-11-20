//! `Math.log10` and `Math.cbrt` as JavaScript (V8) computes them.
//!
//! Neither is rounded correctly by anyone: each system's C library lands on
//! its own last digit, and V8 brings its own (fdlibm). A meter or a fader
//! position must be the number the Node companion sent, on every platform,
//! so these are fdlibm's routines and not `f64::log10` and `f64::cbrt`.
//! tests/fixtures/obs/{meter,fader}-position.json hold them to it.

fn high(x: f64) -> i32 {
    (x.to_bits() >> 32) as i32
}

fn low(x: f64) -> u32 {
    x.to_bits() as u32
}

fn with_high(x: f64, high: i32) -> f64 {
    f64::from_bits((u64::from(high as u32) << 32) | (x.to_bits() & 0xffff_ffff))
}

const TWO54: f64 = 1.801_439_850_948_198_4e16;

/// fdlibm's `__ieee754_log`.
#[allow(clippy::many_single_char_names, clippy::excessive_precision)]
fn log(mut x: f64) -> f64 {
    const LN2_HI: f64 = 6.931_471_803_691_238_164_90e-01;
    const LN2_LO: f64 = 1.908_214_929_270_587_700_02e-10;
    const LG1: f64 = 6.666_666_666_666_735_130e-01;
    const LG2: f64 = 3.999_999_999_940_941_908e-01;
    const LG3: f64 = 2.857_142_874_366_239_149e-01;
    const LG4: f64 = 2.222_219_843_214_978_396e-01;
    const LG5: f64 = 1.818_357_216_161_805_012e-01;
    const LG6: f64 = 1.531_383_769_920_937_332e-01;
    const LG7: f64 = 1.479_819_860_511_658_591e-01;

    let mut hx = high(x);
    let lx = low(x);
    let mut k: i32 = 0;
    if hx < 0x0010_0000 {
        if ((hx & 0x7fff_ffff) as u32 | lx) == 0 {
            return f64::NEG_INFINITY;
        }
        if hx < 0 {
            return f64::NAN;
        }
        k -= 54;
        x *= TWO54;
        hx = high(x);
    }
    if hx >= 0x7ff0_0000 {
        return x + x;
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000f_ffff;
    let mut i = (hx + 0x95f64) & 0x0010_0000;
    x = with_high(x, hx | (i ^ 0x3ff0_0000));
    k += i >> 20;
    let f = x - 1.0;
    let dk = f64::from(k);
    if (0x000f_ffff & (2 + hx)) < 3 {
        if f == 0.0 {
            if k == 0 {
                return 0.0;
            }
            return dk * LN2_HI + dk * LN2_LO;
        }
        let r = f * f * (0.5 - 0.333_333_333_333_333_33 * f);
        if k == 0 {
            return f - r;
        }
        return dk * LN2_HI - ((r - dk * LN2_LO) - f);
    }
    let s = f / (2.0 + f);
    let z = s * s;
    i = hx - 0x6147a;
    let w = z * z;
    let j = 0x6b851 - hx;
    let t1 = w * (LG2 + w * (LG4 + w * LG6));
    let t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    i |= j;
    let r = t2 + t1;
    if i > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 {
            f - (hfsq - s * (hfsq + r))
        } else {
            dk * LN2_HI - ((hfsq - (s * (hfsq + r) + dk * LN2_LO)) - f)
        }
    } else if k == 0 {
        f - s * (f - r)
    } else {
        dk * LN2_HI - ((s * (f - r) - dk * LN2_LO) - f)
    }
}

/// `Math.log10(x)`: fdlibm's `__ieee754_log10`, as V8 carries it.
// IVLN10 is fdlibm's own constant, digit for digit.
#[allow(clippy::excessive_precision, clippy::approx_constant)]
pub fn log10(mut x: f64) -> f64 {
    const IVLN10: f64 = 4.342_944_819_032_518_166_68e-01;
    const LOG10_2HI: f64 = 3.010_299_956_636_117_713_06e-01;
    const LOG10_2LO: f64 = 3.694_239_077_158_930_786_16e-13;

    let mut hx = high(x);
    let lx = low(x);
    let mut k: i32 = 0;
    if hx < 0x0010_0000 {
        if ((hx & 0x7fff_ffff) as u32 | lx) == 0 {
            return f64::NEG_INFINITY;
        }
        if hx < 0 {
            return f64::NAN;
        }
        k -= 54;
        x *= TWO54;
        hx = high(x);
    }
    if hx >= 0x7ff0_0000 {
        return x + x;
    }
    k += (hx >> 20) - 1023;
    let i = i32::from(k < 0);
    hx = (hx & 0x000f_ffff) | ((0x3ff - i) << 20);
    let y = f64::from(k + i);
    x = with_high(x, hx);
    let z = y * LOG10_2LO + IVLN10 * log(x);
    z + y * LOG10_2HI
}

/// `Math.cbrt(x)`: FreeBSD's `cbrt`, as V8 carries it.
#[allow(clippy::many_single_char_names, clippy::excessive_precision)]
pub fn cbrt(x: f64) -> f64 {
    const B1: u32 = 715_094_163;
    const B2: u32 = 696_219_795;
    const P0: f64 = 1.875_951_824_271_770_096_43;
    const P1: f64 = -1.884_979_795_433_771_698_75;
    const P2: f64 = 1.621_429_720_105_354_466_140;
    const P3: f64 = -0.758_397_934_778_766_047_437;
    const P4: f64 = 0.145_996_192_886_612_446_982;

    let bits = x.to_bits();
    let sign = ((bits >> 32) as u32) & 0x8000_0000;
    let hx = ((bits >> 32) as u32) ^ sign;
    if hx >= 0x7ff0_0000 {
        return x + x;
    }
    let from_words = |high: u32| f64::from_bits(u64::from(high) << 32);
    // A rough cube root, good to 5 bits.
    let mut t = if hx < 0x0010_0000 {
        if (hx | low(x)) == 0 {
            return x;
        }
        let scaled = TWO54 * x;
        let high = ((scaled.to_bits() >> 32) as u32) & 0x7fff_ffff;
        from_words(sign | (high / 3 + B2))
    } else {
        from_words(sign | (hx / 3 + B1))
    };
    // To 23 bits.
    let r = (t * t) * (t / x);
    t *= (P0 + r * (P1 + r * P2)) + ((r * r) * r) * (P3 + r * P4);
    // Rounded away from zero to 23 bits.
    t = f64::from_bits((t.to_bits().wrapping_add(0x8000_0000)) & 0xffff_ffff_c000_0000);
    // One step of Newton to 53 bits.
    let s = t * t;
    let r = x / s;
    let w = t + t;
    let r = (r - t) / (w + r);
    t + t * r
}
