use std::collections::HashSet;

use filex_contracts::{AppError, RemoteState};

pub const CLIPBOARD_FILE_PATH_LIMIT: usize = 256;
const MAX_CLIPBOARD_PATH_BYTES: usize = 4_096;

pub(crate) fn clipboard_error(code: &str) -> AppError {
    AppError {
        code: code.to_owned(),
        message_key: match code {
            "CLIPBOARD_FILES_WRITE_FAILED" => "errors.clipboardFilesWriteFailed",
            _ => "errors.clipboardFilesReadFailed",
        }
        .to_owned(),
        retryable: true,
        remote_state: RemoteState::NotApplicable,
        field: None,
    }
}

pub(crate) fn normalize_clipboard_paths(paths: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for raw in paths {
        if raw.is_empty() || raw.len() > MAX_CLIPBOARD_PATH_BYTES || raw.contains('\0') {
            continue;
        }
        if seen.insert(raw.clone()) {
            normalized.push(raw);
            if normalized.len() >= CLIPBOARD_FILE_PATH_LIMIT {
                break;
            }
        }
    }
    normalized
}

#[allow(dead_code)]
pub(crate) fn strip_windows_verbatim_prefix(path: &str) -> String {
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    if let Some(rest) = path.strip_prefix(r"\\?\")
        && rest.as_bytes().get(1) == Some(&b':')
    {
        return rest.to_owned();
    }
    path.to_owned()
}

#[allow(dead_code)]
pub(crate) fn encode_windows_dropfiles_wide(paths: &[String]) -> Vec<u8> {
    // DROPFILES header: pFiles (20), pt.x (0), pt.y (0), fNC (0), fWide (1).
    let mut out = Vec::with_capacity(22 + paths.len() * 64);
    out.extend_from_slice(&20u32.to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&1i32.to_le_bytes());
    for path in paths {
        for unit in path.encode_utf16() {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        out.extend_from_slice(&0u16.to_le_bytes());
    }
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

#[allow(dead_code)]
pub(crate) fn parse_file_uri(uri: &str) -> Option<String> {
    let trimmed = uri.trim();
    let rest = if let Some(path) = trimmed.strip_prefix("file://localhost/") {
        format!("/{path}")
    } else {
        let path = trimmed.strip_prefix("file:///")?;
        format!("/{path}")
    };
    let decoded = percent_decode_utf8(&rest)?;
    #[cfg(target_os = "windows")]
    let normalized = {
        let bytes = decoded.as_bytes();
        if bytes.len() >= 3
            && bytes[0] == b'/'
            && bytes[1].is_ascii_alphabetic()
            && bytes[2] == b':'
        {
            decoded[1..].replace('/', "\\")
        } else {
            decoded
        }
    };
    #[cfg(not(target_os = "windows"))]
    let normalized = decoded;
    if normalized.is_empty()
        || normalized.len() > MAX_CLIPBOARD_PATH_BYTES
        || normalized.contains('\0')
    {
        return None;
    }
    Some(normalized)
}

#[allow(dead_code)]
pub(crate) fn parse_file_uri_list(raw: &str) -> Vec<String> {
    let paths = raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(parse_file_uri);
    normalize_clipboard_paths(paths)
}

#[allow(dead_code)]
pub(crate) fn parse_gnome_copied_files(raw: &str) -> Vec<String> {
    let mut lines = raw.lines().map(str::trim).filter(|line| !line.is_empty());
    let Some(action) = lines.next() else {
        return Vec::new();
    };
    if action != "copy" && action != "cut" {
        return Vec::new();
    }
    normalize_clipboard_paths(lines.filter_map(parse_file_uri))
}

#[allow(dead_code)]
pub(crate) fn encode_file_uri_list(paths: &[String]) -> String {
    let mut encoded = Vec::with_capacity(paths.len());
    for path in paths {
        let mut uri = String::from("file://");
        for byte in path.as_bytes() {
            if is_unreserved_uri_byte(*byte) || *byte == b'/' {
                uri.push(*byte as char);
            } else {
                uri.push('%');
                uri.push(hex_upper(byte >> 4));
                uri.push(hex_upper(byte & 0x0f));
            }
        }
        encoded.push(uri);
    }
    encoded.join("\r\n")
}

fn is_unreserved_uri_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~')
}

fn hex_upper(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        10..=15 => (b'A' + (nibble - 10)) as char,
        _ => '0',
    }
}

fn percent_decode_utf8(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let hi = from_hex(bytes[index + 1])?;
            let lo = from_hex(bytes[index + 2])?;
            let decoded = (hi << 4) | lo;
            if decoded == 0 {
                return None;
            }
            out.push(decoded);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn from_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn validate_write_paths(paths: &[String]) -> Result<Vec<String>, AppError> {
    let normalized = normalize_clipboard_paths(paths.iter().cloned());
    if normalized.is_empty() {
        return Err(clipboard_error("CLIPBOARD_FILES_WRITE_FAILED"));
    }
    let mut validated = Vec::with_capacity(normalized.len());
    for raw in normalized {
        let (canonical_entry, _) = crate::canonical_local_entry(&raw)
            .map_err(|_| clipboard_error("CLIPBOARD_FILES_WRITE_FAILED"))?;
        let metadata = std::fs::symlink_metadata(&canonical_entry)
            .map_err(|_| clipboard_error("CLIPBOARD_FILES_WRITE_FAILED"))?;
        if metadata.file_type().is_symlink() {
            return Err(clipboard_error("CLIPBOARD_FILES_WRITE_FAILED"));
        }
        let path_string = canonical_entry.to_string_lossy().into_owned();
        #[cfg(target_os = "windows")]
        let path_string = strip_windows_verbatim_prefix(&path_string);
        validated.push(path_string);
    }
    Ok(validated)
}

#[cfg(target_os = "windows")]
mod platform {
    use std::{
        ffi::{OsString, c_void},
        os::windows::ffi::OsStringExt,
        ptr, thread,
        time::Duration,
    };

    use filex_contracts::{AppError, ClipboardFileSnapshot, ClipboardFileWriteResult};

    use super::{
        CLIPBOARD_FILE_PATH_LIMIT, clipboard_error, encode_windows_dropfiles_wide,
        normalize_clipboard_paths,
    };

    const CF_HDROP: u32 = 15;
    const GMEM_MOVEABLE: u32 = 0x0002;
    const GMEM_ZEROINIT: u32 = 0x0040;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn OpenClipboard(hwnd_new_owner: *mut c_void) -> i32;
        fn CloseClipboard() -> i32;
        fn EmptyClipboard() -> i32;
        fn IsClipboardFormatAvailable(format: u32) -> i32;
        fn GetClipboardData(format: u32) -> *mut c_void;
        fn SetClipboardData(format: u32, mem: *mut c_void) -> *mut c_void;
        fn GetClipboardSequenceNumber() -> u32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GlobalLock(mem: *mut c_void) -> *mut c_void;
        fn GlobalUnlock(mem: *mut c_void) -> i32;
        fn GlobalAlloc(flags: u32, bytes: usize) -> *mut c_void;
        fn GlobalFree(mem: *mut c_void) -> *mut c_void;
    }

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn DragQueryFileW(hdrop: *mut c_void, file_index: u32, file_buf: *mut u16, cch: u32)
        -> u32;
    }

    struct OpenClipboardGuard;

    impl OpenClipboardGuard {
        fn open(error_code: &str) -> Result<Self, AppError> {
            for attempt in 0..5 {
                // SAFETY: Passing NULL opens the clipboard for the current thread.
                if unsafe { OpenClipboard(ptr::null_mut()) } != 0 {
                    return Ok(Self);
                }
                if attempt < 4 {
                    thread::sleep(Duration::from_millis(5));
                }
            }
            Err(clipboard_error(error_code))
        }
    }

    impl Drop for OpenClipboardGuard {
        fn drop(&mut self) {
            // SAFETY: Guard is only constructed after OpenClipboard succeeded.
            unsafe {
                CloseClipboard();
            }
        }
    }

    struct GlobalLockGuard {
        handle: *mut c_void,
        ptr: *mut c_void,
    }

    impl GlobalLockGuard {
        fn lock(handle: *mut c_void, error_code: &str) -> Result<Self, AppError> {
            // SAFETY: `handle` is a valid HGLOBAL allocated via GlobalAlloc.
            let ptr = unsafe { GlobalLock(handle) };
            if ptr.is_null() {
                return Err(clipboard_error(error_code));
            }
            Ok(Self { handle, ptr })
        }
    }

    impl Drop for GlobalLockGuard {
        fn drop(&mut self) {
            // SAFETY: Paired with successful GlobalLock on `self.handle`.
            unsafe {
                GlobalUnlock(self.handle);
            }
        }
    }

    struct OwnedGlobalAllocGuard {
        handle: *mut c_void,
        owned: bool,
    }

    impl OwnedGlobalAllocGuard {
        fn alloc(bytes: usize) -> Result<Self, AppError> {
            // SAFETY: Allocating movable zero-initialized clipboard buffer.
            let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes) };
            if handle.is_null() {
                return Err(clipboard_error("CLIPBOARD_FILES_WRITE_FAILED"));
            }
            Ok(Self {
                handle,
                owned: true,
            })
        }

        fn disarm(&mut self) {
            self.owned = false;
        }
    }

    impl Drop for OwnedGlobalAllocGuard {
        fn drop(&mut self) {
            if self.owned && !self.handle.is_null() {
                // SAFETY: `self.handle` was not handed to SetClipboardData.
                unsafe {
                    GlobalFree(self.handle);
                }
            }
        }
    }

    pub(super) fn read_native_clipboard_files() -> Result<ClipboardFileSnapshot, AppError> {
        // SAFETY: GetClipboardSequenceNumber requires no parameters and has no preconditions.
        let sequence = u64::from(unsafe { GetClipboardSequenceNumber() });
        let _clipboard = OpenClipboardGuard::open("CLIPBOARD_FILES_READ_FAILED")?;
        // SAFETY: Clipboard is open via `_clipboard`.
        if unsafe { IsClipboardFormatAvailable(CF_HDROP) } == 0 {
            return Ok(ClipboardFileSnapshot {
                paths: Vec::new(),
                sequence: Some(sequence),
                supported: true,
            });
        }
        // SAFETY: Clipboard is open and CF_HDROP format is available.
        let hdrop = unsafe { GetClipboardData(CF_HDROP) };
        if hdrop.is_null() {
            return Ok(ClipboardFileSnapshot {
                paths: Vec::new(),
                sequence: Some(sequence),
                supported: true,
            });
        }
        // SAFETY: `hdrop` is a clipboard-owned HDROP handle valid while clipboard remains open.
        let count = unsafe { DragQueryFileW(hdrop, u32::MAX, ptr::null_mut(), 0) };
        let capped = count.min(CLIPBOARD_FILE_PATH_LIMIT as u32);
        let mut raw_paths = Vec::with_capacity(capped as usize);
        for index in 0..capped {
            // SAFETY: Query required character count for `index`.
            let len = unsafe { DragQueryFileW(hdrop, index, ptr::null_mut(), 0) };
            if len == 0 || len > 4_096 {
                continue;
            }
            let mut buffer = vec![0u16; (len as usize) + 1];
            // SAFETY: `buffer` has `len + 1` UTF-16 code units.
            let written = unsafe { DragQueryFileW(hdrop, index, buffer.as_mut_ptr(), len + 1) };
            if written > 0 && (written as usize) <= len as usize {
                let path = OsString::from_wide(&buffer[..(written as usize)])
                    .to_string_lossy()
                    .into_owned();
                raw_paths.push(path);
            }
        }
        Ok(ClipboardFileSnapshot {
            paths: normalize_clipboard_paths(raw_paths),
            sequence: Some(sequence),
            supported: true,
        })
    }

    pub(super) fn write_native_clipboard_files(
        paths: &[String],
    ) -> Result<ClipboardFileWriteResult, AppError> {
        let payload = encode_windows_dropfiles_wide(paths);
        let mut alloc = OwnedGlobalAllocGuard::alloc(payload.len())?;
        {
            let lock = GlobalLockGuard::lock(alloc.handle, "CLIPBOARD_FILES_WRITE_FAILED")?;
            // SAFETY: `lock.ptr` points to a newly allocated buffer of `payload.len()` bytes.
            unsafe {
                ptr::copy_nonoverlapping(payload.as_ptr(), lock.ptr.cast::<u8>(), payload.len());
            }
        }
        {
            let _clipboard = OpenClipboardGuard::open("CLIPBOARD_FILES_WRITE_FAILED")?;
            // SAFETY: Clipboard is open via `_clipboard`.
            if unsafe { EmptyClipboard() } == 0 {
                return Err(clipboard_error("CLIPBOARD_FILES_WRITE_FAILED"));
            }
            // SAFETY: Clipboard is open and empty; `alloc.handle` is unlocked.
            if unsafe { SetClipboardData(CF_HDROP, alloc.handle) }.is_null() {
                return Err(clipboard_error("CLIPBOARD_FILES_WRITE_FAILED"));
            }
            alloc.disarm();
        }
        // SAFETY: Sequence number read after closing clipboard reflects the new write.
        let sequence = u64::from(unsafe { GetClipboardSequenceNumber() });
        Ok(ClipboardFileWriteResult {
            written: true,
            sequence: Some(sequence),
        })
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };

    use filex_contracts::{AppError, ClipboardFileSnapshot, ClipboardFileWriteResult};
    use serde::Deserialize;

    use super::{CLIPBOARD_FILE_PATH_LIMIT, clipboard_error, normalize_clipboard_paths};

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MacClipboardOutput {
        change_count: u64,
        paths: Vec<String>,
    }

    const READ_JXA: &str = r#"
ObjC.import('AppKit');
ObjC.import('Foundation');
var pb = $.NSPasteboard.generalPasteboard;
var items = pb.pasteboardItems;
var paths = [];
if (items) {
  var count = Math.min(items.count, 256);
  for (var i = 0; i < count; i++) {
    var item = items.objectAtIndex(i);
    var urlStr = item.stringForType('public.file-url');
    if (urlStr) {
      var url = $.NSURL.URLWithString(urlStr);
      if (url && url.isFileURL && url.path) {
        paths.push(ObjC.unwrap(url.path));
      }
    }
  }
}
JSON.stringify({ changeCount: Number(pb.changeCount), paths: paths });
"#;

    const WRITE_JXA: &str = r#"
ObjC.import('AppKit');
ObjC.import('Foundation');
var inputData = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
var inputStr = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(inputData, $.NSUTF8StringEncoding));
var paths = JSON.parse(inputStr || '[]');
var urls = $.NSMutableArray.alloc.init;
for (var i = 0; i < paths.length; i++) {
  urls.addObject($.NSURL.fileURLWithPath(paths[i]));
}
var pb = $.NSPasteboard.generalPasteboard;
pb.clearContents;
var ok = pb.writeObjects(urls);
JSON.stringify({ written: Boolean(ok), sequence: Number(pb.changeCount) });
"#;

    pub(super) fn read_native_clipboard_files() -> Result<ClipboardFileSnapshot, AppError> {
        let output = Command::new("osascript")
            .args(["-l", "JavaScript", "-e", READ_JXA])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .map_err(|_| clipboard_error("CLIPBOARD_FILES_READ_FAILED"))?;
        if !output.status.success() {
            return Err(clipboard_error("CLIPBOARD_FILES_READ_FAILED"));
        }
        let parsed: MacClipboardOutput = serde_json::from_slice(&output.stdout)
            .map_err(|_| clipboard_error("CLIPBOARD_FILES_READ_FAILED"))?;
        Ok(ClipboardFileSnapshot {
            paths: normalize_clipboard_paths(
                parsed.paths.into_iter().take(CLIPBOARD_FILE_PATH_LIMIT),
            ),
            sequence: Some(parsed.change_count),
            supported: true,
        })
    }

    pub(super) fn write_native_clipboard_files(
        paths: &[String],
    ) -> Result<ClipboardFileWriteResult, AppError> {
        let payload = serde_json::to_vec(paths)
            .map_err(|_| clipboard_error("CLIPBOARD_FILES_WRITE_FAILED"))?;
        let mut child = Command::new("osascript")
            .args(["-l", "JavaScript", "-e", WRITE_JXA])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| clipboard_error("CLIPBOARD_FILES_WRITE_FAILED"))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(&payload)
                .map_err(|_| clipboard_error("CLIPBOARD_FILES_WRITE_FAILED"))?;
        }
        let output = child
            .wait_with_output()
            .map_err(|_| clipboard_error("CLIPBOARD_FILES_WRITE_FAILED"))?;
        if !output.status.success() {
            return Err(clipboard_error("CLIPBOARD_FILES_WRITE_FAILED"));
        }
        let parsed: ClipboardFileWriteResult = serde_json::from_slice(&output.stdout)
            .map_err(|_| clipboard_error("CLIPBOARD_FILES_WRITE_FAILED"))?;
        Ok(parsed)
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };

    use filex_contracts::{AppError, ClipboardFileSnapshot, ClipboardFileWriteResult};

    use super::{encode_file_uri_list, parse_file_uri_list, parse_gnome_copied_files};

    fn run_read_command(program: &str, args: &[&str]) -> Option<String> {
        let output = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() || output.stdout.len() > 1_048_576 {
            return None;
        }
        String::from_utf8(output.stdout).ok()
    }

    pub(super) fn read_native_clipboard_files() -> Result<ClipboardFileSnapshot, AppError> {
        let has_wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
        if has_wayland {
            if let Some(types) = run_read_command("wl-paste", &["--list-types"]) {
                if types
                    .lines()
                    .any(|t| t.trim() == "x-special/gnome-copied-files")
                    && let Some(raw) = run_read_command(
                        "wl-paste",
                        &["--no-newline", "--type", "x-special/gnome-copied-files"],
                    )
                {
                    return Ok(ClipboardFileSnapshot {
                        paths: parse_gnome_copied_files(&raw),
                        sequence: None,
                        supported: true,
                    });
                }
                if types.lines().any(|t| t.trim() == "text/uri-list")
                    && let Some(raw) =
                        run_read_command("wl-paste", &["--no-newline", "--type", "text/uri-list"])
                {
                    return Ok(ClipboardFileSnapshot {
                        paths: parse_file_uri_list(&raw),
                        sequence: None,
                        supported: true,
                    });
                }
                return Ok(ClipboardFileSnapshot {
                    paths: Vec::new(),
                    sequence: None,
                    supported: true,
                });
            }
        }
        if let Some(targets) =
            run_read_command("xclip", &["-o", "-selection", "clipboard", "-t", "TARGETS"])
        {
            if targets
                .lines()
                .any(|t| t.trim() == "x-special/gnome-copied-files")
                && let Some(raw) = run_read_command(
                    "xclip",
                    &[
                        "-o",
                        "-selection",
                        "clipboard",
                        "-t",
                        "x-special/gnome-copied-files",
                    ],
                )
            {
                return Ok(ClipboardFileSnapshot {
                    paths: parse_gnome_copied_files(&raw),
                    sequence: None,
                    supported: true,
                });
            }
            if targets.lines().any(|t| t.trim() == "text/uri-list")
                && let Some(raw) = run_read_command(
                    "xclip",
                    &["-o", "-selection", "clipboard", "-t", "text/uri-list"],
                )
            {
                return Ok(ClipboardFileSnapshot {
                    paths: parse_file_uri_list(&raw),
                    sequence: None,
                    supported: true,
                });
            }
            return Ok(ClipboardFileSnapshot {
                paths: Vec::new(),
                sequence: None,
                supported: true,
            });
        }
        Ok(ClipboardFileSnapshot {
            paths: Vec::new(),
            sequence: None,
            supported: false,
        })
    }

    pub(super) fn write_native_clipboard_files(
        paths: &[String],
    ) -> Result<ClipboardFileWriteResult, AppError> {
        let uri_list = encode_file_uri_list(paths);
        let has_wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
        let candidates: &[(&str, &[&str])] = if has_wayland {
            &[
                ("wl-copy", &["--type", "text/uri-list"]),
                (
                    "xclip",
                    &["-i", "-selection", "clipboard", "-t", "text/uri-list"],
                ),
            ]
        } else {
            &[(
                "xclip",
                &["-i", "-selection", "clipboard", "-t", "text/uri-list"],
            )]
        };
        for (program, args) in candidates {
            if let Ok(mut child) = Command::new(program)
                .args(*args)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            {
                if let Some(mut stdin) = child.stdin.take()
                    && stdin.write_all(uri_list.as_bytes()).is_ok()
                {
                    drop(stdin);
                    if let Ok(status) = child.wait()
                        && status.success()
                    {
                        return Ok(ClipboardFileWriteResult {
                            written: true,
                            sequence: None,
                        });
                    }
                }
            }
        }
        Ok(ClipboardFileWriteResult {
            written: false,
            sequence: None,
        })
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod platform {
    use filex_contracts::{AppError, ClipboardFileSnapshot, ClipboardFileWriteResult};

    pub(super) fn read_native_clipboard_files() -> Result<ClipboardFileSnapshot, AppError> {
        Ok(ClipboardFileSnapshot {
            paths: Vec::new(),
            sequence: None,
            supported: false,
        })
    }

    pub(super) fn write_native_clipboard_files(
        _paths: &[String],
    ) -> Result<ClipboardFileWriteResult, AppError> {
        Ok(ClipboardFileWriteResult {
            written: false,
            sequence: None,
        })
    }
}

pub(crate) mod commands {
    use filex_contracts::{ClipboardFileSnapshot, ClipboardFileWriteResult, OperationResult};

    use super::{clipboard_error, platform, validate_write_paths};

    #[tauri::command]
    pub(crate) async fn read_clipboard_file_paths()
    -> Result<OperationResult<ClipboardFileSnapshot>, ()> {
        let outcome = tauri::async_runtime::spawn_blocking(platform::read_native_clipboard_files)
            .await
            .map_err(|_| ())
            .unwrap_or_else(|()| Err(clipboard_error("CLIPBOARD_FILES_READ_FAILED")));
        Ok(match outcome {
            Ok(snapshot) => OperationResult::success(snapshot),
            Err(error) => OperationResult::failure(error),
        })
    }

    #[tauri::command]
    pub(crate) async fn write_clipboard_file_paths(
        paths: Vec<String>,
    ) -> Result<OperationResult<ClipboardFileWriteResult>, ()> {
        let outcome = tauri::async_runtime::spawn_blocking(move || {
            let validated = validate_write_paths(&paths)?;
            platform::write_native_clipboard_files(&validated)
        })
        .await
        .map_err(|_| ())
        .unwrap_or_else(|()| Err(clipboard_error("CLIPBOARD_FILES_WRITE_FAILED")));
        Ok(match outcome {
            Ok(result) => OperationResult::success(result),
            Err(error) => OperationResult::failure(error),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CLIPBOARD_FILE_PATH_LIMIT, encode_file_uri_list, encode_windows_dropfiles_wide,
        normalize_clipboard_paths, parse_file_uri_list, parse_gnome_copied_files,
        strip_windows_verbatim_prefix,
    };

    #[test]
    fn normalizes_deduplicates_and_caps_clipboard_paths() {
        let mut input = vec![
            "".to_owned(),
            "bad\0path".to_owned(),
            "a.txt".to_owned(),
            "a.txt".to_owned(),
            "b.txt".to_owned(),
        ];
        for i in 0..300 {
            input.push(format!("item-{i}.txt"));
        }
        let result = normalize_clipboard_paths(input);
        assert_eq!(result.len(), CLIPBOARD_FILE_PATH_LIMIT);
        assert_eq!(result[0], "a.txt");
        assert_eq!(result[1], "b.txt");
    }

    #[test]
    fn strips_windows_verbatim_prefixes_when_safe() {
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\C:\Users\dev\app.tar.gz"),
            r"C:\Users\dev\app.tar.gz"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"\\?\UNC\fileserver\share\readme.txt"),
            r"\\fileserver\share\readme.txt"
        );
        assert_eq!(
            strip_windows_verbatim_prefix(r"D:\plain\file.txt"),
            r"D:\plain\file.txt"
        );
    }

    #[test]
    fn encodes_windows_dropfiles_wide_layout() {
        let encoded =
            encode_windows_dropfiles_wide(&[r"C:\a.txt".to_owned(), r"C:\中文".to_owned()]);
        assert_eq!(u32::from_le_bytes(encoded[0..4].try_into().unwrap()), 20);
        assert_eq!(i32::from_le_bytes(encoded[16..20].try_into().unwrap()), 1);

        let units: Vec<u16> = encoded[20..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        let expected: Vec<u16> = r"C:\a.txt"
            .encode_utf16()
            .chain([0])
            .chain(r"C:\中文".encode_utf16())
            .chain([0, 0])
            .collect();
        assert_eq!(units, expected);
    }

    #[test]
    fn parses_gnome_copied_files_and_uri_lists_safely() {
        let gnome = "copy\nfile:///home/ops/my%20file.txt\nfile:///home/ops/%E6%96%87%E6%A1%A3\n";
        let gnome_paths = parse_gnome_copied_files(gnome);
        assert_eq!(gnome_paths, vec!["/home/ops/my file.txt", "/home/ops/文档"]);

        let uri_list = "# comment\nfile:///tmp/one.log\r\nhttps://example.com/ignored\r\nfile:///tmp/two%2B2.log\r\n";
        assert_eq!(
            parse_file_uri_list(uri_list),
            vec!["/tmp/one.log", "/tmp/two+2.log"]
        );

        assert_eq!(
            parse_gnome_copied_files("invalid\nfile:///tmp/a"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn encodes_file_uri_list_with_percent_escaping() {
        let encoded = encode_file_uri_list(&["/home/ops/my file.txt".to_owned()]);
        assert_eq!(encoded, "file:///home/ops/my%20file.txt");
    }
}
