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
