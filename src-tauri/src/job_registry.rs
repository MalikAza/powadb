use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::Mutex;

#[derive(Default)]
pub struct JobRegistry {
    jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl JobRegistry {
    pub async fn register(&self, job_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.jobs
            .lock()
            .await
            .insert(job_id.to_string(), flag.clone());
        flag
    }

    pub async fn cancel(&self, job_id: &str) -> bool {
        if let Some(flag) = self.jobs.lock().await.get(job_id) {
            flag.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    pub async fn forget(&self, job_id: &str) {
        self.jobs.lock().await.remove(job_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn register_returns_an_unset_flag() {
        let r = JobRegistry::default();
        let flag = r.register("j1").await;
        assert!(!flag.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn cancel_flips_the_flag_held_by_the_owner() {
        let r = JobRegistry::default();
        let flag = r.register("j1").await;
        let canceled = r.cancel("j1").await;
        assert!(canceled);
        assert!(flag.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn cancel_returns_false_for_unknown_job() {
        let r = JobRegistry::default();
        assert!(!r.cancel("missing").await);
    }

    #[tokio::test]
    async fn forget_drops_the_entry_so_cancel_misses() {
        let r = JobRegistry::default();
        let flag = r.register("j1").await;
        r.forget("j1").await;
        assert!(!r.cancel("j1").await);
        // The flag handle held by the worker is still untouched.
        assert!(!flag.load(Ordering::SeqCst));
    }
}
