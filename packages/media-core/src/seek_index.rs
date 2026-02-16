//! Maps playback time (seconds) to 1-based segment index for pre-buffering and seek.
//! Uses exact segment durations when available, otherwise average duration.
//!
//! Reference: services/client/src/_reference/utils/seek-index.ts

/// Returns the 1-based segment index for the given time.
///
/// * `time_sec` - Current time in seconds
/// * `segment_count` - Total number of segments
/// * `duration_sec` - Total duration in seconds (used when segment_durations_sec is not provided)
/// * `segment_durations_sec` - Optional exact duration per segment in seconds
pub fn time_to_segment_index(
    time_sec: f64,
    segment_count: u32,
    duration_sec: f64,
    segment_durations_sec: Option<&[f64]>,
) -> u32 {
    if segment_count == 0 {
        return 1;
    }
    if time_sec <= 0.0 {
        return 1;
    }
    if time_sec >= duration_sec {
        return segment_count;
    }

    if let Some(durations) = segment_durations_sec
        && !durations.is_empty()
    {
        let mut acc = 0.0;
        for (i, &d) in durations.iter().enumerate() {
            acc += d;
            if time_sec < acc {
                return (i as u32) + 1;
            }
        }
        return segment_count;
    }

    let avg_seg_sec = duration_sec / (segment_count as f64);
    let index = (time_sec / avg_seg_sec).floor() as i64 + 1;
    let index = index.max(1).min(segment_count as i64);
    index as u32
}

/// Formats segment template with 1-based index (e.g. "chunk-0-%05d.m4s" -> "chunk-0-00001.m4s").
///
/// Supports `%d`, `%0Nd` (e.g. `%05d` for width 5, zero-padded).
pub fn format_segment_url(template: &str, index: u32) -> String {
    let index_str = index.to_string();
    let mut out = String::with_capacity(template.len() + index_str.len());
    let mut chars = template.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '%' {
            let _ = chars.next_if_eq(&'0'); // optional 0
            let mut width_str = String::new();
            while chars
                .peek()
                .copied()
                .map(|c| c.is_ascii_digit())
                .unwrap_or(false)
            {
                if let Some(d) = chars.next() {
                    width_str.push(d);
                }
            }
            if chars.next_if_eq(&'d').is_some() {
                let width: usize = width_str.parse().unwrap_or(5);
                let replaced = format!("{:0>width$}", index_str, width = width);
                out.push_str(&replaced);
            } else {
                out.push('%');
                out.push_str(&width_str);
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_to_segment_index_time_zero_returns_one() {
        assert_eq!(time_to_segment_index(0.0, 44, 246.0, None), 1);
    }

    #[test]
    fn time_to_segment_index_at_end_returns_segment_count() {
        assert_eq!(time_to_segment_index(246.0, 44, 246.0, None), 44);
        assert_eq!(time_to_segment_index(300.0, 44, 246.0, None), 44);
    }

    #[test]
    fn time_to_segment_index_midpoint_with_average_duration() {
        let idx = time_to_segment_index(123.0, 44, 246.0, None);
        assert!(idx >= 1 && idx <= 44);
        assert_eq!(idx, 23); // floor(123 / (246/44)) + 1 = 23
    }

    #[test]
    fn time_to_segment_index_uses_segment_durations_when_provided() {
        let durations = [5.0, 5.0, 10.0];
        assert_eq!(time_to_segment_index(0.0, 3, 20.0, Some(&durations)), 1);
        assert_eq!(time_to_segment_index(4.0, 3, 20.0, Some(&durations)), 1);
        assert_eq!(time_to_segment_index(5.0, 3, 20.0, Some(&durations)), 2);
        assert_eq!(time_to_segment_index(9.0, 3, 20.0, Some(&durations)), 2);
        assert_eq!(time_to_segment_index(15.0, 3, 20.0, Some(&durations)), 3);
        assert_eq!(time_to_segment_index(20.0, 3, 20.0, Some(&durations)), 3);
    }

    #[test]
    fn format_segment_url_formats_percent_05d() {
        assert_eq!(
            format_segment_url("chunk-0-%05d.m4s", 1),
            "chunk-0-00001.m4s"
        );
        assert_eq!(
            format_segment_url("chunk-0-%05d.m4s", 44),
            "chunk-0-00044.m4s"
        );
    }

    #[test]
    fn format_segment_url_formats_percent_03d() {
        assert_eq!(format_segment_url("chunk-%03d.m4s", 1), "chunk-001.m4s");
    }
}
