use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use filex_contracts::{AppError, RemoteState, TunnelRule};
use filex_core::{ProfileRepository, TunnelRuleRepository};
use filex_storage::SqliteProfileRepository;

const MAX_TRANSIENT_TUNNEL_RULES: usize = 200;

/// Routes saved-profile tunnel rules to SQLite and transient quick/bastion session rules
/// to a bounded in-memory store so quick sessions can manage tunnel rules without polluting SQLite.
pub(crate) struct HybridTunnelRuleRepository {
    persistent: Arc<SqliteProfileRepository>,
    transient: Mutex<HashMap<String, TunnelRule>>,
}

impl HybridTunnelRuleRepository {
    pub(crate) fn new(persistent: Arc<SqliteProfileRepository>) -> Self {
        Self {
            persistent,
            transient: Mutex::new(HashMap::new()),
        }
    }

    fn is_persistent_profile(&self, profile_id: &str) -> Result<bool, AppError> {
        Ok(ProfileRepository::get(self.persistent.as_ref(), profile_id)?.is_some())
    }
}

impl TunnelRuleRepository for HybridTunnelRuleRepository {
    fn list_tunnel_rules(&self) -> Result<Vec<TunnelRule>, AppError> {
        let mut rules = TunnelRuleRepository::list_tunnel_rules(self.persistent.as_ref())?;
        let transient = self
            .transient
            .lock()
            .map_err(|_| transient_tunnel_lock_error())?;
        rules.extend(transient.values().cloned());
        rules.sort_by(|left, right| {
            left.name
                .to_lowercase()
                .cmp(&right.name.to_lowercase())
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(rules)
    }

    fn get_tunnel_rule(&self, id: &str) -> Result<Option<TunnelRule>, AppError> {
        if let Some(rule) = self
            .transient
            .lock()
            .map_err(|_| transient_tunnel_lock_error())?
            .get(id)
            .cloned()
        {
            return Ok(Some(rule));
        }
        TunnelRuleRepository::get_tunnel_rule(self.persistent.as_ref(), id)
    }

    fn insert_tunnel_rule(&self, rule: &TunnelRule) -> Result<(), AppError> {
        if self.is_persistent_profile(&rule.profile_id)? {
            return TunnelRuleRepository::insert_tunnel_rule(self.persistent.as_ref(), rule);
        }
        let mut transient = self
            .transient
            .lock()
            .map_err(|_| transient_tunnel_lock_error())?;
        if transient.len() >= MAX_TRANSIENT_TUNNEL_RULES
            && let Some(evict_id) = transient.keys().next().cloned()
        {
            transient.remove(&evict_id);
        }
        transient.insert(rule.id.clone(), rule.clone());
        Ok(())
    }

    fn update_tunnel_rule(&self, rule: &TunnelRule) -> Result<(), AppError> {
        {
            let mut transient = self
                .transient
                .lock()
                .map_err(|_| transient_tunnel_lock_error())?;
            if let Some(existing) = transient.get_mut(&rule.id) {
                *existing = rule.clone();
                return Ok(());
            }
        }
        TunnelRuleRepository::update_tunnel_rule(self.persistent.as_ref(), rule)
    }

    fn delete_tunnel_rule(&self, id: &str) -> Result<bool, AppError> {
        {
            let mut transient = self
                .transient
                .lock()
                .map_err(|_| transient_tunnel_lock_error())?;
            if transient.remove(id).is_some() {
                return Ok(true);
            }
        }
        TunnelRuleRepository::delete_tunnel_rule(self.persistent.as_ref(), id)
    }
}

fn transient_tunnel_lock_error() -> AppError {
    AppError {
        code: "TUNNEL_RULE_STORAGE_LOCK_FAILED".to_owned(),
        message_key: "errors.tunnelRuleStorageFailed".to_owned(),
        retryable: true,
        remote_state: RemoteState::Unknown,
        field: None,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use filex_contracts::{CreateTunnelRuleInput, TunnelKind, UpdateTunnelRuleInput};
    use filex_core::{TunnelRuleRepository, TunnelRuleService};
    use filex_storage::SqliteProfileRepository;

    use super::HybridTunnelRuleRepository;

    #[test]
    fn stores_quick_session_tunnel_rules_in_memory_without_polluting_sqlite() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let db_path = dir.path().join("filex.sqlite3");
        let sqlite = Arc::new(SqliteProfileRepository::open(&db_path).expect("open sqlite"));
        let hybrid = Arc::new(HybridTunnelRuleRepository::new(sqlite.clone()));
        let service = TunnelRuleService::new(hybrid);

        let created = service
            .create(CreateTunnelRuleInput {
                profile_id: "quick-profile-uuid".to_owned(),
                name: "Web Forward".to_owned(),
                kind: TunnelKind::Local,
                bind_host: "127.0.0.1".to_owned(),
                bind_port: 8080,
                target_host: Some("127.0.0.1".to_owned()),
                target_port: Some(80),
                auto_start: false,
            })
            .expect("create transient tunnel rule");

        assert_eq!(service.list().expect("list hybrid").len(), 1);
        assert!(
            TunnelRuleRepository::list_tunnel_rules(sqlite.as_ref())
                .expect("list sqlite")
                .is_empty()
        );

        let updated = service
            .update(UpdateTunnelRuleInput {
                id: created.id.clone(),
                profile_id: created.profile_id.clone(),
                name: "Admin Forward".to_owned(),
                kind: TunnelKind::Local,
                bind_host: "127.0.0.1".to_owned(),
                bind_port: 8443,
                target_host: Some("127.0.0.1".to_owned()),
                target_port: Some(443),
                auto_start: true,
            })
            .expect("update transient tunnel rule");
        assert_eq!(updated.name, "Admin Forward");
        assert_eq!(updated.bind_port, 8443);
        assert!(updated.auto_start);

        service
            .delete(&created.id)
            .expect("delete transient tunnel rule");
        assert!(service.list().expect("list after delete").is_empty());
    }
}
