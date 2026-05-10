use chrono::{DateTime, SecondsFormat, Utc};
use std::time::SystemTime;

pub fn now_iso() -> String {
    system_time_to_iso(SystemTime::now())
}

pub fn system_time_to_iso(time: SystemTime) -> String {
    let timestamp = DateTime::<Utc>::from(time);
    timestamp.to_rfc3339_opts(SecondsFormat::Millis, true)
}
