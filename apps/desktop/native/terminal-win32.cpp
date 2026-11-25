#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <algorithm>
#include <atomic>
#include <cwctype>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr uint8_t FRAME_READY = 0x01;
constexpr uint8_t FRAME_OUTPUT = 0x02;
constexpr uint8_t FRAME_ACTIVITY = 0x03;
constexpr uint8_t FRAME_EXIT = 0x04;
constexpr uint8_t FRAME_ERROR = 0x05;
constexpr uint8_t FRAME_SHELL_EXITED = 0x06;

constexpr uint8_t FRAME_INPUT = 0x10;
constexpr uint8_t FRAME_RESIZE = 0x11;
constexpr uint8_t FRAME_SHUTDOWN = 0x13;
constexpr uint8_t FRAME_PING_ACTIVITY = 0x14;

constexpr SHORT MIN_COLS = 2;
constexpr SHORT MAX_COLS = 400;
constexpr SHORT MIN_ROWS = 1;
constexpr SHORT MAX_ROWS = 160;
constexpr uint32_t MAX_FRAME_BYTES = 128U * 1024U;

std::mutex g_stdout_mutex;

bool write_all_stdout(const uint8_t* data, size_t len) {
  size_t off = 0;
  while (off < len) {
    unsigned int chunk = static_cast<unsigned int>(min(len - off, size_t(65536)));
    int n = _write(1, data + off, chunk);
    if (n <= 0) return false;
    off += static_cast<size_t>(n);
  }
  return true;
}

void write_frame(uint8_t type, const uint8_t* payload, uint32_t len) {
  uint8_t header[5] = {
      type,
      static_cast<uint8_t>((len >> 24) & 0xffU),
      static_cast<uint8_t>((len >> 16) & 0xffU),
      static_cast<uint8_t>((len >> 8) & 0xffU),
      static_cast<uint8_t>(len & 0xffU),
  };
  std::lock_guard<std::mutex> lock(g_stdout_mutex);
  (void)write_all_stdout(header, sizeof(header));
  if (len > 0) (void)write_all_stdout(payload, len);
}

void write_json_frame(uint8_t type, const std::string& json) {
  write_frame(type, reinterpret_cast<const uint8_t*>(json.data()), static_cast<uint32_t>(json.size()));
}

std::string utf16_to_utf8(const std::wstring& wide) {
  if (wide.empty()) return {};
  int bytes = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), static_cast<int>(wide.size()), nullptr, 0, nullptr, nullptr);
  if (bytes <= 0) return {};
  std::string out(static_cast<size_t>(bytes), '\0');
  WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), static_cast<int>(wide.size()), out.data(), bytes, nullptr, nullptr);
  return out;
}

std::string json_escape(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 8);
  for (unsigned char ch : s) {
    switch (ch) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (ch < 0x20U) {
          char buf[8];
          snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned>(ch));
          out += buf;
        } else {
          out.push_back(static_cast<char>(ch));
        }
    }
  }
  return out;
}

bool read_exact_stdin(uint8_t* dst, size_t len) {
  size_t off = 0;
  while (off < len) {
    int n = _read(0, dst + off, static_cast<unsigned int>(len - off));
    if (n <= 0) return false;
    off += static_cast<size_t>(n);
  }
  return true;
}

std::string basename_utf8(const std::wstring& path) {
  size_t pos = path.find_last_of(L"\\/");
  std::wstring sub = (pos == std::wstring::npos) ? path : path.substr(pos + 1);
  return utf16_to_utf8(sub);
}

bool is_powershell_exe(const std::wstring& path) {
  std::wstring lower = path;
  for (wchar_t& ch : lower) ch = static_cast<wchar_t>(towlower(ch));
  return lower.ends_with(L"powershell.exe") || lower.ends_with(L"pwsh.exe");
}

std::wstring resolve_system_shell_path() {
  wchar_t sysdir[MAX_PATH];
  UINT len = GetSystemDirectoryW(sysdir, MAX_PATH);
  if (len == 0 || len >= MAX_PATH) {
    return L"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  }
  std::wstring base(sysdir, len);
  std::wstring ps = base + L"\\WindowsPowerShell\\v1.0\\powershell.exe";
  DWORD attrs = GetFileAttributesW(ps.c_str());
  if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0) {
    return ps;
  }
  std::wstring cmd = base + L"\\cmd.exe";
  attrs = GetFileAttributesW(cmd.c_str());
  if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0) {
    return cmd;
  }
  return ps;
}

bool starts_with_ci_w(const std::wstring& s, const wchar_t* prefix) {
  size_t i = 0;
  while (prefix[i] != L'\0') {
    if (i >= s.size()) return false;
    if (towlower(s[i]) != towlower(prefix[i])) return false;
    i++;
  }
  return true;
}

bool should_strip_env_key_w(const std::wstring& key) {
  if (starts_with_ci_w(key, L"PACT_") ||
      starts_with_ci_w(key, L"ELECTRON_") ||
      starts_with_ci_w(key, L"NODE_REPL_") ||
      starts_with_ci_w(key, L"CHROME_")) {
    return true;
  }
  std::wstring lower = key;
  for (wchar_t& ch : lower) ch = static_cast<wchar_t>(towlower(ch));
  static const wchar_t* const blocked[] = {
      L"node_options",
      L"node_extra_ca_certs",
      L"node_path",
      L"node_tls_reject_unauthorized",
      L"node_v8_coverage",
      L"google_api_key",
      L"_nt_symbol_path",
      L"cor_enable_profiling",
      L"coreclr_enable_profiling",
      L"term",
      L"colorterm",
      L"term_program",
  };
  for (const wchar_t* item : blocked) {
    if (lower == item) return true;
  }
  return false;
}

std::vector<wchar_t> build_sanitized_env_block() {
  std::vector<std::wstring> entries;
  LPWCH raw = GetEnvironmentStringsW();
  if (raw) {
    const wchar_t* p = raw;
    while (*p != L'\0') {
      std::wstring entry(p);
      size_t step = entry.size() + 1;
      size_t eq = entry.find(L'=');
      if (eq != std::wstring::npos && eq > 0) {
        std::wstring key = entry.substr(0, eq);
        if (!should_strip_env_key_w(key)) {
          entries.push_back(std::move(entry));
        }
      }
      p += step;
    }
    FreeEnvironmentStringsW(raw);
  }
  for (const wchar_t* extra : {
           L"TERM=xterm-256color",
           L"COLORTERM=truecolor",
           L"TERM_PROGRAM=Pact",
       }) {
    entries.emplace_back(extra);
  }
  std::sort(entries.begin(), entries.end(), [](const std::wstring& a, const std::wstring& b) {
    size_t ka = a.find(L'=');
    size_t kb = b.find(L'=');
    size_t la = (ka == std::wstring::npos) ? a.size() : ka;
    size_t lb = (kb == std::wstring::npos) ? b.size() : kb;
    size_t common = (la < lb) ? la : lb;
    for (size_t i = 0; i < common; i++) {
      wint_t ca = towlower(a[i]);
      wint_t cb = towlower(b[i]);
      if (ca != cb) return ca < cb;
    }
    if (la != lb) return la < lb;
    return a < b;
  });
  std::vector<wchar_t> block;
  for (const std::wstring& line : entries) {
    block.insert(block.end(), line.begin(), line.end());
    block.push_back(L'\0');
  }
  block.push_back(L'\0');
  return block;
}

bool query_job_pids(HANDLE job, std::vector<DWORD>& out_pids, DWORD& out_total_assigned) {
  out_pids.clear();
  out_total_assigned = 1;
  DWORD capacity = 256;
  for (int attempt = 0; attempt < 5; attempt++) {
    DWORD buf_bytes =
        static_cast<DWORD>(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + (capacity - 1U) * sizeof(ULONG_PTR));
    std::vector<uint8_t> buf(buf_bytes, 0);
    BOOL ok = QueryInformationJobObject(job, JobObjectBasicProcessIdList, buf.data(), buf_bytes, nullptr);
    if (!ok) {
      if (GetLastError() == ERROR_MORE_DATA && capacity < 4096U) {
        capacity *= 2U;
        continue;
      }
      return false;
    }
    const auto* list = reinterpret_cast<const JOBOBJECT_BASIC_PROCESS_ID_LIST*>(buf.data());
    if (list->NumberOfAssignedProcesses > list->NumberOfProcessIdsInList && capacity < 4096U) {
      capacity = min(DWORD(4096), list->NumberOfAssignedProcesses + 32U);
      continue;
    }
    out_total_assigned = list->NumberOfAssignedProcesses;
    for (DWORD i = 0; i < list->NumberOfProcessIdsInList; i++) {
      DWORD pid = static_cast<DWORD>(list->ProcessIdList[i]);
      if (pid != 0) out_pids.push_back(pid);
    }
    return list->NumberOfAssignedProcesses == list->NumberOfProcessIdsInList;
  }
  return false;
}

struct ActivityInfo {
  bool has_active_child = false;
  int child_count = 0;
  std::string foreground_command;
};

ActivityInfo query_job_activity(HANDLE job, DWORD shell_pid, bool shell_exited) {
  ActivityInfo info;
  std::vector<DWORD> pids;
  DWORD assigned = 0;
  bool ok = query_job_pids(job, pids, assigned);
  if (!ok) {
    info.has_active_child = true;
    info.child_count = max(1, static_cast<int>(pids.size()));
    return info;
  }
  int active = 0;
  std::wstring last_image;
  for (DWORD pid : pids) {
    if (!shell_exited && pid == shell_pid) continue;
    active++;
    HANDLE hp = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (hp) {
      wchar_t img[MAX_PATH];
      DWORD img_len = MAX_PATH;
      if (QueryFullProcessImageNameW(hp, 0, img, &img_len)) {
        last_image.assign(img, img_len);
      }
      CloseHandle(hp);
    }
  }
  info.child_count = active;
  info.has_active_child = active > 0;
  if (!last_image.empty()) {
    info.foreground_command = basename_utf8(last_image);
  }
  return info;
}

int run_ctrl_c_helper(DWORD target_pid) {
  FreeConsole();
  bool attached = false;
  for (int i = 0; i < 15; i++) {
    if (AttachConsole(target_pid)) {
      attached = true;
      break;
    }
    Sleep(10);
  }
  if (!attached) return 1;
  SetConsoleCtrlHandler(nullptr, TRUE);
  BOOL ok = GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0);
  FreeConsole();
  return ok ? 0 : 1;
}

void send_ctrl_c_via_helper(DWORD target_pid) {
  wchar_t self_path[MAX_PATH];
  DWORD n = GetModuleFileNameW(nullptr, self_path, MAX_PATH);
  if (n == 0 || n >= MAX_PATH) return;
  std::wstring cmd = L"\"";
  cmd += self_path;
  cmd += L"\" --ctrl-c ";
  cmd += std::to_wstring(target_pid);

  STARTUPINFOW si{};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi{};
  std::vector<wchar_t> cmd_buf(cmd.begin(), cmd.end());
  cmd_buf.push_back(L'\0');
  BOOL started = CreateProcessW(
      self_path,
      cmd_buf.data(),
      nullptr,
      nullptr,
      FALSE,
      DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB,
      nullptr,
      nullptr,
      &si,
      &pi);
  if (!started && GetLastError() == ERROR_ACCESS_DENIED) {
    std::vector<wchar_t> cmd_buf_retry(cmd.begin(), cmd.end());
    cmd_buf_retry.push_back(L'\0');
    started = CreateProcessW(
        self_path,
        cmd_buf_retry.data(),
        nullptr,
        nullptr,
        FALSE,
        DETACHED_PROCESS,
        nullptr,
        nullptr,
        &si,
        &pi);
  }
  if (started) {
    WaitForSingleObject(pi.hProcess, 800);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
  }
}

void write_error_and_exit(const char* code, const std::string& msg) {
  write_json_frame(FRAME_ERROR, std::string("{\"code\":\"") + code + "\",\"message\":\"" + json_escape(msg) + "\"}");
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  (void)_setmode(_fileno(stdin), _O_BINARY);
  (void)_setmode(_fileno(stdout), _O_BINARY);

  bool check_load = false;
  bool ctrl_c_mode = false;
  DWORD ctrl_c_pid = 0;
  std::wstring cwd;
  SHORT cols = 80;
  SHORT rows = 24;

  for (int i = 1; i < argc; i++) {
    std::wstring arg = argv[i];
    if (arg == L"--check-load") {
      check_load = true;
    } else if (arg == L"--ctrl-c" && i + 1 < argc) {
      ctrl_c_mode = true;
      ctrl_c_pid = wcstoul(argv[++i], nullptr, 10);
    } else if (arg == L"--shell" && i + 1 < argc) {
      // Shell binary is resolved authoritatively from System32.
      i++;
    } else if (arg == L"--cwd" && i + 1 < argc) {
      cwd = argv[++i];
    } else if (arg == L"--cols" && i + 1 < argc) {
      long v = wcstol(argv[++i], nullptr, 10);
      if (v >= MIN_COLS && v <= MAX_COLS) cols = static_cast<SHORT>(v);
    } else if (arg == L"--rows" && i + 1 < argc) {
      long v = wcstol(argv[++i], nullptr, 10);
      if (v >= MIN_ROWS && v <= MAX_ROWS) rows = static_cast<SHORT>(v);
    }
  }

  if (ctrl_c_mode) {
    return run_ctrl_c_helper(ctrl_c_pid);
  }

  HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
  auto fnCreatePseudoConsole =
      k32 ? reinterpret_cast<decltype(&CreatePseudoConsole)>(GetProcAddress(k32, "CreatePseudoConsole")) : nullptr;
  auto fnResizePseudoConsole =
      k32 ? reinterpret_cast<decltype(&ResizePseudoConsole)>(GetProcAddress(k32, "ResizePseudoConsole")) : nullptr;
  auto fnClosePseudoConsole =
      k32 ? reinterpret_cast<decltype(&ClosePseudoConsole)>(GetProcAddress(k32, "ClosePseudoConsole")) : nullptr;

  if (check_load) {
    if (!fnCreatePseudoConsole || !fnResizePseudoConsole || !fnClosePseudoConsole) {
      fprintf(stderr, "ConPTY API is unavailable on this Windows build.\n");
      return 1;
    }
    const char* msg = "{\"ok\":true,\"protocolVersion\":1}\n";
    (void)_write(1, msg, static_cast<unsigned int>(strlen(msg)));
    return 0;
  }

  if (!fnCreatePseudoConsole || !fnResizePseudoConsole || !fnClosePseudoConsole) {
    write_error_and_exit("RUNTIME_UNAVAILABLE", "ConPTY API is unavailable on this Windows build.");
    return 1;
  }

  DWORD cwd_attrs = cwd.empty() ? INVALID_FILE_ATTRIBUTES : GetFileAttributesW(cwd.c_str());
  if (cwd_attrs == INVALID_FILE_ATTRIBUTES || (cwd_attrs & FILE_ATTRIBUTE_DIRECTORY) == 0) {
    write_error_and_exit("VALIDATION", "Working directory is not available.");
    return 1;
  }

  std::wstring shell_path = resolve_system_shell_path();
  DWORD shell_attrs = GetFileAttributesW(shell_path.c_str());
  if (shell_attrs == INVALID_FILE_ATTRIBUTES || (shell_attrs & FILE_ATTRIBUTE_DIRECTORY) != 0) {
    write_error_and_exit("VALIDATION", "System shell executable is not accessible.");
    return 1;
  }

  HANDLE hPipeInRead = nullptr;
  HANDLE hPipeInWrite = nullptr;
  HANDLE hPipeOutRead = nullptr;
  HANDLE hPipeOutWrite = nullptr;
  if (!CreatePipe(&hPipeInRead, &hPipeInWrite, nullptr, 0) ||
      !CreatePipe(&hPipeOutRead, &hPipeOutWrite, nullptr, 0)) {
    write_error_and_exit("INTERNAL", "Failed to create ConPTY pipes.");
    return 1;
  }

  COORD size = {cols, rows};
  HPCON hPC = nullptr;
  HRESULT hr = fnCreatePseudoConsole(size, hPipeInRead, hPipeOutWrite, 0, &hPC);
  CloseHandle(hPipeInRead);
  CloseHandle(hPipeOutWrite);
  if (FAILED(hr) || !hPC) {
    CloseHandle(hPipeInWrite);
    CloseHandle(hPipeOutRead);
    write_error_and_exit("INTERNAL", "CreatePseudoConsole failed.");
    return 1;
  }

  HANDLE hJob = CreateJobObjectW(nullptr, nullptr);
  if (!hJob) {
    fnClosePseudoConsole(hPC);
    CloseHandle(hPipeInWrite);
    CloseHandle(hPipeOutRead);
    write_error_and_exit("INTERNAL", "CreateJobObjectW failed.");
    return 1;
  }

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION job_limits{};
  job_limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, &job_limits, sizeof(job_limits))) {
    CloseHandle(hJob);
    fnClosePseudoConsole(hPC);
    CloseHandle(hPipeInWrite);
    CloseHandle(hPipeOutRead);
    write_error_and_exit("INTERNAL", "SetInformationJobObject failed.");
    return 1;
  }

  SIZE_T attr_size = 0;
  InitializeProcThreadAttributeList(nullptr, 2, 0, &attr_size);
  std::vector<uint8_t> attr_buf(attr_size, 0);
  auto* attr_list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attr_buf.data());
  if (!InitializeProcThreadAttributeList(attr_list, 2, 0, &attr_size) ||
      !UpdateProcThreadAttribute(attr_list, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hPC, sizeof(HPCON), nullptr, nullptr) ||
      !UpdateProcThreadAttribute(attr_list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &hJob, sizeof(HANDLE), nullptr, nullptr)) {
    DeleteProcThreadAttributeList(attr_list);
    CloseHandle(hJob);
    fnClosePseudoConsole(hPC);
    CloseHandle(hPipeInWrite);
    CloseHandle(hPipeOutRead);
    write_error_and_exit("INTERNAL", "Failed to prepare ConPTY process attributes.");
    return 1;
  }

  STARTUPINFOEXW si{};
  si.StartupInfo.cb = sizeof(si);
  si.lpAttributeList = attr_list;

  std::wstring cmdline = L"\"" + shell_path + L"\"";
  if (is_powershell_exe(shell_path)) {
    cmdline += L" -NoLogo";
  }
  std::vector<wchar_t> cmd_mut(cmdline.begin(), cmdline.end());
  cmd_mut.push_back(L'\0');
  std::vector<wchar_t> env_block = build_sanitized_env_block();

  PROCESS_INFORMATION pi{};
  BOOL created = CreateProcessW(
      shell_path.c_str(),
      cmd_mut.data(),
      nullptr,
      nullptr,
      FALSE,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
      env_block.data(),
      cwd.c_str(),
      &si.StartupInfo,
      &pi);
  DeleteProcThreadAttributeList(attr_list);

  if (!created) {
    CloseHandle(hJob);
    fnClosePseudoConsole(hPC);
    CloseHandle(hPipeInWrite);
    CloseHandle(hPipeOutRead);
    write_error_and_exit("RUNTIME_UNAVAILABLE", "Failed to spawn Windows shell inside ConPTY.");
    return 1;
  }

  CloseHandle(pi.hThread);
  HANDLE hProcess = pi.hProcess;
  DWORD shell_pid = pi.dwProcessId;
  HANDLE hWake = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  HANDLE hCloserDone = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HANDLE hDrainDone = CreateEventW(nullptr, TRUE, FALSE, nullptr);

  ULONGLONG started_ms = GetTickCount64();
  write_json_frame(
      FRAME_READY,
      "{\"protocolVersion\":1,\"pid\":" + std::to_string(shell_pid) +
          ",\"pgid\":" + std::to_string(shell_pid) +
          ",\"startedAtMs\":" + std::to_string(started_ms) +
          ",\"shell\":\"" + json_escape(utf16_to_utf8(shell_path)) + "\"}");

  std::atomic<bool> shutdown_requested{false};
  std::atomic<bool> shutdown_force{false};
  std::atomic<bool> ping_requested{false};
  std::atomic<uint32_t> shutdown_grace_ms{2000};
  std::atomic<bool> closer_started{false};
  std::atomic<uint32_t> input_frames{0};
  std::atomic<uint32_t> input_bytes{0};
  std::atomic<DWORD> last_input_err{0};

  std::thread drain_thread([hPipeOutRead, hDrainDone]() {
    uint8_t buf[32768];
    for (;;) {
      DWORD read_bytes = 0;
      BOOL ok = ReadFile(hPipeOutRead, buf, sizeof(buf), &read_bytes, nullptr);
      if (!ok || read_bytes == 0) break;
      write_frame(FRAME_OUTPUT, buf, static_cast<uint32_t>(read_bytes));
    }
    CloseHandle(hPipeOutRead);
    if (hDrainDone) SetEvent(hDrainDone);
  });

  std::mutex pipe_in_mutex;
  bool pipe_in_closed = false;
  std::thread closer_thread;
  auto ensure_closer_started = [&]() {
    if (!closer_started.exchange(true)) {
      {
        std::lock_guard<std::mutex> lock(pipe_in_mutex);
        if (!pipe_in_closed && hPipeInWrite) {
          CloseHandle(hPipeInWrite);
          hPipeInWrite = nullptr;
          pipe_in_closed = true;
        }
      }
      closer_thread = std::thread([fnClosePseudoConsole, hPC, hCloserDone]() {
        fnClosePseudoConsole(hPC);
        if (hCloserDone) SetEvent(hCloserDone);
      });
    }
  };

  std::thread stdin_thread([&]() {
    uint8_t header[5];
    while (read_exact_stdin(header, sizeof(header))) {
      uint8_t ftype = header[0];
      uint32_t flen = (static_cast<uint32_t>(header[1]) << 24) |
                      (static_cast<uint32_t>(header[2]) << 16) |
                      (static_cast<uint32_t>(header[3]) << 8) |
                      static_cast<uint32_t>(header[4]);
      if (flen > MAX_FRAME_BYTES) break;
      std::vector<uint8_t> payload(flen);
      if (flen > 0 && !read_exact_stdin(payload.data(), flen)) break;

      if (ftype == FRAME_INPUT && !closer_started.load() && flen > 0) {
        input_frames.fetch_add(1);
        std::lock_guard<std::mutex> lock(pipe_in_mutex);
        if (!pipe_in_closed && hPipeInWrite) {
          size_t off = 0;
          while (off < flen) {
            DWORD written = 0;
            BOOL ok = WriteFile(
                hPipeInWrite,
                payload.data() + off,
                static_cast<DWORD>(flen - off),
                &written,
                nullptr);
            if (!ok || written == 0) {
              last_input_err.store(ok ? ERROR_WRITE_FAULT : GetLastError());
              break;
            }
            off += written;
            input_bytes.fetch_add(written);
          }
        }
      } else if (ftype == FRAME_RESIZE && flen == 4 && !closer_started.load()) {
        SHORT nc = static_cast<SHORT>((static_cast<uint16_t>(payload[0]) << 8) | payload[1]);
        SHORT nr = static_cast<SHORT>((static_cast<uint16_t>(payload[2]) << 8) | payload[3]);
        if (nc >= MIN_COLS && nc <= MAX_COLS && nr >= MIN_ROWS && nr <= MAX_ROWS) {
          COORD next_size = {nc, nr};
          fnResizePseudoConsole(hPC, next_size);
        }
      } else if (ftype == FRAME_SHUTDOWN && flen >= 5) {
        uint32_t grace = (static_cast<uint32_t>(payload[1]) << 24) |
                         (static_cast<uint32_t>(payload[2]) << 16) |
                         (static_cast<uint32_t>(payload[3]) << 8) |
                         static_cast<uint32_t>(payload[4]);
        if (grace > 10000U) grace = 10000U;
        shutdown_grace_ms.store(grace);
        shutdown_force.store(payload[0] != 0);
        shutdown_requested.store(true);
        if (hWake) SetEvent(hWake);
      } else if (ftype == FRAME_PING_ACTIVITY) {
        ping_requested.store(true);
        if (hWake) SetEvent(hWake);
      }
    }
    if (!shutdown_requested.load()) {
      shutdown_grace_ms.store(2000);
      shutdown_requested.store(true);
      if (hWake) SetEvent(hWake);
    }
  });
  stdin_thread.detach();

  ActivityInfo last_activity;
  bool shell_exited = false;
  bool shell_exited_emitted = false;
  DWORD exit_code = 0;
  bool cooperative_sent = false;
  bool force_killed = false;
  ULONGLONG shutdown_deadline = 0;

  HANDLE wait_handles[2] = {hProcess, hWake};
  for (;;) {
    DWORD wait_res = WaitForMultipleObjects(shell_exited ? 1 : 2, shell_exited ? &hWake : wait_handles, FALSE, 250);
    if (!shell_exited && (wait_res == WAIT_OBJECT_0 || WaitForSingleObject(hProcess, 0) == WAIT_OBJECT_0)) {
      shell_exited = true;
      GetExitCodeProcess(hProcess, &exit_code);
      if (!shell_exited_emitted) {
        shell_exited_emitted = true;
        write_json_frame(FRAME_SHELL_EXITED, "{\"exitCode\":" + std::to_string(exit_code) + ",\"signal\":null}");
      }
    }

    std::vector<DWORD> pids;
    DWORD remaining = 0;
    bool job_ok = query_job_pids(hJob, pids, remaining);

    if (shutdown_requested.load()) {
      if (shutdown_deadline == 0) {
        if (shutdown_force.load() || shutdown_grace_ms.load() == 0) {
          force_killed = true;
          TerminateJobObject(hJob, 1);
          ensure_closer_started();
          shutdown_deadline = GetTickCount64() + 1000;
        } else {
          if (!cooperative_sent) {
            cooperative_sent = true;
            DWORD target_pid = !shell_exited ? shell_pid : (pids.empty() ? shell_pid : pids.back());
            std::thread([target_pid]() {
              send_ctrl_c_via_helper(target_pid);
            }).detach();
          }
          shutdown_deadline = GetTickCount64() + shutdown_grace_ms.load();
        }
      } else if (!force_killed && GetTickCount64() >= shutdown_deadline) {
        force_killed = true;
        TerminateJobObject(hJob, 1);
        ensure_closer_started();
        shutdown_deadline = GetTickCount64() + 1000;
      }
    }

    if (ping_requested.load() || !shell_exited || (job_ok && remaining > 0)) {
      ping_requested.store(false);
      ActivityInfo cur = query_job_activity(hJob, shell_pid, shell_exited);
      if (cur.has_active_child != last_activity.has_active_child ||
          cur.child_count != last_activity.child_count ||
          cur.foreground_command != last_activity.foreground_command) {
        last_activity = cur;
        std::string fg = cur.foreground_command.empty() ? "null" : ("\"" + json_escape(cur.foreground_command) + "\"");
        write_json_frame(
            FRAME_ACTIVITY,
            "{\"hasActiveChild\":" + std::string(cur.has_active_child ? "true" : "false") +
                ",\"childCount\":" + std::to_string(cur.child_count) +
                ",\"foregroundCommand\":" + fg + "}");
      }
    }

    if (shell_exited && job_ok && remaining == 0) {
      break;
    }
    if (shutdown_requested.load() && force_killed && GetTickCount64() >= shutdown_deadline) {
      break;
    }
  }

  ensure_closer_started();
  bool closer_done = !hCloserDone || (WaitForSingleObject(hCloserDone, 1500) == WAIT_OBJECT_0);
  bool drain_done = !hDrainDone || (WaitForSingleObject(hDrainDone, 1500) == WAIT_OBJECT_0);
  if (!shell_exited && WaitForSingleObject(hProcess, 500) == WAIT_OBJECT_0) {
    shell_exited = true;
    GetExitCodeProcess(hProcess, &exit_code);
  }
  std::vector<DWORD> final_pids;
  DWORD final_remaining = 0;
  bool final_job_ok = query_job_pids(hJob, final_pids, final_remaining);
  bool cleanup_confirmed = final_job_ok && (final_remaining == 0) && shell_exited && closer_done && drain_done;

  write_json_frame(
      FRAME_EXIT,
      "{\"exitCode\":" + (shell_exited ? std::to_string(exit_code) : std::string("null")) +
          ",\"signal\":null,\"cleanupConfirmed\":" + std::string(cleanup_confirmed ? "true" : "false") +
          ",\"remainingPids\":" + std::to_string(final_remaining) +
          ",\"shellExited\":" + std::string(shell_exited ? "true" : "false") +
          ",\"jobOk\":" + std::string(final_job_ok ? "true" : "false") +
          ",\"closerDone\":" + std::string(closer_done ? "true" : "false") +
          ",\"drainDone\":" + std::string(drain_done ? "true" : "false") +
          ",\"inputFrames\":" + std::to_string(input_frames.load()) +
          ",\"inputBytes\":" + std::to_string(input_bytes.load()) +
          ",\"inputErr\":" + std::to_string(last_input_err.load()) + "}");

  if (closer_done && closer_thread.joinable()) closer_thread.join();
  else if (closer_thread.joinable()) closer_thread.detach();
  if (drain_done && drain_thread.joinable()) drain_thread.join();
  else if (drain_thread.joinable()) drain_thread.detach();

  CloseHandle(hProcess);
  CloseHandle(hJob);
  if (hWake) CloseHandle(hWake);
  if (hCloserDone) CloseHandle(hCloserDone);
  if (hDrainDone) CloseHandle(hDrainDone);
  ExitProcess(0);
}
