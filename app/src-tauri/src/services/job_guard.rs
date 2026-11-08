//! Windows Job Object：父进程退出或崩溃时，由系统回收整棵子进程树。
//!
//! llama-server、fast27b、strata 网关与向量服务都需要把子进程挂进一个
//! `KILL_ON_JOB_CLOSE` 的 Job，避免应用被强杀后留下孤儿进程。各服务的
//! 生命周期策略不同（单 Job / 按 tag 多 Job），策略留在各自模块，这里只
//! 提供 FFI、结构体布局与句柄所有权，避免四份相同的样板各自漂移。

#![allow(non_snake_case, non_upper_case_globals)]

use std::sync::Mutex;

pub type Handle = *mut std::ffi::c_void;

// HANDLE 是裸指针，需要包装才能在线程间安全传递
struct JobHandle(Handle);
unsafe impl Send for JobHandle {}
unsafe impl Sync for JobHandle {}

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
const JobObjectExtendedLimitInformation: u32 = 9;

#[repr(C)]
struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    PerProcessUserTimeLimit: i64,
    PerJobUserTimeLimit: i64,
    LimitFlags: u32,
    MinimumWorkingSetSize: usize,
    MaximumWorkingSetSize: usize,
    ActiveProcessLimit: u32,
    Affinity: usize,
    // 末尾两项必须是 PriorityClass / SchedulingClass（各 u32）。
    // 早期误写成 ChildProcessCount + Reserved[2] 会多 4 字节，
    // SetInformationJobObject 以 ERROR_BAD_LENGTH 失败，整树回收实际从未生效。
    PriorityClass: u32,
    SchedulingClass: u32,
}

#[repr(C)]
struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION,
    IoInfo: [u64; 6],
    ProcessMemoryLimit: usize,
    JobMemoryLimit: usize,
    PeakProcessMemoryUsed: usize,
    PeakJobMemoryUsed: usize,
}

// x64 下固定 144 字节；布局写错会让 SetInformationJobObject 失败，编译期拦住。
#[cfg(target_pointer_width = "64")]
const _: () = assert!(std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() == 144);

extern "system" {
    fn CreateJobObjectW(lpJobAttributes: *const u8, lpName: *const u16) -> Handle;
    fn SetInformationJobObject(
        hJob: Handle,
        JobObjectInfoClass: u32,
        lpJobObjectInfo: *const u8,
        cbJobObjectInfoLength: u32,
    ) -> i32;
    fn AssignProcessToJobObject(hJob: Handle, hProcess: Handle) -> i32;
    fn TerminateJobObject(hJob: Handle, uExitCode: u32) -> i32;
    fn CloseHandle(hObject: Handle) -> i32;
}

/// 一个 Job Object 句柄；Drop 时关闭。
///
/// 关闭最后一个句柄时，`KILL_ON_JOB_CLOSE` 会由系统终止 Job 内的所有进程，
/// 因此 Drop 本身就是整树回收的兜底，不需要额外清理。
pub struct Job {
    handle: JobHandle,
}

impl Job {
    /// 创建并配置一个无名 Job（KILL_ON_JOB_CLOSE）。
    pub fn create(label: &str) -> Option<Self> {
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                eprintln!("[{label}] Job Object 创建失败");
                return None;
            }

            let mut info = std::mem::zeroed::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ret = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const u8,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ret == 0 {
                eprintln!("[{label}] SetInformationJobObject 失败");
                CloseHandle(handle);
                return None;
            }

            Some(Self {
                handle: JobHandle(handle),
            })
        }
    }

    /// 把进程加入 Job。失败时 Job 仍由调用方持有。
    pub fn assign(&self, process: Handle, label: &str) -> bool {
        unsafe {
            if AssignProcessToJobObject(self.handle.0, process) == 0 {
                eprintln!("[{label}] AssignProcessToJobObject 失败");
                return false;
            }
        }
        true
    }

    /// 终止 Job 内全部进程；句柄仍由 Drop 关闭。
    pub fn terminate(&self) {
        unsafe {
            TerminateJobObject(self.handle.0, 1);
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle.0);
        }
    }
}

/// 单 Job 槽：每个服务一份。重复 attach 时先终止旧进程树，避免句柄泄漏。
pub struct JobSlot {
    label: &'static str,
    inner: Mutex<Option<Job>>,
}

impl JobSlot {
    pub const fn new(label: &'static str) -> Self {
        Self {
            label,
            inner: Mutex::new(None),
        }
    }

    /// 把进程放进新的 Job；已有 Job 的整棵树会被终止并关闭。
    pub fn assign(&self, process: Handle) -> bool {
        let Some(job) = Job::create(self.label) else {
            return false;
        };
        if !job.assign(process, self.label) {
            return false;
        }
        // 锁中毒也要继续：直接返回会让新 Job 随作用域 Drop，
        // KILL_ON_JOB_CLOSE 会把刚附加的子进程一起杀掉。
        let previous = {
            let mut slot = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            slot.replace(job)
        };
        if let Some(previous) = previous {
            previous.terminate();
        }
        true
    }

    /// 终止 Job 整树并关闭句柄（幂等：无 Job 时调用无害）。
    pub fn terminate(&self) {
        let job = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(job) = job {
            job.terminate();
        }
    }
}
