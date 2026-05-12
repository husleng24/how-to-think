use crate::ai::providers::AiProviderConfig;
use std::env;
use std::io::{self, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug)]
pub(crate) struct ProviderProcessRequest<'a> {
    pub provider: &'a AiProviderConfig,
    pub args: &'a [String],
    pub stdin: Option<Vec<u8>>,
    pub cancel_flag: Option<Arc<AtomicBool>>,
}

#[derive(Debug)]
pub(crate) struct ProviderProcessOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub success: bool,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub timed_out: bool,
    pub cancelled: bool,
}

#[derive(Debug)]
pub(crate) enum ProviderProcessError {
    Spawn(io::Error),
    Stdin(io::Error),
    Wait(io::Error),
}

pub(crate) fn run_provider_process(
    request: ProviderProcessRequest<'_>,
) -> Result<ProviderProcessOutput, ProviderProcessError> {
    let started = Instant::now();
    let provider = request.provider;
    let mut command = Command::new(&provider.executable_path);
    command
        .args(request.args)
        .stdin(if request.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(working_directory) = &provider.working_directory {
        command.current_dir(working_directory);
    }

    if let Some(environment_allowlist) = &provider.environment_allowlist {
        command.env_clear();
        for name in environment_allowlist {
            if let Ok(value) = env::var(name) {
                command.env(name, value);
            }
        }
    }

    configure_process_tree(&mut command);
    let mut child = command.spawn().map_err(ProviderProcessError::Spawn)?;
    let process_tree = ProcessTree::attach(&child);

    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let max_output_bytes = provider.max_output_bytes;
    let stdout_reader =
        stdout.map(|stdout| thread::spawn(move || read_stream_limited(stdout, max_output_bytes)));
    let stderr_reader =
        stderr.map(|stderr| thread::spawn(move || read_stream_limited(stderr, max_output_bytes)));
    let stdin_writer = match (stdin, request.stdin) {
        (Some(mut stdin), Some(input)) => Some(thread::spawn(move || match stdin.write_all(&input) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Ok(()),
            Err(error) => Err(error),
        })),
        _ => None,
    };
    let timeout = Duration::from_secs(provider.timeout_seconds);
    let mut timed_out = false;
    let mut cancelled = false;

    let status = loop {
        if request
            .cancel_flag
            .as_ref()
            .is_some_and(|cancel_flag| cancel_flag.load(Ordering::SeqCst))
        {
            cancelled = true;
            terminate_process_tree(&mut child, &process_tree);
            break child.wait().map_err(ProviderProcessError::Wait)?;
        }

        match child.try_wait().map_err(ProviderProcessError::Wait)? {
            Some(status) => break status,
            None if started.elapsed() >= timeout => {
                timed_out = true;
                terminate_process_tree(&mut child, &process_tree);
                break child.wait().map_err(ProviderProcessError::Wait)?;
            }
            None => thread::sleep(Duration::from_millis(20)),
        }
    };

    if timed_out || cancelled {
        let _ = join_stdin_writer(stdin_writer);
    } else {
        join_stdin_writer(stdin_writer)?;
    }
    let stdout = join_reader(stdout_reader);
    let stderr = join_reader(stderr_reader);

    Ok(ProviderProcessOutput {
        stdout: String::from_utf8_lossy(&stdout.bytes).to_string(),
        stderr: String::from_utf8_lossy(&stderr.bytes).to_string(),
        exit_code: status.code(),
        success: status.success(),
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
        timed_out,
        cancelled,
    })
}

fn read_stream_limited(mut stream: impl Read, max_bytes: usize) -> LimitedBytes {
    let mut bytes = Vec::new();
    let mut truncated = false;
    let mut buffer = [0u8; 8192];

    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                let remaining = max_bytes.saturating_sub(bytes.len());
                if remaining > 0 {
                    bytes.extend_from_slice(&buffer[..read.min(remaining)]);
                }
                if read > remaining {
                    truncated = true;
                }
            }
            Err(_) => {
                truncated = true;
                break;
            }
        }
    }

    LimitedBytes { bytes, truncated }
}

#[derive(Debug, Default)]
struct LimitedBytes {
    bytes: Vec<u8>,
    truncated: bool,
}

fn join_reader(handle: Option<thread::JoinHandle<LimitedBytes>>) -> LimitedBytes {
    handle
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default()
}

fn join_stdin_writer(
    handle: Option<thread::JoinHandle<Result<(), io::Error>>>,
) -> Result<(), ProviderProcessError> {
    let Some(handle) = handle else {
        return Ok(());
    };

    match handle.join() {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(ProviderProcessError::Stdin(error)),
        Err(_) => Err(ProviderProcessError::Stdin(io::Error::new(
            io::ErrorKind::Other,
            "provider stdin writer thread failed",
        ))),
    }
}

#[cfg(unix)]
fn configure_process_tree(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    unsafe {
        command.pre_exec(|| {
            if setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        });
    }
}

#[cfg(not(unix))]
fn configure_process_tree(_command: &mut Command) {}

#[cfg(unix)]
extern "C" {
    fn setpgid(pid: i32, pgid: i32) -> i32;
    fn kill(pid: i32, signal: i32) -> i32;
}

#[cfg(windows)]
struct ProcessTree {
    job: Option<JobHandle>,
}

#[cfg(not(windows))]
struct ProcessTree;

impl ProcessTree {
    #[cfg(windows)]
    fn attach(child: &Child) -> Self {
        Self {
            job: JobHandle::assign(child),
        }
    }

    #[cfg(not(windows))]
    fn attach(_child: &Child) -> Self {
        Self
    }
}

#[cfg(unix)]
fn terminate_process_tree(child: &mut Child, _process_tree: &ProcessTree) {
    let group_id = -(child.id() as i32);
    unsafe {
        let _ = kill(group_id, 15);
    }
    thread::sleep(Duration::from_millis(50));
    if child.try_wait().ok().flatten().is_none() {
        unsafe {
            let _ = kill(group_id, 9);
        }
        let _ = child.kill();
    }
}

#[cfg(windows)]
fn terminate_process_tree(child: &mut Child, process_tree: &ProcessTree) {
    if let Some(job) = &process_tree.job {
        job.terminate();
    }
    let _ = child.kill();
}

#[cfg(not(any(unix, windows)))]
fn terminate_process_tree(child: &mut Child, _process_tree: &ProcessTree) {
    let _ = child.kill();
}

#[cfg(windows)]
struct JobHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl JobHandle {
    fn assign(child: &Child) -> Option<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW};

        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return None;
        }

        let child_handle = child.as_raw_handle() as HANDLE;
        let assigned = unsafe { AssignProcessToJobObject(job, child_handle) };
        if assigned == 0 {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(job);
            }
            return None;
        }

        Some(Self(job))
    }

    fn terminate(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
