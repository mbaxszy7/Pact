using System;
using System.IO;
using System.IO.Pipes;
using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Web.Script.Serialization;

// The private descriptor contains paths and, for observed jobs, an ephemeral control capability.
public static class PactFixtureLauncher
{
    static readonly Stopwatch Clock = Stopwatch.StartNew();
    static int Failed(string phase, int code, string kind = "rejected") {
        Console.Error.WriteLine("Windows fixture launcher failed (" + phase + "; elapsedMs=" + Clock.ElapsedMilliseconds + "; type=" + kind + "; code=" + code + ").");
        return 1;
    }
    public sealed class Configuration { public string executable; public string[] prefix; public string pipe; public string token; public string generation; public long timeout; }
    public static int Main(string[] args) {
        Clock.Restart();
        string phase = "descriptor";
        try {
            string path = Path.ChangeExtension(Assembly.GetExecutingAssembly().Location, ".json");
            var bytes = new FileInfo(path);
            if (bytes.Length > 16384) return Failed("descriptor-bound", 0);
            var configuration = new JavaScriptSerializer().Deserialize<Configuration>(File.ReadAllText(path));
            if (configuration.prefix == null || configuration.prefix.Length > 4) return Failed("prefix-bound", 0);
            var forwarded = new string[configuration.prefix.Length + args.Length];
            Array.Copy(configuration.prefix, forwarded, configuration.prefix.Length);
            Array.Copy(args, 0, forwarded, configuration.prefix.Length, args.Length);
            if (configuration.pipe == null && configuration.token == null && configuration.generation == null)
                return PactE2EJob.Forward(configuration.executable, forwarded);
            Guid token, generation;
            if (configuration.pipe == null || configuration.pipe.Length > 200 || !configuration.pipe.StartsWith("pact-fixture-") ||
                !Guid.TryParse(configuration.token, out token) || !Guid.TryParse(configuration.generation, out generation) ||
                configuration.timeout < 1 || configuration.timeout > 15 * 60 * 1000) return Failed("control-descriptor", 0);
            using (var pipe = new NamedPipeClientStream(".", configuration.pipe, PipeDirection.InOut, PipeOptions.Asynchronous)) {
                phase = "pipe-connect";
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
                    return PactE2EJob.ForwardObserved(configuration.executable, forwarded, configuration.timeout, writer, reader.ReadLineAsync(), configuration.generation);
                }
            }
        } catch (Exception error) {
            string kind = error is TimeoutException ? "timeout" : error is IOException ? "io" : error is UnauthorizedAccessException ? "access" : error is InvalidOperationException ? "operation" : "other";
            return Failed(phase, error.HResult, kind);
        }
    }
}
