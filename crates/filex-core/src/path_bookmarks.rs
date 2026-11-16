use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use filex_contracts::{AppError, CreatePathBookmarkInput, PathBookmark, RemoteState};

pub const MAX_PROFILE_BOOKMARKS_PER_SIDE: usize = 50;
pub const MAX_BOOKMARK_PATH_CHARS: usize = 4_096;
pub const MAX_BOOKMARK_LABEL_CHARS: usize = 80;

pub trait PathBookmarkRepository: Send + Sync {
    fn list_bookmarks(&self, profile_id: &str) -> Result<Vec<PathBookmark>, AppError>;
    fn upsert_bookmark(
        &self,
        bookmark: &PathBookmark,
        max_per_side: usize,
    ) -> Result<PathBookmark, AppError>;
    fn delete_bookmark(&self, profile_id: &str, bookmark_id: &str) -> Result<bool, AppError>;
}

pub struct PathBookmarkService {
    repository: Arc<dyn PathBookmarkRepository>,
}

impl PathBookmarkService {
    pub fn new(repository: Arc<dyn PathBookmarkRepository>) -> Self {
        Self { repository }
    }

    pub fn list(&self, profile_id: &str) -> Result<Vec<PathBookmark>, AppError> {
        let profile_id = validate_profile_id(profile_id)?;
        self.repository.list_bookmarks(profile_id)
    }

    pub fn save(&self, input: CreatePathBookmarkInput) -> Result<PathBookmark, AppError> {
        let profile_id = validate_profile_id(&input.profile_id)?;
        let side = validate_side(&input.side)?;
        let path = validate_bookmark_path(&input.path)?;
        let label = normalize_bookmark_label(&input.label, path)?;
        let created_at_ms = epoch_ms()?;

        let bookmark = PathBookmark {
            id: uuid::Uuid::new_v4().to_string(),
            profile_id: profile_id.to_owned(),
            side: side.to_owned(),
            label,
            path: path.to_owned(),
            created_at_ms,
        };
        self.repository
            .upsert_bookmark(&bookmark, MAX_PROFILE_BOOKMARKS_PER_SIDE)
    }

    pub fn delete(&self, profile_id: &str, bookmark_id: &str) -> Result<bool, AppError> {
        let profile_id = validate_profile_id(profile_id)?;
        let bookmark_id = bookmark_id.trim();
        if bookmark_id.is_empty() {
            return Err(bookmark_validation_error(
                "errors.bookmarkIdInvalid",
                "bookmarkId",
            ));
        }
        self.repository.delete_bookmark(profile_id, bookmark_id)
    }
}

fn validate_profile_id(value: &str) -> Result<&str, AppError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err(bookmark_validation_error(
            "errors.profileNotFound",
            "profileId",
        ));
    }
    Ok(trimmed)
}

fn validate_side(value: &str) -> Result<&'static str, AppError> {
    match value.trim() {
        "local" => Ok("local"),
        "remote" => Ok("remote"),
        _ => Err(bookmark_validation_error(
            "errors.bookmarkSideInvalid",
            "side",
        )),
    }
}

fn validate_bookmark_path(value: &str) -> Result<&str, AppError> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > MAX_BOOKMARK_PATH_CHARS
        || trimmed.chars().any(char::is_control)
    {
        return Err(bookmark_validation_error(
            "errors.bookmarkPathInvalid",
            "path",
        ));
    }
    Ok(trimmed)
}

fn normalize_bookmark_label(raw_label: &str, path: &str) -> Result<String, AppError> {
    let trimmed = raw_label.trim();
    if trimmed.chars().any(char::is_control) {
        return Err(bookmark_validation_error(
            "errors.bookmarkLabelInvalid",
            "label",
        ));
    }
    let candidate = if trimmed.is_empty() {
        derive_default_label(path)
    } else {
        trimmed.to_owned()
    };
    Ok(candidate.chars().take(MAX_BOOKMARK_LABEL_CHARS).collect())
}

fn derive_default_label(path: &str) -> String {
    let cleaned = path.trim_end_matches(['/', '\\']);
    if cleaned.is_empty() {
        return if path.contains('\\') {
            "\\".to_owned()
        } else {
            "/".to_owned()
        };
    }
    cleaned
        .rsplit(['/', '\\'])
        .find(|segment| !segment.is_empty())
        .unwrap_or(cleaned)
        .to_owned()
}

fn epoch_ms() -> Result<i64, AppError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| AppError {
            code: "CLOCK_UNAVAILABLE".to_owned(),
            message_key: "errors.clockUnavailable".to_owned(),
            retryable: false,
            remote_state: RemoteState::NotApplicable,
            field: None,
        })?
        .as_millis();
    i64::try_from(millis).map_err(|_| AppError {
        code: "CLOCK_UNAVAILABLE".to_owned(),
        message_key: "errors.clockUnavailable".to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: None,
    })
}

fn bookmark_validation_error(message_key: &str, field: &str) -> AppError {
    AppError {
        code: "VALIDATION_ERROR".to_owned(),
        message_key: message_key.to_owned(),
        retryable: false,
        remote_state: RemoteState::NotApplicable,
        field: Some(field.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use filex_contracts::{AppError, CreatePathBookmarkInput, PathBookmark};

    use super::{MAX_PROFILE_BOOKMARKS_PER_SIDE, PathBookmarkRepository, PathBookmarkService};

    #[derive(Default)]
    struct InMemoryBookmarkRepo {
        items: Mutex<Vec<PathBookmark>>,
    }

    impl PathBookmarkRepository for InMemoryBookmarkRepo {
        fn list_bookmarks(&self, profile_id: &str) -> Result<Vec<PathBookmark>, AppError> {
            let items = self.items.lock().expect("lock");
            let mut result: Vec<_> = items
                .iter()
                .filter(|item| item.profile_id == profile_id)
                .cloned()
                .collect();
            result.sort_by_key(|item| std::cmp::Reverse(item.created_at_ms));
            Ok(result)
        }

        fn upsert_bookmark(
            &self,
            bookmark: &PathBookmark,
            max_per_side: usize,
        ) -> Result<PathBookmark, AppError> {
            let mut items = self.items.lock().expect("lock");
            items.retain(|item| {
                !(item.profile_id == bookmark.profile_id
                    && item.side == bookmark.side
                    && item.path == bookmark.path)
            });
            items.insert(0, bookmark.clone());
            let mut per_side = 0usize;
            items.retain(|item| {
                if item.profile_id == bookmark.profile_id && item.side == bookmark.side {
                    per_side += 1;
                    return per_side <= max_per_side;
                }
                true
            });
            Ok(bookmark.clone())
        }

        fn delete_bookmark(&self, profile_id: &str, bookmark_id: &str) -> Result<bool, AppError> {
            let mut items = self.items.lock().expect("lock");
            let before = items.len();
            items.retain(|item| !(item.profile_id == profile_id && item.id == bookmark_id));
            Ok(items.len() != before)
        }
    }

    #[test]
    fn service_validates_derives_labels_and_deletes_bookmarks() {
        let repo = Arc::new(InMemoryBookmarkRepo::default());
        let service = PathBookmarkService::new(repo);

        let err = service
            .save(CreatePathBookmarkInput {
                profile_id: "p1".to_owned(),
                side: "other".to_owned(),
                label: "bad".to_owned(),
                path: "/var/log".to_owned(),
            })
            .expect_err("rejects invalid side");
        assert_eq!(err.field.as_deref(), Some("side"));

        let saved = service
            .save(CreatePathBookmarkInput {
                profile_id: "p1".to_owned(),
                side: "remote".to_owned(),
                label: "".to_owned(),
                path: "/var/log/nginx/".to_owned(),
            })
            .expect("saves bookmark");
        assert_eq!(saved.label, "nginx");
        assert_eq!(service.list("p1").expect("lists").len(), 1);
        assert!(service.delete("p1", &saved.id).expect("deletes"));
        assert!(service.list("p1").expect("empty").is_empty());
        assert_eq!(MAX_PROFILE_BOOKMARKS_PER_SIDE, 50);
    }
}
