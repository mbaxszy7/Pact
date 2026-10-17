using System;
using System.IO;
using System.IO.Pipes;
using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

// The private descriptor contains paths and, for observed jobs, an ephemeral control capability.
public static class PactFixtureLauncher
{
    static readonly Stopwatch Clock = Stopwatch.StartNew();
    static void Stage(string phase) {
        if (Environment.GetEnvironmentVariable("PACT_WINDOWS_STARTUP_DIAGNOSTIC") == "1")
            Console.Error.WriteLine("[pact-windows-startup] " + phase);
    }
    static int Failed(string phase, int code, string kind = "rejected") {
        Console.Error.WriteLine("Windows fixture launcher failed (" + phase + "; elapsedMs=" + Clock.ElapsedMilliseconds + "; type=" + kind + "; code=" + code + ").");
        return 1;
    }
    static bool ReceiptAcknowledged(StreamReader reader, Task<string> pending) {
        var clock = Stopwatch.StartNew();
        for (int line = 0; line < 2; line++) {
            long remaining = 1000 - clock.ElapsedMilliseconds;
            if (remaining <= 0 || !pending.Wait((int)remaining)) return false;
            // EOF releases only the control connection; the actual Job already
            // supplied its empty receipt. It is never extra physical-exit proof.
            if (pending.Result == null || pending.Result == "received") return true;
            if (line != 0 || pending.Result != "cancel") return false;
            pending = reader.ReadLineAsync();
        }
        return false;
    }
    public sealed class Configuration { public string executable; public string[] prefix; public string pipe; public string token; public string generation; public long timeout; public bool runner; public string[] args; public string cwd; public string argumentMode; }
    public static int Main(string[] args) {
        Clock.Restart();
        string phase = "descriptor";
        Stage("entry");
        try {
            Stage("descriptor");
            string path = Path.ChangeExtension(Assembly.GetExecutingAssembly().Location, ".json");
            var bytes = new FileInfo(path);
            if (bytes.Length > 65536) return Failed("descriptor-bound", 0);
            var configuration = new JavaScriptSerializer().Deserialize<Configuration>(File.ReadAllText(path));
            if (!configuration.runner && bytes.Length > 16384) return Failed("descriptor-bound", 0);
            if (configuration.prefix == null || configuration.prefix.Length > 4) return Failed("prefix-bound", 0);
            var forwarded = new string[configuration.prefix.Length + args.Length];
            Array.Copy(configuration.prefix, forwarded, configuration.prefix.Length);
            Array.Copy(args, 0, forwarded, configuration.prefix.Length, args.Length);
            if (!configuration.runner && configuration.pipe == null && configuration.token == null && configuration.generation == null)
                return PactE2EJob.Forward(configuration.executable, forwarded);
            if (configuration.runner && (args.Length != 0 || configuration.args == null || configuration.args.Length > 128 ||
                configuration.cwd == null || !Path.IsPathRooted(configuration.cwd) ||
                (configuration.argumentMode != "crt" && configuration.argumentMode != "nsis"))) return Failed("runner-descriptor", 0);
            if (configuration.runner) foreach (var argument in configuration.args)
                if (argument == null || argument.IndexOf('\0') >= 0) return Failed("runner-argument", 0);
            Guid token, generation;
            if (configuration.pipe == null || configuration.pipe.Length > 200 || !configuration.pipe.StartsWith(configuration.runner ? "pact-e2e-" : "pact-fixture-") ||
                !Guid.TryParse(configuration.token, out token) || !Guid.TryParse(configuration.generation, out generation) ||
                configuration.timeout < 1 || configuration.timeout > (configuration.runner ? 2 * 60 * 60 * 1000 : 15 * 60 * 1000)) return Failed("control-descriptor", 0);
            using (var pipe = new NamedPipeClientStream(".", configuration.pipe, PipeDirection.InOut, PipeOptions.Asynchronous)) {
                phase = "pipe-connect";
                Stage(phase);
                pipe.Connect(5000);
                using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, true))
                using (var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 1024, true)) {
                    writer.AutoFlush = true;
                    phase = "hello-write";
                    var hello = new JavaScriptSerializer().Serialize(new { kind = "hello", token = configuration.token, generation = configuration.generation });
                    if (!writer.WriteLineAsync(hello).Wait(1000)) return Failed("hello-deadline", 0);
                    phase = "admission-read";
                    var admission = reader.ReadLineAsync();
                    if (!admission.Wait(5000)) return Failed("admission-deadline", 0);
                    if (admission.Result != "go") return Failed("admission-denied", 0);
                    phase = "owned-job";
                    Stage("target-start");
                    if (configuration.runner) {
                        // One fixed byte/EOF is cancellation only. Keep this blocking standard
                        // input read off Main; target input remains NUL in PactE2EJob.Run.
                        var cancellation = System.Threading.Tasks.Task.Run(() => {
                            try { using (var input = Console.OpenStandardInput()) input.ReadByte(); } catch { }
                            return "cancel";
                        });
                        return PactE2EJob.Run(configuration.executable, configuration.args, configuration.cwd, configuration.timeout, writer, cancellation, configuration.argumentMode);
                    }
                    var cancel = reader.ReadLineAsync();
                    int exit = PactE2EJob.ForwardObserved(configuration.executable, forwarded, configuration.timeout, writer, cancel, configuration.generation);
                    phase = "receipt-ack";
                    Stage(phase);
                    // Reuse the one pending read; cancellation and ACK are never
                    // concurrent reads. The existing caller cleanup deadline stays fixed.
                    return ReceiptAcknowledged(reader, cancel) ? exit : Failed(phase, 0);
                }
            }
        } catch (Exception error) {
            string kind = error is TimeoutException ? "timeout" : error is IOException ? "io" : error is UnauthorizedAccessException ? "access" : error is InvalidOperationException ? "operation" : "other";
            return Failed(phase, error.HResult, kind);
        }
    }
}
