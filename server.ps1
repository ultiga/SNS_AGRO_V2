param(
    [int]$Port = 0,
    [int]$PollSeconds = 0,
    [switch]$OpenBrowser
)

$ErrorActionPreference = "Stop"

$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $AppRoot "config.json"
$PublicDir = Join-Path $AppRoot "public"

if (-not (Test-Path $ConfigPath)) {
    throw "Missing config.json at $ConfigPath. Copy config.example.json to config.json and fill in your Google Spreadsheet IDs."
}

$Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Port -le 0) { $Port = [int]$Config.port }
if ($PollSeconds -le 0) { $PollSeconds = [int]$Config.pollIntervalSeconds }
if ($Port -le 0) { $Port = 8765 }
if ($PollSeconds -lt 5) { $PollSeconds = 15 }

# Locate gsheets CLI
$GSheetsCli = $env:GSHEETS_CLI
if ([string]::IsNullOrWhiteSpace($GSheetsCli) -or -not (Test-Path $GSheetsCli)) {
    $DefaultBin = Join-Path $env:USERPROFILE ".gemini\antigravity\bin\gsheets.cmd"
    if (Test-Path $DefaultBin) {
        $GSheetsCli = $DefaultBin
    } else {
        $Cmd = Get-Command gsheets -ErrorAction SilentlyContinue
        if ($Cmd) {
            $GSheetsCli = $Cmd.Source
        }
    }
}

if ([string]::IsNullOrWhiteSpace($GSheetsCli) -or -not (Test-Path $GSheetsCli)) {
    throw "Could not find gsheets CLI. Checked `$env:GSHEETS_CLI, `$env:USERPROFILE\.gemini\antigravity\bin\gsheets.cmd, and PATH."
}

$ServerCode = @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public class SnsAgroServer
{
    private readonly int _port;
    private readonly string _publicDir;
    private readonly string _gsheetsCli;
    private readonly string _entriesId;
    private readonly string _entriesRange;
    private readonly string _jobTypesId;
    private readonly string _jobTypesRange;
    private readonly string _upahId;
    private readonly string _upahRange;

    private int _pollIntervalSeconds;
    private HttpListener _listener;
    private CancellationTokenSource _cts;

    private readonly object _syncLock = new object();
    private readonly SemaphoreSlim _refreshGate = new SemaphoreSlim(1, 1);

    private long _version = 0;
    private string _lastHash = "";
    private string _cachedPayloadJson = null;
    private string _syncedAt = null;
    private long _syncDurationMs = 0;
    private string _lastError = null;
    private bool _isSyncing = false;

    public SnsAgroServer(
        int port,
        int pollIntervalSeconds,
        string publicDir,
        string gsheetsCli,
        string entriesId,
        string entriesRange,
        string jobTypesId,
        string jobTypesRange,
        string upahId,
        string upahRange)
    {
        _port = port;
        _pollIntervalSeconds = pollIntervalSeconds < 5 ? 5 : pollIntervalSeconds;
        _publicDir = publicDir;
        _gsheetsCli = gsheetsCli;
        _entriesId = entriesId;
        _entriesRange = entriesRange;
        _jobTypesId = jobTypesId;
        _jobTypesRange = jobTypesRange;
        _upahId = upahId;
        _upahRange = upahRange;
    }

    public void Start(bool openBrowser)
    {
        _cts = new CancellationTokenSource();
        _listener = new HttpListener();
        string prefix = string.Format("http://127.0.0.1:{0}/", _port);
        _listener.Prefixes.Add(prefix);
        _listener.Start();

        Console.WriteLine("============================================================");
        Console.WriteLine("  SNS Agro Real-Time Summary & Payroll Dashboard");
        Console.WriteLine("  URL:   " + prefix);
        Console.WriteLine("  Sync:  Every " + _pollIntervalSeconds + "s from live Google Sheets");
        Console.WriteLine("  CLI:   " + _gsheetsCli);
        Console.WriteLine("  Press Ctrl+C to stop.");
        Console.WriteLine("============================================================");

        // Perform initial sync before opening browser so first paint has live data
        Console.WriteLine("[Sync] Performing initial live sync from Google Sheets...");
        RefreshNowAsync().GetAwaiter().GetResult();

        if (openBrowser)
        {
            try
            {
                Process.Start(new ProcessStartInfo(prefix) { UseShellExecute = true });
            }
            catch { }
        }

        // Start background polling loop
        Task.Run(() => PollLoopAsync(_cts.Token));

        // Main HTTP accept loop
        while (!_cts.IsCancellationRequested && _listener.IsListening)
        {
            try
            {
                HttpListenerContext ctx = _listener.GetContext();
                ThreadPool.QueueUserWorkItem(_ => HandleRequest(ctx));
            }
            catch (HttpListenerException)
            {
                break;
            }
            catch (ObjectDisposedException)
            {
                break;
            }
            catch (Exception ex)
            {
                Console.WriteLine("[HTTP Error] " + ex.Message);
            }
        }
    }

    public void Stop()
    {
        try { if (_cts != null) _cts.Cancel(); } catch { }
        try { if (_listener != null && _listener.IsListening) _listener.Stop(); } catch { }
        try { if (_listener != null) _listener.Close(); } catch { }
    }

    private async Task PollLoopAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            int delaySec = Volatile.Read(ref _pollIntervalSeconds);
            if (delaySec <= 0)
            {
                // Paused mode: check every 2 seconds if unpaused
                try { await Task.Delay(2000, token); } catch { break; }
                continue;
            }

            try
            {
                await Task.Delay(delaySec * 1000, token);
            }
            catch
            {
                break;
            }

            if (token.IsCancellationRequested) break;
            if (Volatile.Read(ref _pollIntervalSeconds) <= 0) continue;

            try
            {
                await RefreshNowAsync();
            }
            catch (Exception ex)
            {
                Console.WriteLine("[Poll Error] " + ex.Message);
            }
        }
    }

    private async Task RefreshNowAsync()
    {
        await _refreshGate.WaitAsync();
        Stopwatch sw = Stopwatch.StartNew();
        lock (_syncLock) { _isSyncing = true; }

        try
        {
            Task<string> tEntries = ReadSheetJsonAsync(_entriesId, _entriesRange);
            Task<string> tJobTypes = ReadSheetJsonAsync(_jobTypesId, _jobTypesRange);
            Task<string> tUpah = ReadSheetJsonAsync(_upahId, _upahRange);

            await Task.WhenAll(tEntries, tJobTypes, tUpah);

            string entriesJson = NormalizeArrayJson(tEntries.Result);
            string jobTypesJson = NormalizeArrayJson(tJobTypes.Result);
            string upahJson = NormalizeArrayJson(tUpah.Result);

            string combinedRaw = entriesJson + "|" + jobTypesJson + "|" + upahJson;
            string hash = ComputeSha256(combinedRaw);
            sw.Stop();

            string nowIso = DateTimeOffset.Now.ToString("yyyy-MM-ddTHH:mm:sszzz");
            bool changed = false;

            lock (_syncLock)
            {
                if (hash != _lastHash || _cachedPayloadJson == null)
                {
                    _version++;
                    _lastHash = hash;
                    changed = true;
                }
                _syncedAt = nowIso;
                _syncDurationMs = sw.ElapsedMilliseconds;
                _lastError = null;
                _cachedPayloadJson = BuildEnvelopeJson(
                    _version,
                    _lastHash,
                    _syncedAt,
                    _syncDurationMs,
                    Volatile.Read(ref _pollIntervalSeconds),
                    "ok",
                    null,
                    entriesJson,
                    jobTypesJson,
                    upahJson
                );
            }

            Console.WriteLine(string.Format(
                "[Sync] {0} | v{1} | {2}ms | {3}",
                DateTime.Now.ToString("HH:mm:ss"),
                _version,
                sw.ElapsedMilliseconds,
                changed ? "UPDATED" : "no changes"
            ));
        }
        catch (Exception ex)
        {
            sw.Stop();
            Console.WriteLine("[Sync Error] " + ex.Message);
            lock (_syncLock)
            {
                _lastError = ex.Message;
                if (_cachedPayloadJson == null)
                {
                    _cachedPayloadJson = BuildEnvelopeJson(
                        _version,
                        _lastHash,
                        _syncedAt,
                        sw.ElapsedMilliseconds,
                        Volatile.Read(ref _pollIntervalSeconds),
                        "error",
                        ex.Message,
                        "[]",
                        "[]",
                        "[]"
                    );
                }
            }
        }
        finally
        {
            lock (_syncLock) { _isSyncing = false; }
            _refreshGate.Release();
        }
    }

    private Task<string> ReadSheetJsonAsync(string spreadsheetId, string range)
    {
        return Task.Run(() =>
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = "cmd.exe";
            psi.Arguments = string.Format(
                "/c \"\"{0}\" readonly read {1} \"{2}\" --value-render-option UNFORMATTED_VALUE --json\"",
                _gsheetsCli,
                spreadsheetId,
                range
            );
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.CreateNoWindow = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;

            using (Process proc = Process.Start(psi))
            {
                Task<string> outTask = proc.StandardOutput.ReadToEndAsync();
                Task<string> errTask = proc.StandardError.ReadToEndAsync();

                if (!proc.WaitForExit(30000))
                {
                    try { proc.Kill(); } catch { }
                    throw new Exception("Timed out reading spreadsheet " + spreadsheetId);
                }

                string stdout = outTask.Result.Trim();
                string stderr = errTask.Result.Trim();

                if (proc.ExitCode != 0)
                {
                    string errDetail = string.IsNullOrEmpty(stderr) ? stdout : stderr;
                    throw new Exception(string.Format("gsheets failed ({0}): {1}", spreadsheetId, errDetail));
                }

                return stdout;
            }
        });
    }

    private static string NormalizeArrayJson(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw) || raw == "null")
        {
            return "[]";
        }
        string trimmed = raw.Trim();
        if (!trimmed.StartsWith("["))
        {
            int idx = trimmed.IndexOf('[');
            if (idx >= 0) trimmed = trimmed.Substring(idx);
            else throw new Exception("Unexpected gsheets output (not a JSON array): " + trimmed.Substring(0, Math.Min(120, trimmed.Length)));
        }
        return trimmed;
    }

    private static string ComputeSha256(string input)
    {
        using (SHA256 sha = SHA256.Create())
        {
            byte[] bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(input));
            StringBuilder sb = new StringBuilder(bytes.Length * 2);
            for (int i = 0; i < bytes.Length; i++)
            {
                sb.Append(bytes[i].ToString("x2"));
            }
            return sb.ToString();
        }
    }

    private static string JsonString(string value)
    {
        if (value == null) return "null";
        StringBuilder sb = new StringBuilder(value.Length + 8);
        sb.Append('"');
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 32) sb.AppendFormat("\\u{0:X4}", (int)c);
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    private string BuildEnvelopeJson(
        long version,
        string hash,
        string syncedAt,
        long syncDurationMs,
        int pollSeconds,
        string status,
        string error,
        string entriesJson,
        string jobTypesJson,
        string upahJson)
    {
        StringBuilder sb = new StringBuilder(entriesJson.Length + jobTypesJson.Length + upahJson.Length + 512);
        sb.Append("{");
        sb.Append("\"version\":").Append(version).Append(",");
        sb.Append("\"hash\":").Append(JsonString(hash)).Append(",");
        sb.Append("\"syncedAt\":").Append(JsonString(syncedAt)).Append(",");
        sb.Append("\"syncDurationMs\":").Append(syncDurationMs).Append(",");
        sb.Append("\"pollIntervalSeconds\":").Append(pollSeconds).Append(",");
        sb.Append("\"status\":").Append(JsonString(status)).Append(",");
        sb.Append("\"error\":").Append(JsonString(error)).Append(",");
        sb.Append("\"meta\":{");
        sb.Append("\"completedEntriesId\":").Append(JsonString(_entriesId)).Append(",");
        sb.Append("\"jobTypesId\":").Append(JsonString(_jobTypesId)).Append(",");
        sb.Append("\"upahId\":").Append(JsonString(_upahId));
        sb.Append("},");
        sb.Append("\"sheets\":{");
        sb.Append("\"completedEntries\":").Append(entriesJson).Append(",");
        sb.Append("\"jobTypes\":").Append(jobTypesJson).Append(",");
        sb.Append("\"upah\":").Append(upahJson);
        sb.Append("}");
        sb.Append("}");
        return sb.ToString();
    }

    private void HandleRequest(HttpListenerContext ctx)
    {
        HttpListenerRequest req = ctx.Request;
        HttpListenerResponse res = ctx.Response;

        try
        {
            string path = req.Url.AbsolutePath;
            string method = req.HttpMethod.ToUpperInvariant();

            if (path == "/api/health")
            {
                string healthJson;
                lock (_syncLock)
                {
                    healthJson = string.Format(
                        "{{\"ok\":true,\"version\":{0},\"syncedAt\":{1},\"isSyncing\":{2},\"pollIntervalSeconds\":{3},\"lastError\":{4}}}",
                        _version,
                        JsonString(_syncedAt),
                        _isSyncing ? "true" : "false",
                        Volatile.Read(ref _pollIntervalSeconds),
                        JsonString(_lastError)
                    );
                }
                WriteJson(res, 200, healthJson);
                return;
            }

            if (path == "/api/data")
            {
                string payload;
                string err;
                string syncedAt;
                long version;
                int pollSec;
                lock (_syncLock)
                {
                    payload = _cachedPayloadJson;
                    err = _lastError;
                    syncedAt = _syncedAt;
                    version = _version;
                    pollSec = Volatile.Read(ref _pollIntervalSeconds);
                }

                if (payload == null)
                {
                    RefreshNowAsync().GetAwaiter().GetResult();
                    lock (_syncLock) { payload = _cachedPayloadJson; }
                }
                else
                {
                    // Update pollIntervalSeconds / error metadata cleanly if changed without re-fetching
                    if (err != null)
                    {
                        string statusJson = string.Format(
                            "{{\"version\":{0},\"syncedAt\":{1},\"pollIntervalSeconds\":{2},\"status\":\"degraded\",\"error\":{3},\"cached\":{4}}}",
                            version, JsonString(syncedAt), pollSec, JsonString(err), payload
                        );
                        WriteJson(res, 200, statusJson);
                        return;
                    }
                }

                WriteJson(res, 200, payload);
                return;
            }

            if (path == "/api/refresh" && (method == "POST" || method == "GET"))
            {
                RefreshNowAsync().GetAwaiter().GetResult();
                string payload;
                lock (_syncLock) { payload = _cachedPayloadJson; }
                WriteJson(res, 200, payload);
                return;
            }

            if (path == "/api/config" && method == "POST")
            {
                string intervalParam = req.QueryString["pollIntervalSeconds"];
                int parsed;
                if (!string.IsNullOrEmpty(intervalParam) && int.TryParse(intervalParam, out parsed))
                {
                    if (parsed != 0 && parsed < 5) parsed = 5;
                    if (parsed > 300) parsed = 300;
                    Interlocked.Exchange(ref _pollIntervalSeconds, parsed);
                    Console.WriteLine("[Config] Poll interval updated to " + (parsed == 0 ? "PAUSED" : parsed + "s"));
                    WriteJson(res, 200, string.Format("{{\"ok\":true,\"pollIntervalSeconds\":{0}}}", parsed));
                    return;
                }
                WriteJson(res, 400, "{\"ok\":false,\"error\":\"Invalid pollIntervalSeconds\"}");
                return;
            }

            // Static files from public/
            ServeStatic(res, path);
        }
        catch (Exception ex)
        {
            try
            {
                WriteJson(res, 500, "{\"error\":" + JsonString(ex.Message) + "}");
            }
            catch { }
        }
    }

    private void ServeStatic(HttpListenerResponse res, string urlPath)
    {
        if (string.IsNullOrEmpty(urlPath) || urlPath == "/")
        {
            urlPath = "/index.html";
        }

        string safeRel = urlPath.TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
        if (safeRel.Contains(".."))
        {
            res.StatusCode = 403;
            res.Close();
            return;
        }

        string fullPath = Path.GetFullPath(Path.Combine(_publicDir, safeRel));
        string rootFull = Path.GetFullPath(_publicDir);
        if (!fullPath.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase) || !File.Exists(fullPath))
        {
            res.StatusCode = 404;
            byte[] notFound = Encoding.UTF8.GetBytes("Not Found");
            res.ContentType = "text/plain; charset=utf-8";
            res.ContentLength64 = notFound.Length;
            res.OutputStream.Write(notFound, 0, notFound.Length);
            res.Close();
            return;
        }

        byte[] data = File.ReadAllBytes(fullPath);
        res.StatusCode = 200;
        res.ContentType = GetContentType(fullPath);
        res.Headers["Cache-Control"] = "no-cache";
        res.ContentLength64 = data.Length;
        res.OutputStream.Write(data, 0, data.Length);
        res.Close();
    }

    private static void WriteJson(HttpListenerResponse res, int statusCode, string json)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(json ?? "{}");
        res.StatusCode = statusCode;
        res.ContentType = "application/json; charset=utf-8";
        res.Headers["Cache-Control"] = "no-store, no-cache, must-revalidate";
        res.ContentLength64 = bytes.Length;
        res.OutputStream.Write(bytes, 0, bytes.Length);
        res.Close();
    }

    private static string GetContentType(string path)
    {
        string ext = Path.GetExtension(path).ToLowerInvariant();
        switch (ext)
        {
            case ".html": return "text/html; charset=utf-8";
            case ".css":  return "text/css; charset=utf-8";
            case ".js":   return "application/javascript; charset=utf-8";
            case ".json": return "application/json; charset=utf-8";
            case ".svg":  return "image/svg+xml";
            case ".png":  return "image/png";
            case ".ico":  return "image/x-icon";
            default:      return "application/octet-stream";
        }
    }
}
"@

Add-Type -TypeDefinition $ServerCode -Language CSharp

$Server = New-Object SnsAgroServer(
    $Port,
    $PollSeconds,
    $PublicDir,
    $GSheetsCli,
    $Config.spreadsheets.completedEntries.id,
    $Config.spreadsheets.completedEntries.range,
    $Config.spreadsheets.jobTypes.id,
    $Config.spreadsheets.jobTypes.range,
    $Config.spreadsheets.upah.id,
    $Config.spreadsheets.upah.range
)

try {
    $Server.Start($OpenBrowser.IsPresent)
} finally {
    $Server.Stop()
}
