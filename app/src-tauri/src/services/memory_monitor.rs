use sysinfo::System;

pub struct MemoryMonitor {
    system: System,
}

impl MemoryMonitor {
    pub fn new() -> Self {
        let mut system = System::new();
        system.refresh_memory();
        Self { system }
    }

    pub fn get_used_memory(&mut self) -> f64 {
        self.system.refresh_memory();
        self.system.used_memory() as f64 / 1024.0 / 1024.0 / 1024.0
    }

    pub fn get_total_memory(&self) -> f64 {
        self.system.total_memory() as f64 / 1024.0 / 1024.0 / 1024.0
    }
}
