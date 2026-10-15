using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

// Test infrastructure only. The sole non-inheritable Job handle is held here.
public static class PactE2EJob
{
    [StructLayout(LayoutKind.Sequential)] struct Security { public uint Size; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential)] struct Startup {
        public uint Size; public IntPtr Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Info; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveLimit;
        public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong Reads, Writes, Other, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct Limits {
        public BasicLimits Basic; public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long User, Kernel, PeriodUser, PeriodKernel;
        public uint PageFaults, Total, Active, Terminated;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref StartupEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr destinationProcess, out IntPtr destination, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string name, uint access, uint sharing, ref Security security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);

    static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static void Emit(StreamWriter writer, string message, string generation = null) {
        if (writer == null) return;
        if (generation != null) message = message.Insert(1, "\"generation\":\"" + generation + "\",");
        if (!writer.WriteLineAsync(message).Wait(1000)) throw new IOException("Control write deadline");
    }
    static uint Active(IntPtr job) {
        Accounting info;
        Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero));
        return info.Active;
    }
    static IntPtr InheritedStandard(int kind) {
        IntPtr duplicate;
        Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(kind), GetCurrentProcess(), out duplicate, 0, true, 2));
        return duplicate;
    }
    // Windows CRT argv quoting; there is no command shell or variable expansion.
    static string Quote(string argument) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in argument) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') result.Append('\\', slashes * 2 + 1).Append(c);
            else result.Append('\\', slashes).Append(c);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    public static int Run(string executable, string[] args, string cwd, long timeout, StreamWriter writer, Task<string> cancel, string argumentMode = "crt") {
        return RunOwned(executable, args, cwd, timeout, writer, cancel, false, null, argumentMode);
    }
    public static int Forward(string executable, string[] args) {
        return RunOwned(executable, args, Environment.CurrentDirectory, 10 * 60 * 1000, null, new TaskCompletionSource<string>().Task, true, null);
    }
    public static int ForwardObserved(string executable, string[] args, long timeout, StreamWriter writer, Task<string> cancel, string generation) {
        return RunOwned(executable, args, Environment.CurrentDirectory, timeout, writer, cancel, true, generation);
    }
    static StringBuilder CommandLine(string executable, string[] args, string argumentMode) {
        var command = new StringBuilder(Quote(executable));
        if (argumentMode == "crt") {
            foreach (var argument in args) command.Append(' ').Append(Quote(argument));
        } else if (argumentMode == "nsis") {
            if (args == null || (args.Length != 1 && args.Length != 2) || args[0] != "/S") throw new ArgumentException("Invalid named NSIS invocation");
            if (args.Length == 2) {
                if (args[1] == null || !args[1].StartsWith("/D=")) throw new ArgumentException("Invalid NSIS directory argument");
                var directory = args[1].Substring(3);
                if (!System.Text.RegularExpressions.Regex.IsMatch(directory, @"^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))") ||
                    directory.IndexOfAny(new[] { '"', '\0', '\r', '\n' }) >= 0 || directory.IndexOf("/D=", StringComparison.OrdinalIgnoreCase) >= 0)
                    throw new ArgumentException("Invalid owned NSIS directory");
            }
            // /D must be the last raw tail, even for spaces/Unicode. No command shell is used.
            command.Append(" /S");
            if (args.Length == 2) command.Append(' ').Append(args[1]);
        } else throw new ArgumentException("Unknown Windows argument mode");
        if (command.Length >= 32767) throw new ArgumentException("Command line limit");
        return command;
    }
    static int RunOwned(string executable, string[] args, string cwd, long timeout, StreamWriter writer, Task<string> cancel, bool forwardInput, string generation, string argumentMode = "crt") {
        IntPtr job = IntPtr.Zero, attributes = IntPtr.Zero, jobs = IntPtr.Zero, handles = IntPtr.Zero;
        IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
        ProcessInfo process = new ProcessInfo(); bool attributesReady = false, empty = false;
        int exit = 1;
        try {
            job = CreateJobObjectW(IntPtr.Zero, null);
            Check(job != IntPtr.Zero);
            var limits = new Limits();
            limits.Basic.Flags = 0x2000 | 0x8; // KILL_ON_JOB_CLOSE | ACTIVE_PROCESS
            limits.Basic.ActiveLimit = 256;
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<Limits>()));
            var command = CommandLine(executable, args, argumentMode);
            var security = new Security { Size = (uint)Marshal.SizeOf<Security>(), Inherit = 1 };
            input = forwardInput ? InheritedStandard(-10) : CreateFileW("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero);
            Check(input != new IntPtr(-1));
            output = InheritedStandard(-11); error = InheritedStandard(-12);
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size)); attributesReady = true;
            jobs = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs, job);
            handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handles, 0, input); Marshal.WriteIntPtr(handles, IntPtr.Size, output); Marshal.WriteIntPtr(handles, IntPtr.Size * 2, error);
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000d), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));
            if (cancel.IsCompleted) { empty = true; return 1; }
            var startup = new StartupEx { Info = new Startup { Size = (uint)Marshal.SizeOf<StartupEx>(), Flags = 0x100, Input = input, Output = output, Error = error }, Attributes = attributes };
            // JOB_LIST assigns ownership in the kernel before the first instruction.
            Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x80000 | 0x08000000, IntPtr.Zero, cwd, ref startup, out process));
            CloseHandle(process.Thread); process.Thread = IntPtr.Zero;
            Emit(writer, "{\"kind\":\"started\",\"pid\":" + process.Pid + ",\"active\":1}", generation);
            var clock = Stopwatch.StartNew(); long exitedAt = -1, stoppedAt = -1, sampledAt = -1000;
            uint lastActive = 1;
            while (true) {
                uint active = Active(job);
                if (WaitForSingleObject(process.Process, 0) == 0 && exitedAt < 0) {
                    uint code; Check(GetExitCodeProcess(process.Process, out code));
                    if (stoppedAt < 0) exit = unchecked((int)code);
                    exitedAt = clock.ElapsedMilliseconds;
                }
                if (active == 0) {
                    // Accounting can become empty just before the root handle is signalled.
                    // Never substitute the initial failure code for its actual exit status.
                    if (exitedAt < 0 && stoppedAt < 0) {
                        Check(WaitForSingleObject(process.Process, 5000) == 0);
                        uint code; Check(GetExitCodeProcess(process.Process, out code)); exit = unchecked((int)code);
                    }
                    empty = true; break;
                }
                // NSIS delegates uninstall to an owned temporary child before its root exits.
                // That operation keeps the original phase deadline; ordinary commands retain
                // the five-second post-root drain. Job ownership and cancellation never change.
                string reason = cancel.IsCompleted ? "control-closed" : clock.ElapsedMilliseconds >= timeout ? "deadline" : argumentMode != "nsis" && exitedAt >= 0 && clock.ElapsedMilliseconds - exitedAt >= 5000 ? "descendants-still-running" : null;
                if (stoppedAt < 0 && reason != null) {
                    Check(TerminateJobObject(job, 1)); exit = 1; stoppedAt = clock.ElapsedMilliseconds;
                    Emit(writer, "{\"kind\":\"stopping\",\"reason\":\"" + reason + "\"}", generation);
                }
                if (stoppedAt >= 0 && clock.ElapsedMilliseconds - stoppedAt >= 5000) throw new IOException("Job closure unconfirmed");
                if (active != lastActive && clock.ElapsedMilliseconds - sampledAt >= 1000) {
                    Emit(writer, "{\"kind\":\"counts\",\"active\":" + active + "}", generation); lastActive = active; sampledAt = clock.ElapsedMilliseconds;
                }
                Thread.Sleep(25);
            }
            return exit;
        } catch (Exception exception) {
            try { Emit(writer, "{\"kind\":\"error\",\"code\":" + (exception is Win32Exception ? ((Win32Exception)exception).NativeErrorCode : 0) + "}", generation); } catch { }
            return 1;
        } finally {
            if (job != IntPtr.Zero && !empty) {
                TerminateJobObject(job, 1);
                var confirmation = Stopwatch.StartNew();
                try { while (Active(job) != 0 && confirmation.ElapsedMilliseconds < 5000) Thread.Sleep(25); empty = Active(job) == 0; } catch { }
            }
            if (empty) { try { Emit(writer, "{\"kind\":\"empty\",\"exitCode\":" + exit + ",\"active\":0}", generation); } catch { } }
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
            if (attributesReady) DeleteProcThreadAttributeList(attributes);
            foreach (var allocation in new[] { attributes, jobs, handles }) if (allocation != IntPtr.Zero) Marshal.FreeHGlobal(allocation);
            foreach (var handle in new[] { input, output, error, job }) if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
        }
    }
}
