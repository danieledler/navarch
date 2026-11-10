//! Claude's own unread list: the sessions its sidebar marks as having a reply you haven't seen,
//! including "Mark as unread". The desktop app keeps it in its Local Storage, a Chromium LevelDB
//! (`~/Library/Application Support/Claude/Local Storage/leveldb`), as the zustand store
//! `epitaxy-unread-v1`: `{"state":{"unreadIds":["local_…"],"explicitUnreadIds":[…]},"version":0}`.
//! Internal and undocumented, so when it can't be read the scanner falls back to timestamps.
//!
//! Strictly read-only: we never open the database (that takes its LOCK and may write). We parse
//! its tables (`.ldb`, snappy-compressed blocks) and write-ahead logs (`.log`) ourselves and keep
//! the record of the key with the highest sequence number. Tables never change once written, so
//! each is parsed once; a log is parsed again only when its size or mtime changes.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

/// Local Storage key: origin, NUL, then the key name prefixed with 1 (Latin-1).
const KEY: &[u8] = b"_https://claude.ai\x00\x01epitaxy-unread-v1";
/// LevelDB table footer magic, little-endian.
const TABLE_MAGIC: [u8; 8] = 0xdb4775248b80fb57u64.to_le_bytes();
const LOG_BLOCK: usize = 32768;

/// The newest record of KEY in a file: sequence number and value (None = deleted).
type Rec = Option<(u64, Option<Vec<u8>>)>;

pub struct UnreadWatch {
    dir: PathBuf,
    /// file name -> (len, mtime, newest record of KEY in it)
    files: HashMap<String, (u64, Option<SystemTime>, Rec)>,
    ids: Option<HashSet<String>>,
    /// Files changed since `ids` was last computed.
    dirty: bool,
}

impl UnreadWatch {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, files: HashMap::new(), ids: None, dirty: false }
    }

    /// Claude's unread session ids as of the last `refresh`, or None when the list can't be read.
    pub fn ids(&self) -> Option<&HashSet<String>> {
        self.ids.as_ref()
    }

    /// Re-reads the files that changed since the last call.
    pub fn refresh(&mut self) {
        let Ok(rd) = fs::read_dir(&self.dir) else {
            self.files.clear();
            self.ids = None;
            return;
        };
        let mut seen = HashSet::new();
        let mut failed = false;
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let table = name.ends_with(".ldb") || name.ends_with(".sst");
            if !table && !name.ends_with(".log") {
                continue;
            }
            // Gone already: compaction deletes the files it has merged.
            let Ok(md) = e.metadata() else { continue };
            let (len, mtime) = (md.len(), md.modified().ok());
            seen.insert(name.clone());
            if matches!(self.files.get(&name), Some((l, m, _)) if *l == len && *m == mtime) {
                continue;
            }
            let rec = match fs::read(e.path()) {
                Ok(d) if table => table_rec(&d),
                Ok(d) => Some(log_rec(&d)),
                Err(_) => None,
            };
            match rec {
                Some(rec) => {
                    self.files.insert(name, (len, mtime, rec));
                    self.dirty = true;
                }
                // Vanished or still being written: try again next time, keep the last answer.
                None => failed = true,
            }
        }
        let before = self.files.len();
        self.files.retain(|n, _| seen.contains(n));
        self.dirty |= self.files.len() != before;
        if self.dirty && !failed {
            self.ids = self.compute();
            self.dirty = false;
        }
    }

    fn compute(&self) -> Option<HashSet<String>> {
        let (_, value) = self.files.values().filter_map(|(_, _, r)| r.as_ref()).max_by_key(|(seq, _)| *seq)?;
        parse_ids(&decode(value.as_deref()?)?)
    }
}

/// A Local Storage value: a leading 0 means UTF-16LE, 1 means Latin-1.
fn decode(v: &[u8]) -> Option<String> {
    match v.split_first()? {
        (0, rest) => {
            let units: Vec<u16> = rest.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            String::from_utf16(&units).ok()
        }
        (1, rest) => Some(rest.iter().map(|&b| b as char).collect()),
        _ => None,
    }
}

fn parse_ids(json: &str) -> Option<HashSet<String>> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let state = v.get("state")?;
    state.get("unreadIds")?.as_array()?;
    let mut ids = HashSet::new();
    for k in ["unreadIds", "explicitUnreadIds"] {
        if let Some(a) = state.get(k).and_then(|a| a.as_array()) {
            ids.extend(a.iter().filter_map(|x| x.as_str().map(String::from)));
        }
    }
    Some(ids)
}

fn keep(best: &mut Rec, seq: u64, v: Option<&[u8]>) {
    if best.as_ref().is_none_or(|(s, _)| seq >= *s) {
        *best = Some((seq, v.map(<[u8]>::to_vec)));
    }
}

fn varint(b: &[u8], i: &mut usize) -> Option<u64> {
    let mut r = 0u64;
    let mut shift = 0;
    loop {
        let c = *b.get(*i)?;
        *i += 1;
        if shift >= 64 {
            return None;
        }
        r |= u64::from(c & 0x7f) << shift;
        shift += 7;
        if c < 0x80 {
            return Some(r);
        }
    }
}

fn le_u32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at.checked_add(4)?)?.try_into().ok()?))
}

fn le_u64(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_le_bytes(b.get(at..at.checked_add(8)?)?.try_into().ok()?))
}

// ---------------- tables ----------------

/// A block's contents, uncompressed. Each block is followed by a type byte (0 raw, 1 snappy) and a CRC.
fn block(d: &[u8], off: u64, size: u64) -> Option<Cow<'_, [u8]>> {
    let off = usize::try_from(off).ok()?;
    let end = off.checked_add(usize::try_from(size).ok()?)?;
    let raw = d.get(off..end)?;
    match *d.get(end)? {
        0 => Some(Cow::Borrowed(raw)),
        1 => snap::raw::Decoder::new().decompress_vec(raw).ok().map(Cow::Owned),
        _ => None,
    }
}

/// Calls `f` for each entry of a block (prefix-compressed keys, then the restart array).
fn entries(b: &[u8], mut f: impl FnMut(&[u8], &[u8])) -> Option<()> {
    let restarts = le_u32(b, b.len().checked_sub(4)?)? as usize;
    let end = b.len().checked_sub(4 + 4 * restarts)?;
    let mut i = 0;
    let mut key = Vec::new();
    while i < end {
        let shared = varint(b, &mut i)? as usize;
        let own = varint(b, &mut i)? as usize;
        let vlen = varint(b, &mut i)? as usize;
        if shared > key.len() {
            return None;
        }
        key.truncate(shared);
        key.extend_from_slice(b.get(i..i.checked_add(own)?)?);
        i += own;
        let v = b.get(i..i.checked_add(vlen)?)?;
        i += vlen;
        f(&key, v);
    }
    Some(())
}

/// The newest record of KEY in a table, or None when the file isn't a complete table.
fn table_rec(d: &[u8]) -> Option<Rec> {
    let foot = d.get(d.len().checked_sub(48)?..)?;
    if foot[40..] != TABLE_MAGIC {
        return None;
    }
    let mut i = 0;
    varint(foot, &mut i)?; // metaindex handle
    varint(foot, &mut i)?;
    let (off, size) = (varint(foot, &mut i)?, varint(foot, &mut i)?);
    let index = block(d, off, size)?;
    let mut best = None;
    let mut ok = true;
    entries(&index, |_, handle| {
        let mut j = 0;
        let data = varint(handle, &mut j).zip(varint(handle, &mut j)).and_then(|(o, s)| block(d, o, s));
        let parsed = data.and_then(|b| {
            entries(&b, |k, v| {
                // Internal key: user key, then 8 bytes of (sequence << 8 | type), type 1 = value.
                if k.len() == KEY.len() + 8 && k.starts_with(KEY) {
                    let tag = le_u64(k, KEY.len()).unwrap_or(0);
                    keep(&mut best, tag >> 8, ((tag & 0xff) == 1).then_some(v));
                }
            })
        });
        ok &= parsed.is_some();
    })?;
    ok.then_some(best)
}

// ---------------- logs ----------------

/// The newest record of KEY in a write-ahead log. A torn tail (Claude still writing) is ignored.
fn log_rec(d: &[u8]) -> Rec {
    let mut best = None;
    let mut buf = Vec::new();
    let mut in_frag = false;
    let mut i = 0;
    while i + 7 <= d.len() {
        let left = LOG_BLOCK - i % LOG_BLOCK;
        if left < 7 {
            i += left; // block trailer too short for a header
            continue;
        }
        let len = u16::from_le_bytes([d[i + 4], d[i + 5]]) as usize;
        let typ = d[i + 6];
        if typ == 0 && len == 0 {
            i += left; // preallocated zeros
            continue;
        }
        let Some(frag) = d.get(i + 7..i + 7 + len) else { break };
        i += 7 + len;
        match typ {
            1 => {
                batch(frag, &mut best);
                in_frag = false;
            }
            2 => {
                buf.clear();
                buf.extend_from_slice(frag);
                in_frag = true;
            }
            3 if in_frag => buf.extend_from_slice(frag),
            4 if in_frag => {
                buf.extend_from_slice(frag);
                batch(&buf, &mut best);
                in_frag = false;
            }
            _ => in_frag = false,
        }
    }
    best
}

/// A write batch: sequence (u64), count (u32), then records of tag (1 put, 0 delete), key, value.
fn batch(b: &[u8], best: &mut Rec) -> Option<()> {
    let seq = le_u64(b, 0)?;
    let count = le_u32(b, 8)?;
    let mut j = 12;
    for n in 0..u64::from(count) {
        let tag = *b.get(j)?;
        j += 1;
        let klen = varint(b, &mut j)? as usize;
        let k = b.get(j..j.checked_add(klen)?)?;
        j += klen;
        let v = match tag {
            1 => {
                let vlen = varint(b, &mut j)? as usize;
                let v = b.get(j..j.checked_add(vlen)?)?;
                j += vlen;
                Some(v)
            }
            0 => None,
            _ => return None,
        };
        if k == KEY {
            keep(best, seq + n, v);
        }
    }
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put_varint(out: &mut Vec<u8>, mut v: u64) {
        while v >= 0x80 {
            out.push((v as u8) | 0x80);
            v >>= 7;
        }
        out.push(v as u8);
    }

    fn latin1(json: &str) -> Vec<u8> {
        let mut v = vec![1];
        v.extend_from_slice(json.as_bytes());
        v
    }

    fn utf16(json: &str) -> Vec<u8> {
        let mut v = vec![0];
        v.extend(json.encode_utf16().flat_map(u16::to_le_bytes));
        v
    }

    /// A one-block log holding one batch per (seq, value); None writes a delete.
    fn log_file(batches: &[(u64, Option<Vec<u8>>)]) -> Vec<u8> {
        let mut out = Vec::new();
        for (seq, v) in batches {
            let mut b = seq.to_le_bytes().to_vec();
            b.extend_from_slice(&2u32.to_le_bytes());
            // An unrelated key first, so the KEY record sits at seq + 1.
            b.push(1);
            put_varint(&mut b, 3);
            b.extend_from_slice(b"foo");
            put_varint(&mut b, 1);
            b.push(b'x');
            b.push(if v.is_some() { 1 } else { 0 });
            put_varint(&mut b, KEY.len() as u64);
            b.extend_from_slice(KEY);
            if let Some(v) = v {
                put_varint(&mut b, v.len() as u64);
                b.extend_from_slice(v);
            }
            out.extend_from_slice(&[0, 0, 0, 0]); // CRC (not checked)
            out.extend_from_slice(&(b.len() as u16).to_le_bytes());
            out.push(1); // FULL
            out.extend_from_slice(&b);
        }
        out
    }

    fn block_bytes(kvs: &[(Vec<u8>, Vec<u8>)]) -> Vec<u8> {
        let mut b = Vec::new();
        for (k, v) in kvs {
            put_varint(&mut b, 0);
            put_varint(&mut b, k.len() as u64);
            put_varint(&mut b, v.len() as u64);
            b.extend_from_slice(k);
            b.extend_from_slice(v);
        }
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend_from_slice(&1u32.to_le_bytes());
        b
    }

    /// Appends a block with its trailer and returns its handle.
    fn push_block(out: &mut Vec<u8>, contents: &[u8], snappy: bool) -> Vec<u8> {
        let off = out.len();
        let body = if snappy { snap::raw::Encoder::new().compress_vec(contents).unwrap() } else { contents.to_vec() };
        out.extend_from_slice(&body);
        out.push(u8::from(snappy));
        out.extend_from_slice(&[0, 0, 0, 0]);
        let mut h = Vec::new();
        put_varint(&mut h, off as u64);
        put_varint(&mut h, body.len() as u64);
        h
    }

    fn table_file(seq: u64, v: Option<Vec<u8>>) -> Vec<u8> {
        let mut ikey = KEY.to_vec();
        ikey.extend_from_slice(&((seq << 8) | u64::from(v.is_some())).to_le_bytes());
        let mut out = Vec::new();
        let data = push_block(&mut out, &block_bytes(&[(ikey.clone(), v.unwrap_or_default())]), true);
        let meta = push_block(&mut out, &block_bytes(&[]), false);
        let index = push_block(&mut out, &block_bytes(&[(ikey, data)]), true);
        let mut foot = [meta, index].concat();
        foot.resize(40, 0);
        foot.extend_from_slice(&TABLE_MAGIC);
        out.extend_from_slice(&foot);
        out
    }

    const A: &str = r#"{"state":{"unreadIds":["local_a"],"explicitUnreadIds":["local_x"]},"version":0}"#;
    const B: &str = r#"{"state":{"unreadIds":["local_b"],"explicitUnreadIds":[]},"version":0}"#;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("navarch-unread-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn ids(w: &UnreadWatch) -> Option<Vec<String>> {
        w.ids().map(|s| {
            let mut v: Vec<String> = s.iter().cloned().collect();
            v.sort();
            v
        })
    }

    #[test]
    fn newest_record_wins_across_tables_and_logs() {
        let d = dir("newest");
        let mut w = UnreadWatch::new(d.clone());
        w.refresh();
        assert_eq!(ids(&w), None, "no files, no list");

        fs::write(d.join("000005.ldb"), table_file(10, Some(latin1(A)))).unwrap();
        w.refresh();
        assert_eq!(ids(&w), Some(vec!["local_a".into(), "local_x".into()]));

        // A log with a newer UTF-16 value overrides the table.
        fs::write(d.join("000007.log"), log_file(&[(19, Some(latin1(A))), (20, Some(utf16(B)))])).unwrap();
        w.refresh();
        assert_eq!(ids(&w), Some(vec!["local_b".into()]));

        // A torn tail record (Claude mid-write) changes nothing.
        let mut torn = log_file(&[(19, Some(latin1(A))), (20, Some(utf16(B)))]);
        torn.extend_from_slice(&log_file(&[(30, Some(latin1(A)))])[..20]);
        fs::write(d.join("000007.log"), torn).unwrap();
        w.refresh();
        assert_eq!(ids(&w), Some(vec!["local_b".into()]));

        // Compaction: the log is folded into a new table and removed.
        fs::write(d.join("000009.ldb"), table_file(21, Some(utf16(B)))).unwrap();
        fs::remove_file(d.join("000007.log")).unwrap();
        w.refresh();
        assert_eq!(ids(&w), Some(vec!["local_b".into()]));

        // A half-written table keeps the last answer until it's complete.
        let full = table_file(40, Some(latin1(A)));
        fs::write(d.join("000011.ldb"), &full[..full.len() - 10]).unwrap();
        w.refresh();
        assert_eq!(ids(&w), Some(vec!["local_b".into()]));
        fs::write(d.join("000011.ldb"), &full).unwrap();
        w.refresh();
        assert_eq!(ids(&w), Some(vec!["local_a".into(), "local_x".into()]));

        // A newer delete means the list is gone: fall back.
        fs::write(d.join("000012.log"), log_file(&[(50, None)])).unwrap();
        w.refresh();
        assert_eq!(ids(&w), None);

        fs::remove_dir_all(&d).unwrap();
        w.refresh();
        assert_eq!(ids(&w), None, "store gone");
    }

    #[test]
    fn unexpected_value_shape_falls_back() {
        assert!(parse_ids(r#"{"state":{"ids":[]},"version":1}"#).is_none());
        assert_eq!(parse_ids(r#"{"state":{"unreadIds":[]}}"#), Some(HashSet::new()));
        assert_eq!(decode(&[2, b'{']), None);
    }
}
