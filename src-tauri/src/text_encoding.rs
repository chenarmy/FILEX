use encoding_rs::{
    BIG5, EUC_JP, EUC_KR, Encoding, GB18030, GBK, SHIFT_JIS, UTF_8, UTF_16BE, UTF_16LE,
    WINDOWS_1252,
};
use filex_contracts::{AppError, RemoteState};

/// Resolves any supported file/terminal encoding label to its `encoding_rs` codec.
pub(crate) fn resolve_text_encoding(label: &str) -> Result<&'static Encoding, AppError> {
    match label.trim().to_ascii_lowercase().as_str() {
        "utf-8" | "utf8" => Ok(UTF_8),
        "utf-16le" | "utf16le" => Ok(UTF_16LE),
        "utf-16be" | "utf16be" => Ok(UTF_16BE),
        "gbk" => Ok(GBK),
        "gb18030" => Ok(GB18030),
        "big5" => Ok(BIG5),
        "shift_jis" | "shift-jis" | "sjis" => Ok(SHIFT_JIS),
        "euc-jp" | "eucjp" => Ok(EUC_JP),
        "euc-kr" | "euckr" => Ok(EUC_KR),
        "windows-1252" | "cp1252" => Ok(WINDOWS_1252),
        _ => Err(invalid_encoding_error()),
    }
}

/// Validates and encodes UTF-8 byte input using the configured terminal encoding.
pub(crate) fn encode_terminal_bytes(
    data: &[u8],
    encoding_label: &str,
) -> Result<Vec<u8>, AppError> {
    let text = std::str::from_utf8(data).map_err(|_| terminal_input_invalid_error())?;
    encode_text_lossless_inner(text, encoding_label, true)
}

/// Strictly decodes file bytes in the chosen encoding without silent replacement characters.
pub(crate) fn decode_text_bytes(
    bytes: &[u8],
    encoding_label: &str,
    truncated: bool,
) -> Result<String, AppError> {
    let encoding = resolve_text_encoding(encoding_label)?;
    let decoded = if encoding == UTF_8 {
        match std::str::from_utf8(bytes) {
            Ok(text) => text.to_owned(),
            Err(error) if error.error_len().is_none() && truncated => {
                std::str::from_utf8(&bytes[..error.valid_up_to()])
                    .map_err(|_| sftp_preview_encoding_error())?
                    .to_owned()
            }
            Err(_) => return Err(sftp_preview_encoding_error()),
        }
    } else if encoding == UTF_16LE || encoding == UTF_16BE {
        let trimmed = if truncated {
            &bytes[..bytes.len() & !1]
        } else {
            bytes
        };
        let without_bom = if (encoding == UTF_16LE && trimmed.starts_with(&[0xFF, 0xFE]))
            || (encoding == UTF_16BE && trimmed.starts_with(&[0xFE, 0xFF]))
        {
            &trimmed[2..]
        } else {
            trimmed
        };
        encoding
            .decode_without_bom_handling_and_without_replacement(without_bom)
            .map(|cow| cow.into_owned())
            .ok_or_else(sftp_preview_encoding_error)?
    } else {
        let max_trim = if truncated { 3 } else { 0 };
        let mut parsed = None;
        for trim in 0..=max_trim.min(bytes.len()) {
            let slice = &bytes[..bytes.len() - trim];
            if let Some(cow) = encoding.decode_without_bom_handling_and_without_replacement(slice) {
                parsed = Some(cow.into_owned());
                break;
            }
        }
        parsed.ok_or_else(sftp_preview_encoding_error)?
    };

    if decoded.chars().any(|character| {
        character == '\0' || (character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    }) {
        return Err(sftp_preview_encoding_error());
    }
    Ok(decoded)
}

/// Encodes text strictly in the chosen encoding, rejecting lossy substitutions.
pub(crate) fn encode_text_lossless(text: &str, encoding_label: &str) -> Result<Vec<u8>, AppError> {
    encode_text_lossless_inner(text, encoding_label, false)
}

fn encode_text_lossless_inner(
    text: &str,
    encoding_label: &str,
    for_terminal: bool,
) -> Result<Vec<u8>, AppError> {
    let encoding = resolve_text_encoding(encoding_label)?;
    if encoding == UTF_16LE {
        return Ok(text.encode_utf16().flat_map(u16::to_le_bytes).collect());
    }
    if encoding == UTF_16BE {
        return Ok(text.encode_utf16().flat_map(u16::to_be_bytes).collect());
    }
    let (encoded, _, had_errors) = encoding.encode(text);
    if had_errors {
        return Err(if for_terminal {
            terminal_encoding_unrepresentable_error()
        } else {
            lossy_file_encoding_error()
        });
    }
    Ok(encoded.into_owned())
}

fn invalid_encoding_error() -> AppError {
    AppError {
        code: "TEXT_ENCODING_UNSUPPORTED".to_owned(),
        message_key: "errors.terminalEncodingInvalid".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unchanged,
        field: Some("encoding".to_owned()),
    }
}

fn sftp_preview_encoding_error() -> AppError {
    AppError {
        code: "SFTP_PREVIEW_UNSUPPORTED".to_owned(),
        message_key: "errors.sftpPreviewUnsupported".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unchanged,
        field: Some("encoding".to_owned()),
    }
}

fn lossy_file_encoding_error() -> AppError {
    AppError {
        code: "ENCODING_LOSSY_INPUT".to_owned(),
        message_key: "errors.encodingLossyInput".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unchanged,
        field: Some("encoding".to_owned()),
    }
}

fn terminal_input_invalid_error() -> AppError {
    AppError {
        code: "TERMINAL_INPUT_INVALID".to_owned(),
        message_key: "errors.terminalInputInvalid".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unchanged,
        field: None,
    }
}

fn terminal_encoding_unrepresentable_error() -> AppError {
    AppError {
        code: "TERMINAL_ENCODING_UNREPRESENTABLE".to_owned(),
        message_key: "errors.terminalEncodingUnrepresentable".to_owned(),
        retryable: false,
        remote_state: RemoteState::Unchanged,
        field: Some("encoding".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        decode_text_bytes, encode_terminal_bytes, encode_text_lossless, resolve_text_encoding,
    };

    #[test]
    fn roundtrips_multi_encoding_text_and_rejects_lossy_input() {
        let sample = "FILEX 中文配置 123";
        for label in ["utf-8", "utf-16le", "utf-16be", "gbk", "gb18030", "big5"] {
            let encoded = encode_text_lossless(sample, label).expect("lossless encode");
            let decoded = decode_text_bytes(&encoded, label, false).expect("decode");
            assert_eq!(decoded, sample, "roundtrip mismatch for {label}");
        }

        let jp = "設定ファイル";
        for label in ["shift_jis", "euc-jp"] {
            let encoded = encode_text_lossless(jp, label).expect("jp encode");
            let decoded = decode_text_bytes(&encoded, label, false).expect("jp decode");
            assert_eq!(decoded, jp);
        }

        let kr = "설정 파일";
        let kr_encoded = encode_text_lossless(kr, "euc-kr").expect("euc-kr encode");
        assert_eq!(
            decode_text_bytes(&kr_encoded, "euc-kr", false).expect("euc-kr decode"),
            kr
        );

        let latin = "Café configuration";
        let latin_encoded = encode_text_lossless(latin, "windows-1252").expect("1252 encode");
        assert_eq!(
            decode_text_bytes(&latin_encoded, "windows-1252", false).expect("1252 decode"),
            latin
        );

        let mut utf16_le_bom = vec![0xFF, 0xFE];
        utf16_le_bom.extend_from_slice(&encode_text_lossless("Hi", "utf-16le").expect("utf16le"));
        utf16_le_bom.push(0x41);
        assert_eq!(
            decode_text_bytes(&utf16_le_bom, "utf-16le", true).expect("truncated utf16"),
            "Hi"
        );

        let term_bytes =
            encode_terminal_bytes("echo 中文\r".as_bytes(), "gb18030").expect("term enc");
        assert!(!term_bytes.is_empty());
        let term_err =
            encode_terminal_bytes("中文".as_bytes(), "windows-1252").expect_err("term lossy");
        assert_eq!(term_err.code, "TERMINAL_ENCODING_UNREPRESENTABLE");

        assert!(resolve_text_encoding("euc-kr").is_ok());
        assert!(resolve_text_encoding("windows-1252").is_ok());

        let err = encode_text_lossless("中文", "windows-1252")
            .expect_err("rejects unrepresentable chars in windows-1252");
        assert_eq!(err.code, "ENCODING_LOSSY_INPUT");
    }
}
