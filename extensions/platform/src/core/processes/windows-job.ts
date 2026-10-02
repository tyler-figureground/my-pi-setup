// Windows Job Objects give process-tree ownership without polling. Once a
// process joins a kill-on-close job, every process it later creates joins too
// (including ones whose parent has already exited), TerminateJobObject kills
// the whole set atomically, and the kernel kills it when the last handle
// closes, so the tree also dies if pi itself crashes.
//
// Node already places non-detached children in libuv's own job, which allows
// silent breakaway for grandchildren. A job created here nests beneath it and
// has no breakaway flags, so grandchildren stay contained. (Observed on
// Windows 11: while nested, descendants also die with libuv's job when the
// host exits, so crash cleanup does not depend on this job's flag alone.)

export interface WindowsKillOnCloseJob {
  /** Adds a live process. Descendants it creates afterwards join as well. */
  assign(pid: number): void;
  /** Kills every process in the job. Safe to repeat; no-op after close. */
  terminate(): void;
  /** Releases the job handle; remaining members die. Safe to repeat. */
  close(): void;
}

type Handle = unknown;

interface JobBindings {
  readonly createJob: () => Handle;
  readonly setKillOnClose: (job: Handle) => boolean;
  readonly openProcess: (pid: number) => Handle;
  readonly assign: (job: Handle, process: Handle) => boolean;
  readonly terminate: (job: Handle) => boolean;
  readonly close: (handle: Handle) => void;
  readonly lastError: () => number;
}

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const JOB_TERMINATED_EXIT_CODE = 1;

let bindingsPromise: Promise<JobBindings> | undefined;

async function loadBindings(): Promise<JobBindings> {
  const loaded = await import("koffi");
  const koffi = "default" in loaded ? loaded.default : loaded;
  const kernel32 = koffi.load("kernel32.dll");
  koffi.pointer("PI_JOB_HANDLE", koffi.opaque());
  const basicLimit = koffi.struct("PI_JOBOBJECT_BASIC_LIMIT_INFORMATION", {
    PerProcessUserTimeLimit: "int64",
    PerJobUserTimeLimit: "int64",
    LimitFlags: "uint32",
    MinimumWorkingSetSize: "size_t",
    MaximumWorkingSetSize: "size_t",
    ActiveProcessLimit: "uint32",
    Affinity: "uintptr_t",
    PriorityClass: "uint32",
    SchedulingClass: "uint32",
  });
  const ioCounters = koffi.struct("PI_IO_COUNTERS", {
    ReadOperationCount: "uint64",
    WriteOperationCount: "uint64",
    OtherOperationCount: "uint64",
    ReadTransferCount: "uint64",
    WriteTransferCount: "uint64",
    OtherTransferCount: "uint64",
  });
  const extendedLimit = koffi.struct(
    "PI_JOBOBJECT_EXTENDED_LIMIT_INFORMATION",
    {
      BasicLimitInformation: basicLimit,
      IoInfo: ioCounters,
      ProcessMemoryLimit: "size_t",
      JobMemoryLimit: "size_t",
      PeakProcessMemoryUsed: "size_t",
      PeakJobMemoryUsed: "size_t",
    },
  );
  const CreateJobObjectW = kernel32.func(
    "PI_JOB_HANDLE __stdcall CreateJobObjectW(void *attributes, const char16_t *name)",
  );
  const SetInformationJobObject = kernel32.func(
    "int __stdcall SetInformationJobObject(PI_JOB_HANDLE job, int infoClass, _In_ PI_JOBOBJECT_EXTENDED_LIMIT_INFORMATION *info, uint32 length)",
  );
  const OpenProcess = kernel32.func(
    "PI_JOB_HANDLE __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)",
  );
  const AssignProcessToJobObject = kernel32.func(
    "int __stdcall AssignProcessToJobObject(PI_JOB_HANDLE job, PI_JOB_HANDLE process)",
  );
  const TerminateJobObject = kernel32.func(
    "int __stdcall TerminateJobObject(PI_JOB_HANDLE job, uint32 exitCode)",
  );
  const CloseHandle = kernel32.func(
    "int __stdcall CloseHandle(PI_JOB_HANDLE handle)",
  );
  const GetLastError = kernel32.func("uint32 __stdcall GetLastError()");
  const extendedLimitSize = koffi.sizeof(extendedLimit);
  return {
    createJob: () => CreateJobObjectW(null, null),
    setKillOnClose: (job) =>
      SetInformationJobObject(
        job,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        {
          BasicLimitInformation: {
            LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
          },
        },
        extendedLimitSize,
      ) !== 0,
    openProcess: (pid) =>
      OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid),
    assign: (job, process) => AssignProcessToJobObject(job, process) !== 0,
    terminate: (job) => TerminateJobObject(job, JOB_TERMINATED_EXIT_CODE) !== 0,
    close: (handle) => void CloseHandle(handle),
    lastError: () => GetLastError(),
  };
}

export async function createWindowsKillOnCloseJob(): Promise<WindowsKillOnCloseJob> {
  if (process.platform !== "win32")
    throw new Error("Windows job objects are unavailable on this platform.");
  const bindings = await (bindingsPromise ??= loadBindings().catch((error) => {
    bindingsPromise = undefined;
    throw error;
  }));
  const job = bindings.createJob();
  if (!job)
    throw new Error(
      `CreateJobObjectW failed with Win32 error ${bindings.lastError()}.`,
    );
  if (!bindings.setKillOnClose(job)) {
    const error = bindings.lastError();
    bindings.close(job);
    throw new Error(
      `SetInformationJobObject failed with Win32 error ${error}.`,
    );
  }
  let closed = false;
  return {
    assign(pid) {
      if (closed) throw new Error("Windows job object is closed.");
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new TypeError("Windows job member PID is invalid.");
      const member = bindings.openProcess(pid);
      if (!member)
        throw new Error(
          `OpenProcess(${pid}) failed with Win32 error ${bindings.lastError()}.`,
        );
      try {
        if (!bindings.assign(job, member))
          throw new Error(
            `AssignProcessToJobObject(${pid}) failed with Win32 error ${bindings.lastError()}.`,
          );
      } finally {
        bindings.close(member);
      }
    },
    terminate() {
      if (closed) return;
      if (!bindings.terminate(job))
        throw new Error(
          `TerminateJobObject failed with Win32 error ${bindings.lastError()}.`,
        );
    },
    close() {
      if (closed) return;
      closed = true;
      bindings.close(job);
    },
  };
}
